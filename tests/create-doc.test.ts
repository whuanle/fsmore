import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

// WORKSPACE_DIR / DATA_DIR 在模块加载时解析：先指到临时目录，再动态导入被测模块
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsmore-create-"));
process.env.FSMORE_DATA_DIR = tmpDir;

type Engine = import("../src/workspace/sync.js").SyncEngine;
type Store = import("../src/workspace/store.js").WorkspaceStore;
type Client = import("../src/feishu/client.js").FeishuOpenApiClient;

let engineMod: typeof import("../src/workspace/sync.js");
let storeMod: typeof import("../src/workspace/store.js");

function textRun(content: string) {
  return { text_run: { content, text_element_style: {} } };
}

/** 假飞书客户端：wiki 解析 / docx 创建与 meta / blocks / wiki 节点创建 / wiki 子节点列表 */
function fakeClient() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const docMeta = (documentId: string, title: string, revisionId: number) => ({
    document: { document_id: documentId, title, revision_id: revisionId },
  });
  const docBlocks = (documentId: string) => ({
    items: [
      { block_id: documentId, block_type: 1, children: ["b1"] },
      { block_id: "b1", block_type: 2, parent_id: documentId, text: { elements: [textRun("正文")] } },
    ],
    has_more: false,
  });

  const client = {
    async getJson(url: string) {
      calls.push({ url, method: "GET" });
      if (url.includes("/wiki/v2/spaces/get_node")) {
        if (url.includes("token=wikP1")) {
          return { node: { node_token: "wikP1", obj_token: "OLDP1", obj_type: "docx", space_id: "sp1", title: "父节点" } };
        }
        throw new Error("飞书 API 错误 230027：not found");
      }
      if (url.includes("/wiki/v2/spaces/sp1/nodes") && url.includes("parent_node_token=wikP1")) {
        return { items: [{ node_token: "wikC1", obj_token: "DOCC1", obj_type: "docx", title: "子文档", has_child: false }], has_more: false };
      }
      if (/\/docx\/v1\/documents\/[^/]+\/blocks/.test(url)) {
        const docId = /\/documents\/([^/?]+)\/blocks/.exec(url)?.[1] ?? "";
        return docBlocks(docId);
      }
      if (/\/docx\/v1\/documents\/(NEWDOC1|NEWDOC2)/.test(url)) {
        return url.includes("NEWDOC1")
          ? docMeta("NEWDOC1", "我的新文档", 3)
          : docMeta("NEWDOC2", "Wiki 新文档", 7);
      }
      return {};
    },
    async postJson(url: string, _token: string, body: unknown) {
      calls.push({ url, method: "POST", body });
      if (url.includes("/docx/v1/documents") && !/\/documents\/[^/]+/.test(url.replace("/docx/v1/documents", ""))) {
        return { document: { document_id: "NEWDOC1", revision_id: 1 } };
      }
      if (url.includes("/wiki/v2/spaces/sp1/nodes")) {
        return { node: { node_token: "wikNew1", obj_token: "NEWDOC2", obj_type: "docx", title: "Wiki 新文档" } };
      }
      return {};
    },
    async patchJson(url: string, _token: string, body: unknown) {
      calls.push({ url, method: "PATCH", body });
      return {};
    },
  };
  return { client: client as unknown as Client, calls };
}

function makeEngine(store: Store, client: Client, scope: string): Engine {
  const tokens = {
    getToken: async () => "fake-token",
    withToken: (fn: (t: string) => unknown) => fn("fake-token"),
  };
  return new engineMod.SyncEngine(
    () => ({ syncConcurrency: 2, userToken: { scope } }) as never,
    client,
    tokens as never,
    store,
    {} as never,
  );
}

