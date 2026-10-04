import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

import { searchDocTitles } from "../src/workspace/search.js";
import { WorkspaceStore, type NodeEntry } from "../src/workspace/store.js";

// 临时索引文件构造一棵小树：
// root(知识库)
//   ├─ folderA/
//  │    ├─ 会议记录（已同步）
//  │    └─ 会议纪要备份（未同步）
//   └─ 周报
let tmpDir: string;
let store: WorkspaceStore;

function node(partial: Partial<NodeEntry> & { token: string; title: string }): NodeEntry {
  return {
    kind: "doc",
    rootId: "r1",
    parentToken: "root1",
    docId: `${partial.token}doc`,
    ...partial,
  } as NodeEntry;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsmore-search-"));
  store = new WorkspaceStore(path.join(tmpDir, "index.json"));
  store.addRoot({ id: "r1", kind: "wiki_space", token: "root1", title: "知识库", addedAt: "2026-10-04T00:00:00Z" });
  store.upsertNode({ token: "root1", kind: "space", rootId: "r1", parentToken: null, title: "知识库" });
  store.upsertNode({ token: "fldA", kind: "folder", rootId: "r1", parentToken: "root1", title: "folderA" });
  store.upsertNode(node({ token: "t1", title: "会议记录", parentToken: "fldA", mdPath: "a/t1.md" }));
  store.upsertNode(node({ token: "t2", title: "会议纪要备份", parentToken: "fldA" }));
  store.upsertNode(node({ token: "t3", title: "周报", parentToken: "root1" }));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("按标题模糊匹配，含未同步文档", () => {
  const hits = searchDocTitles(store, "会议");
  assert.deepEqual(hits.map((hit) => hit.token), ["t1", "t2"]);
  assert.equal(hits[0]!.synced, true);
  assert.equal(hits[1]!.synced, false);
});

test("标题前缀匹配排在前面", () => {
  store.upsertNode(node({ token: "t4", title: "记录xxx", parentToken: "root1" }));
  const hits = searchDocTitles(store, "记录");
  assert.deepEqual(hits.map((hit) => hit.token), ["t4", "t1"]);
});

test("大小写不敏感", () => {
  store.upsertNode(node({ token: "t5", title: "API 设计文档", parentToken: "root1" }));
  const hits = searchDocTitles(store, "api");
  assert.deepEqual(hits.map((hit) => hit.token), ["t5"]);
});

test("返回 token 链与标题链（根→…→文档）", () => {
  const hits = searchDocTitles(store, "会议记录");
  assert.deepEqual(hits[0]!.chain, ["root1", "fldA", "t1"]);
  assert.deepEqual(hits[0]!.path, ["知识库", "folderA", "会议记录"]);
});

test("非文档节点（文件夹/根）不参与搜索", () => {
  assert.deepEqual(searchDocTitles(store, "folder"), []);
  assert.deepEqual(searchDocTitles(store, "知识库"), []);
});

test("空查询与无匹配返回空数组", () => {
  assert.deepEqual(searchDocTitles(store, "  "), []);
  assert.deepEqual(searchDocTitles(store, "不存在"), []);
});

test("limit 截断", () => {
  assert.equal(searchDocTitles(store, "会议", 1).length, 1);
});
