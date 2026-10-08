import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

import { SyncEngine, TREE_VIEW_NODE_LIMIT } from "../src/workspace/sync.js";
import { resolveDocLocations } from "../src/workspace/search.js";
import { WorkspaceStore, type NodeEntry } from "../src/workspace/store.js";
import type { FeishuOpenApiClient } from "../src/feishu/client.js";

// 索引结构：
// r1 知识库(wiki_space, root1 已列出)
//   ├─ folderA（已列出）
//   │    ├─ 会议记录（已同步）
//   │    └─ 会议纪要备份（未同步，docId=DOCT2）
//   └─ 周报
// r2 云空间文件夹(fldRoot，未列出 → get_tree 时向远端拉一层)
let tmpDir: string;
let store: WorkspaceStore;
let engine: SyncEngine;
let remoteCalls: string[];

function node(partial: Partial<NodeEntry> & { token: string; title: string }): NodeEntry {
  return {
    kind: "doc",
    rootId: "r1",
    parentToken: "root1",
    docId: `${partial.token}doc`,
    ...partial,
  } as NodeEntry;
}

/** 假客户端：只响应 fldRoot 的云空间文件列表（其它文件夹返回空，避免自嵌套） */
function fakeClient(): FeishuOpenApiClient {
  return {
    async getJson(url: string) {
      remoteCalls.push(url);
      if (url.includes("/drive/v1/files")) {
        if (url.includes("folder_token=fldRoot")) {
          return {
            files: [
              { token: "fldB", name: "子文件夹", type: "folder" },
              { token: "DOCE1", name: "云端文档", type: "docx" },
            ],
            has_more: false,
          };
        }
        return { files: [], has_more: false };
      }
      return {};
    },
  } as unknown as FeishuOpenApiClient;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsmore-tree-"));
  store = new WorkspaceStore(path.join(tmpDir, "index.json"));
  store.addRoot({ id: "r1", kind: "wiki_space", token: "root1", title: "知识库", addedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "root1", kind: "space", rootId: "r1", parentToken: null, title: "知识库", childrenListedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "fldA", kind: "folder", rootId: "r1", parentToken: "root1", title: "folderA", childrenListedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode(node({ token: "t1", title: "会议记录", parentToken: "fldA", mdPath: ".maomi/feishu-docs/t1.md" }));
  store.upsertNode(node({ token: "t2", title: "会议纪要备份", parentToken: "fldA", docId: "DOCT2" }));
  store.upsertNode(node({ token: "t3", title: "周报", parentToken: "root1" }));
  store.addRoot({ id: "r2", kind: "folder", token: "fldRoot", title: "云空间文件夹", addedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "fldRoot", kind: "folder", rootId: "r2", parentToken: null, title: "云空间文件夹" });

  remoteCalls = [];
  engine = new SyncEngine(
    () => ({ syncConcurrency: 2 }) as never,
    fakeClient(),
    { withToken: (fn: (t: string) => unknown) => fn("fake-token") } as never,
    store,
    {} as never,
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- get_tree ----------

test("get_tree：默认返回全部文档源，depth=3，含同步状态", async () => {
  const { truncated, nodes } = await engine.getTree();
  assert.equal(truncated, false);
  assert.deepEqual(nodes.map((item) => item.token), ["root1", "fldRoot"]);

  const root1 = nodes[0]!;
  assert.equal(root1.title, "知识库");
  assert.equal(root1.children_listed, true);
  // 子节点排序与 Web API /api/tree 同比较器（localeCompare zh）
  assert.deepEqual(root1.children!.map((item) => item.title), ["周报", "folderA"]);

  const folderA = root1.children!.find((item) => item.token === "fldA")!;
  const t1 = folderA.children!.find((item) => item.token === "t1")!;
  const t2 = folderA.children!.find((item) => item.token === "t2")!;
  assert.equal(t1.synced, true);
  assert.equal(t1.md_path, ".maomi/feishu-docs/t1.md");
  assert.equal(t2.synced, false);
  assert.equal(t2.md_path, undefined);
});

test("get_tree：depth=1 只返回起始层", async () => {
  const { nodes } = await engine.getTree({ spaceId: "r1", depth: 1 });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.token, "root1");
  assert.equal(nodes[0]!.children, undefined);
});

test("get_tree：传 token 从指定位置展开子树", async () => {
  const { nodes } = await engine.getTree({ token: "fldA" });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.token, "fldA");
  assert.deepEqual(nodes[0]!.children!.map((item) => item.token), ["t1", "t2"]);
});

test("get_tree：doc_id 也能定位起始节点", async () => {
  const { nodes } = await engine.getTree({ token: "DOCT2" });
  assert.equal(nodes[0]!.token, "t2");
});

test("get_tree：未列出的节点自动向远端拉一层，且缓存复用", async () => {
  const first = await engine.getTree({ spaceId: "r2" });
  const fldRoot = first.nodes[0]!;
  assert.equal(fldRoot.children_listed, true);
  assert.deepEqual(fldRoot.children!.map((item) => item.title), ["云端文档", "子文件夹"]);
  // 此前「全部文档源」那次 get_tree 已列出 fldRoot 与其子文件夹 fldB，两次列出 = 2 次远端请求
  const driveCalls = () => remoteCalls.filter((url) => url.includes("/drive/v1/files")).length;
  assert.equal(driveCalls(), 2, "再取走缓存，不再请求远端");

  const again = await engine.getTree({ spaceId: "r2" });
  assert.equal(again.nodes[0]!.children!.length, 2);
  assert.equal(driveCalls(), 2);

  // list_remote=false：只用本地索引
  store.addRoot({ id: "r3", kind: "folder", token: "fldX", title: "未列出文件夹", addedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "fldX", kind: "folder", rootId: "r3", parentToken: null, title: "未列出文件夹" });
  const offline = await engine.getTree({ spaceId: "r3", listRemote: false });
  assert.equal(offline.nodes[0]!.children, undefined);
  assert.equal(offline.nodes[0]!.children_listed, false);
  assert.equal(driveCalls(), 2, "list_remote=false 不发请求");
});

test("get_tree：节点数超上限时截断", async () => {
  store.addRoot({ id: "r4", kind: "wiki_space", token: "root4", title: "大空间", addedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "root4", kind: "space", rootId: "r4", parentToken: null, title: "大空间", childrenListedAt: "2026-10-08T00:00:00Z" });
  for (let i = 0; i < TREE_VIEW_NODE_LIMIT + 50; i += 1) {
    store.upsertNode(node({ token: `big${i}`, title: `文档${String(i).padStart(4, "0")}`, parentToken: "root4", rootId: "r4" }));
  }
  const result = await engine.getTree({ spaceId: "r4" });
  assert.equal(result.truncated, true);

  const countTree = (item: { children?: unknown[] }): number =>
    1 + (item.children ?? []).reduce((sum: number, child) => sum + countTree(child as { children?: unknown[] }), 0);
  assert.equal(countTree(result.nodes[0]!), TREE_VIEW_NODE_LIMIT);
});

test("get_tree：token 不存在时报可读错误", async () => {
  await assert.rejects(engine.getTree({ token: "nope" }), /索引中不存在节点/);
  await assert.rejects(engine.getTree({ spaceId: "nope" }), /文档源不存在/);
});

// ---------- resolve_docs ----------

test("resolve_docs：token 精确反查 + doc_id 兜底 + 未命中提示", () => {
  const results = resolveDocLocations(store, { tokens: ["t1", "DOCT2", "missing1"] });
  assert.equal(results.length, 3);

  assert.equal(results[0]!.found, true);
  assert.equal(results[0]!.match!.md_path, ".maomi/feishu-docs/t1.md");

  assert.equal(results[1]!.found, true);
  assert.equal(results[1]!.match!.token, "t2");
  assert.match(results[1]!.note ?? "", /未同步/);

  assert.equal(results[2]!.found, false);
  assert.match(results[2]!.note ?? "", /search_online/);
});

test("resolve_docs：标题精确优先，多候选给出列表", () => {
  store.upsertNode(node({ token: "t9", title: "会议记录（归档）", parentToken: "root1" }));
  const exact = resolveDocLocations(store, { titles: ["会议记录"] });
  assert.equal(exact[0]!.found, true);
  assert.equal(exact[0]!.matches!.length, 1);
  assert.equal(exact[0]!.matches![0]!.token, "t1");

  const partial = resolveDocLocations(store, { titles: ["会议"] });
  assert.ok(partial[0]!.matches!.length >= 2);
  assert.match(partial[0]!.note ?? "", /多个候选/);

  const none = resolveDocLocations(store, { titles: ["不存在的文档"] });
  assert.equal(none[0]!.found, false);
  assert.match(none[0]!.note ?? "", /search_online/);
});