before(async () => {
  engineMod = await import("../src/workspace/sync.js");
  storeMod = await import("../src/workspace/store.js");
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("create_doc：不传父位置 → 建在「我的空间」，挂「新建文档」虚拟根并同步出 md", async () => {
  const store = new storeMod.WorkspaceStore(path.join(tmpDir, "index-a.json"));
  const { client, calls } = fakeClient();
  const engine = makeEngine(store, client, "docx:document wiki:wiki");

  const result = await engine.createDoc({ title: "我的新文档" });

  assert.equal(result.token, "NEWDOC1");
  assert.equal(result.mdPath, ".maomi/feishu-docs/NEWDOC1.md");
  assert.equal(result.rootId, engineMod.CREATED_DOCS_ROOT_ID);
  assert.match(result.url ?? "", /docx\/NEWDOC1/);

  const node = store.getNode("NEWDOC1");
  assert.ok(node);
  assert.equal(node.kind, "doc");
  assert.equal(node.rootId, engineMod.CREATED_DOCS_ROOT_ID);
  assert.equal(node.parentToken, engineMod.CREATED_DOCS_ROOT_ID);

  // 创建接口不带标题：创建后应 PATCH 标题
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "应 PATCH 文档标题");
  assert.deepEqual(patch!.body, { title: "我的新文档" });

  const md = fs.readFileSync(path.join(tmpDir, "workspace", ...result.mdPath.split("/")), "utf8");
  assert.match(md, /feishu_doc_id: "?NEWDOC1"?/);
});

test("create_doc：父为已添加的 wiki 节点 → 在知识库创建并挂到该节点下", async () => {
  const store = new storeMod.WorkspaceStore(path.join(tmpDir, "index-b.json"));
  store.addRoot({ id: "r1", kind: "wiki_space", token: "sp1", spaceId: "sp1", title: "知识库", addedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "sp1", kind: "space", rootId: "r1", parentToken: null, title: "知识库" });
  store.upsertNode({ token: "wikP1", kind: "wiki", rootId: "r1", parentToken: "sp1", title: "父节点" });

  const { client, calls } = fakeClient();
  const engine = makeEngine(store, client, "docx:document wiki:wiki");

  const result = await engine.createDoc({ title: "Wiki 新文档", parentToken: "wikP1" });

  assert.equal(result.token, "wikNew1");
  assert.equal(result.rootId, "r1");
  const node = store.getNode("wikNew1");
  assert.ok(node);
  assert.equal(node.docId, "NEWDOC2");
  assert.equal(node.parentToken, "wikP1");
  assert.match(node.remoteUrl ?? "", /wiki\/wikNew1/);

  const create = calls.find((call) => call.method === "POST" && call.url.includes("/wiki/v2/spaces/sp1/nodes"));
  assert.ok(create);
  assert.deepEqual(create!.body, { obj_type: "docx", title: "Wiki 新文档", parent_node_token: "wikP1" });
});

test("create_doc：父为云空间文件夹 → 带 folder_token 创建并挂该文件夹下", async () => {
  const store = new storeMod.WorkspaceStore(path.join(tmpDir, "index-c.json"));
  store.addRoot({ id: "r2", kind: "folder", token: "fldF1", title: "云空间文件夹", addedAt: "2026-10-08T00:00:00Z" });
  store.upsertNode({ token: "fldF1", kind: "folder", rootId: "r2", parentToken: null, title: "云空间文件夹" });

  const { client, calls } = fakeClient();
  const engine = makeEngine(store, client, "docx:document wiki:wiki");

  const result = await engine.createDoc({ title: "我的新文档", parentToken: "fldF1" });

  const create = calls.find((call) => call.method === "POST" && call.url.includes("/docx/v1/documents"));
  assert.ok(create);
  assert.match(create!.url, /folder_token=fldF1/);

  assert.equal(result.rootId, "r2");
  const node = store.getNode("NEWDOC1");
  assert.ok(node);
  assert.equal(node.parentToken, "fldF1");
});

test("create_doc：缺 wiki:wiki scope 时明确拦截", async () => {
  const store = new storeMod.WorkspaceStore(path.join(tmpDir, "index-d.json"));
  const { client } = fakeClient();
  const engine = makeEngine(store, client, "docx:document wiki:wiki:readonly");
  await assert.rejects(
    engine.createDoc({ title: "x", parentToken: "wikP1" }),
    /wiki:wiki.*权限|权限.*wiki:wiki/,
  );
});

test("searchOnlineDocs：sort=edited 映射 doc_filter.sort_type", async () => {
  const { searchOnlineDocs } = await import("../src/feishu/search.js");
  const { client, calls } = fakeClient();
  await searchOnlineDocs(client, "t", { query: "设计", sort: "edited" });
  const call = calls.find((item) => item.url.includes("/search/v2/doc_wiki/search"));
  assert.ok(call);
  assert.deepEqual((call!.body as Record<string, unknown>).doc_filter, { sort_type: "EDIT_TIME" });

  calls.length = 0;
  await searchOnlineDocs(client, "t", { query: "设计", sort: "relevance" });
  const call2 = calls.find((item) => item.url.includes("/search/v2/doc_wiki/search"));
  assert.deepEqual((call2!.body as Record<string, unknown>).doc_filter, {});
});

test("add_root：识别 wiki 节点并列为文档源、列出目录树", async () => {
  const store = new storeMod.WorkspaceStore(path.join(tmpDir, "index-e.json"));
  const { client } = fakeClient();
  const engine = makeEngine(store, client, "docx:document wiki:wiki");

  const { rootId, root } = await engine.addRoot("wikP1");
  assert.ok(root);
  assert.equal(root.kind, "wiki_node");
  const listed = await engine.ensureTreeListed({
    rootId,
    startToken: root.token,
    kind: root.kind,
    spaceId: root.spaceId,
  });
  assert.ok(listed >= 1);
  assert.ok(store.getNode("wikC1"), "子文档应进入索引");
});
