import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containsFeishuNativeMarkdownTag,
  containsMarkdownImage,
  pushDocumentWithStrategies,
  transformForDocsAi,
  type PushDocContext,
} from "../src/feishu/writer.js";
import { nativeTablesToMarkdown } from "../src/feishu/native-tables.js";
import type { FeishuOpenApiClient } from "../src/feishu/client.js";

/** 记录调用的假客户端 */
function fakeClient(overrides: { docsAiResult?: string; docsAiWarnings?: string[] } = {}) {
  const calls: Array<{ api: string; url: string; body?: any }> = [];
  const client = {
    async postJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: url.includes("/blocks/convert") ? "convert" : url.includes("/descendant") ? "descendant" : "post", url, body });
      if (url.includes("/blocks/convert")) {
        return {
          first_level_block_ids: ["nb1"],
          blocks: [{ block_id: "nb1", block_type: 2, text: { elements: [{ text_run: { content: "内容" } }] } }],
        };
      }
      if (url.includes("/descendant")) {
        return { document_revision_id: 43 };
      }
      return {};
    },
    async putJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: "docs_ai_overwrite", url, body });
      return {
        document: { revision_id: 44 },
        result: overrides.docsAiResult ?? "success",
        warnings: overrides.docsAiWarnings ?? [],
        new_blocks: [],
      };
    },
    async patchJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: "patch_title", url, body });
      return {};
    },
    async getJson(url: string) {
      calls.push({ api: "children_count", url });
      return { items: [{ block_id: "c1" }], has_more: false };
    },
    async deleteJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: "batch_delete", url, body });
      return { document_revision_id: 42 };
    },
  };
  return { client: client as unknown as FeishuOpenApiClient, calls };
}

function makeContext(overrides: Partial<PushDocContext> = {}): PushDocContext {
  return {
    docId: "DOC123",
    title: "文档标题",
    draftMarkdown: "纯文本内容",
    baselineMarkdown: "",
    baseIr: null,
    revisionId: "42",
    ...overrides,
  };
}

test("策略判定：原生标签/图片识别", () => {
  assert.ok(containsFeishuNativeMarkdownTag('<image token="x" />'));
  assert.ok(containsMarkdownImage("![截图](local/path.png)"));
  assert.ok(!containsMarkdownImage("[链接](https://example.com)"));
});

test("纯文本走 markdown_convert：convert → batch_delete → descendant（带版本锁）", async () => {
  const { client, calls } = fakeClient();
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext());

  assert.equal(outcome.status, "succeeded");
  assert.ok(outcome.status === "succeeded" && outcome.strategy === "markdown_convert");
  assert.ok(outcome.status === "succeeded" && outcome.revisionId === "43");
  assert.deepEqual(calls.map((c) => c.api), ["convert", "children_count", "batch_delete", "descendant"]);
  const deleteCall = calls.find((c) => c.api === "batch_delete");
  assert.ok(deleteCall && String(deleteCall.url).includes("document_revision_id=42"));
});

test("含 markdown 图片 → 阻断", async () => {
  const { client } = fakeClient();
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({
    draftMarkdown: "# 标题\n\n![截图](a.png)",
  }));
  assert.equal(outcome.status, "blocked");
  assert.ok(outcome.status === "blocked" && outcome.message.includes("图片"));
});

test("原生表格 → 转成 markdown 表格后走 docs_ai 覆写", async () => {
  const { client, calls } = fakeClient();
  const draft = [
    "# 标题",
    "",
    '<table blockId="tbl1" cells="c1,c2,c3,c4" column-size="2" row-size="2" header-row="true">',
    '<table-cell blockId="c1">A1</table-cell>',
    '<table-cell blockId="c2">B1</table-cell>',
    '<table-cell blockId="c3">A2</table-cell>',
    '<table-cell blockId="c4">B2</table-cell>',
    "</table>",
  ].join("\n");
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({ draftMarkdown: draft, baselineMarkdown: draft }));

  assert.equal(outcome.status, "succeeded");
  assert.ok(outcome.status === "succeeded" && outcome.strategy === "docs_ai_markdown_overwrite");
  const overwrite = calls.find((c) => c.api === "docs_ai_overwrite");
  const content = String(overwrite?.body?.content ?? "");
  assert.ok(content.includes("| A1 | B1 |"), content);
  assert.ok(content.includes("| --- | --- |"), content);
  assert.ok(!content.includes("<table"), content);
  // 推送后恢复标题
  assert.ok(calls.some((c) => c.api === "patch_title"));
});

test("画板块 → 阻断推送（宁拒推不毁数据）", async () => {
  const { client } = fakeClient();
  const draft = '前文\n\n<board token="wb001" blockId="b1" align="1" />';
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({ draftMarkdown: draft, baselineMarkdown: draft }));
  assert.equal(outcome.status, "blocked");
  assert.ok(outcome.status === "blocked" && outcome.message.includes("画板"));
});

test("图片/附件/电子表格/多维表格原生块 → 阻断", async () => {
  const { client } = fakeClient();
  for (const tag of ['<image token="i" />', '<file token="f" />', '<sheet token="s" />', '<bitable token="bt" />', '<mindnote token="m" />']) {
    const outcome = await pushDocumentWithStrategies(client, "token", makeContext({ draftMarkdown: `文\n\n${tag}`, baselineMarkdown: `文\n\n${tag}` }));
    assert.equal(outcome.status, "blocked", tag);
  }
});

test("容器类标签解包保留内容 + divider 转 ---", () => {
  const result = transformForDocsAi('<callout>\n提示内容\n</callout>\n\n<divider blockId="d1" />\n\n<grid blockId="g1"><grid-column blockId="gc1">分栏文字</grid-column></grid>');
  assert.ok(result.ok);
  assert.ok(result.markdown.includes("提示内容"), result.markdown);
  assert.ok(result.markdown.includes("---"), result.markdown);
  assert.ok(result.markdown.includes("分栏文字"), result.markdown);
  assert.ok(!result.markdown.includes("<callout"), result.markdown);
});

test("docs_ai partial_success / degrade 警告 → 视为失败阻断", async () => {
  const { client } = fakeClient({ docsAiResult: "partial_success", docsAiWarnings: ["degrade_code=4010,msg=Unsupported tag <table-cell> was removed"] });
  const draft = '<table blockId="t" column-size="1"><table-cell>x</table-cell></table>';
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({ draftMarkdown: draft, baselineMarkdown: draft }));
  assert.equal(outcome.status, "blocked");
});

test("nativeTablesToMarkdown：无表头行时补分隔行；单元格内竖线转义", () => {
  const md = nativeTablesToMarkdown('<table blockId="t" cells="a,b" column-size="2" row-size="1"><table-cell>左|右</table-cell><table-cell>值</table-cell></table>');
  assert.ok(md.includes("| 左\\|右 | 值 |"), md);
  assert.ok(md.includes("| --- | --- |"), md);
});

// ---------- 文本补丁路径（MaomiAgent patch-executor 同款语义） ----------

function nativeDocBaseIr(): import("../src/feishu/ir.js").FeishuDocIR {
  return {
    schemaVersion: 1,
    integrity: { contentHash: "", rawHash: "" },
    document: {
      id: "DOC123",
      title: "t",
      revisionId: "42",
      rootBlockId: "DOC123",
      pulledAt: "2026-01-01T00:00:00.000Z",
      source: { documentIdType: "document_id" as const },
    },
    blocks: {
      DOC123: { id: "DOC123", type: "page", parentId: null, children: ["h1", "p1", "tbl1", "p2"], editable: false, text: [], resource: null, attrs: {}, raw: {} },
      h1: { id: "h1", type: "heading1", parentId: "DOC123", children: [], editable: true, text: [{ kind: "text", text: "旧标题", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {} },
      p1: { id: "p1", type: "text", parentId: "DOC123", children: [], editable: true, text: [{ kind: "text", text: "第一段", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {} },
      tbl1: { id: "tbl1", type: "table", parentId: "DOC123", children: ["c1", "c2"], editable: false, text: [], resource: null, attrs: {}, raw: {} },
      c1: { id: "c1", type: "table-cell", parentId: "tbl1", children: [], editable: true, text: [{ kind: "text", text: "单元格A", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {} },
      c2: { id: "c2", type: "table-cell", parentId: "tbl1", children: [], editable: true, text: [{ kind: "text", text: "单元格B", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {} },
      p2: { id: "p2", type: "text", parentId: "DOC123", children: [], editable: true, text: [{ kind: "text", text: "结尾段", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {} },
    },
    assets: {},
  };
}

function fakePatchClient() {
  const calls: Array<{ api: string; url: string; body?: any }> = [];
  const client = {
    async patchJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: "patch_text", url, body });
      return {};
    },
    async putJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: "docs_ai_overwrite", url, body });
      return { document: { revision_id: 44 }, result: "success", warnings: [], new_blocks: [] };
    },
    async postJson(url: string, _token: string, body: Record<string, unknown>) {
      calls.push({ api: url.includes("/descendant") ? "insert_text" : "post", url, body });
      return { document_revision_id: 45 };
    },
    async getJson(url: string) {
      calls.push({ api: url.includes("/children") ? "root_children" : "children_count", url });
      return { items: [{ block_id: "h1" }, { block_id: "p1" }, { block_id: "tbl1" }, { block_id: "p2" }], has_more: false };
    },
  };
  return { client: client as unknown as FeishuOpenApiClient, calls };
}

test("文本补丁：含表格文档改文字/单元格 → 只 PATCH 变更块，表格结构不重发", async () => {
  const { client, calls } = fakePatchClient();
  const draft = [
    "# 新标题",
    "",
    "第一段",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">新单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n");
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({
    draftMarkdown: draft,
    baselineMarkdown: draft,
    baseIr: nativeDocBaseIr(),
  }));

  assert.equal(outcome.status, "succeeded");
  assert.ok(outcome.status === "succeeded" && outcome.strategy === "text_patch");
  // 标题（直接在 h1 上）+ 单元格B（c2 无 text 子块 → PATCH cell 自身）
  const patched = calls.filter((c) => c.api === "patch_text").map((c) => c.body?.update_text_elements?.elements?.[0]?.text_run?.content);
  assert.deepEqual(patched, ["新标题", "新单元格B"]);
  // 没有任何 docs_ai 覆写（原生块不重发）
  assert.equal(calls.filter((c) => c.api === "docs_ai_overwrite").length, 0);
});

test("文本补丁：含表格文档新增段落 → descendant(root)+index 定位", async () => {
  const { client, calls } = fakePatchClient();
  const draft = [
    "# 新标题",
    "",
    "第一段",
    "",
    "新增的一段",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n");
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({
    draftMarkdown: draft,
    baselineMarkdown: draft,
    baseIr: nativeDocBaseIr(),
  }));
  assert.equal(outcome.status, "succeeded");
  assert.ok(outcome.status === "succeeded" && outcome.strategy === "text_patch");
  const insert = calls.find((c) => c.api === "insert_text");
  assert.ok(insert && String(insert.url).includes(`/blocks/DOC123/descendant`), JSON.stringify(calls.map((c) => c.api + ":" + c.url.slice(-30))));
  assert.equal(insert?.body?.descendants?.[0]?.text?.elements?.[0]?.text_run?.content, "新增的一段");
  assert.equal(insert?.body?.index, 2); // 锚点 p1 在 root children 的 index+1
});

test("文本补丁：画板文档改文字 → PATCH 文字且画板不重发", async () => {
  const { client, calls } = fakePatchClient();
  const baseIr = nativeDocBaseIr();
  baseIr.blocks.tbl1 = { id: "tbl1", type: "board", parentId: "DOC123", children: [], editable: false, text: [], resource: { token: "wb001", kind: "whiteboard" }, attrs: {}, raw: {} };
  baseIr.blocks.DOC123 = { ...baseIr.blocks.DOC123!, children: ["h1", "p1", "tbl1", "p2"] };
  const draft = [
    "# 新标题",
    "",
    "第一段",
    "",
    '<board token="wb001" blockId="tbl1" align="1" />',
    "",
    "结尾段",
  ].join("\n");
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({
    draftMarkdown: draft,
    baselineMarkdown: draft,
    baseIr,
  }));
  assert.equal(outcome.status, "succeeded");
  assert.ok(outcome.status === "succeeded" && outcome.strategy === "text_patch");
  assert.equal(calls.filter((c) => c.api === "patch_text").length, 1); // 只有标题
});

// ---------- 段落对齐（两指针贪心 diff） ----------

test("对齐：段首前插一段 → insert 定位在标题锚点后（不被误判为文本修改）", async () => {
  const { client } = fakePatchClient();
  const baseIr = nativeDocBaseIr(); // h1(旧标题), p1(第一段), tbl1, p2(结尾段)
  const draft = [
    "# 旧标题",
    "",
    "新插入的段首段落。",
    "",
    "第一段",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n");
  const outcome = await pushDocumentWithStrategies(client, "token", makeContext({
    draftMarkdown: draft,
    baselineMarkdown: draft,
    baseIr,
  }));
  assert.equal(outcome.status, "succeeded");
  const planCalls = [];
  // 通过 planTextPatch 直接验证更精确
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const plan = planTextPatch({ baseIr, draftMarkdown: draft });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.deepEqual(plan.operations, []); // 不允许出现对 p1 的误改
    assert.equal(plan.inserts.length, 1);
    assert.equal(plan.inserts[0]?.text, "新插入的段首段落。");
    assert.equal(plan.inserts[0]?.afterBlockId, "h1"); // 插在标题锚点后
    assert.deepEqual(plan.deletes, []);
  }
});

test("对齐：段中插入 + 修改相邻段 → insert 与 update 共存且互不误伤", async () => {
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const baseIr = nativeDocBaseIr();
  const draft = [
    "# 旧标题",
    "",
    "第一段（已修改）",
    "",
    "段中新增。",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n");
  const plan = planTextPatch({ baseIr, draftMarkdown: draft });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.deepEqual(plan.operations, [{ blockId: "p1", text: "第一段（已修改）" }]);
    assert.deepEqual(plan.inserts, [{ afterBlockId: "p1", text: "段中新增。" }]);
    assert.deepEqual(plan.deletes, []);
  }
});

test("对齐：删除一段 → delete 对应块", async () => {
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const baseIr = nativeDocBaseIr();
  const draft = [
    "# 旧标题",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n"); // 删掉了第一段
  const plan = planTextPatch({ baseIr, draftMarkdown: draft });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(plan.inserts, []);
    assert.deepEqual(plan.deletes, [{ blockId: "p1", parentId: "DOC123" }]);
  }
});

test("对齐：尾插一段 → insert 定位在前一段后", async () => {
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const baseIr = nativeDocBaseIr();
  const draft = [
    "# 旧标题",
    "",
    "第一段",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
    "",
    "最后新增的段落。",
  ].join("\n");
  const plan = planTextPatch({ baseIr, draftMarkdown: draft });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.deepEqual(plan.inserts, [{ afterBlockId: "p2", text: "最后新增的段落。" }]);
  }
});

test("对齐：文档最前新增段落 → afterBlockId 为空（execute 落 root index 0，不再静默丢弃）", async () => {
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const baseIr = nativeDocBaseIr();
  const draft = [
    "123",
    "",
    "# 旧标题",
    "",
    "第一段",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n");
  const plan = planTextPatch({ baseIr, draftMarkdown: draft });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.deepEqual(plan.inserts, [{ afterBlockId: "", text: "123" }]);
  }

  // executeTextPatch：空锚点 → /descendant index=0（插到文档最前）
  const { client, calls } = fakePatchClient();
  const { executeTextPatch } = await import("../src/feishu/patch.js");
  await executeTextPatch(client, "token", {
    docId: "DOC123",
    baseRevisionId: "42",
    operations: [],
    inserts: [{ afterBlockId: "", text: "123" }],
    deletes: [],
  });
  const insert = calls.find((c) => c.api === "insert_text");
  assert.ok(insert, "空锚点插入必须真正发出 /descendant 请求");
  assert.equal(insert?.body?.index, 0);
  assert.equal(insert?.body?.descendants?.[0]?.text?.elements?.[0]?.text_run?.content, "123");
});

test("对齐：删除标题嵌套子段落 → delete 指向标题的 children", async () => {
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const baseIr = nativeDocBaseIr();
  // 标题下挂一个文本子块（飞书标题是可折叠容器，子块是真实可见内容）
  baseIr.blocks.h1!.children = ["nested1"];
  baseIr.blocks.nested1 = {
    id: "nested1", type: "text", parentId: "h1", children: [], editable: true,
    text: [{ kind: "text", text: "标题下的子段落", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {},
  };
  const draft = [
    "# 旧标题",
    "",
    "第一段",
    "",
    '<table blockId="tbl1" cells="c1,c2" column-size="1" row-size="2">',
    '<table-cell blockId="c1">单元格A</table-cell>',
    '<table-cell blockId="c2">单元格B</table-cell>',
    "</table>",
    "",
    "结尾段",
  ].join("\n"); // 子段落被删掉
  const plan = planTextPatch({ baseIr, draftMarkdown: draft });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.deepEqual(plan.deletes, [{ blockId: "nested1", parentId: "h1" }]);
  }
});

test("渲染：标题嵌套子块渲染为紧随标题的段落（不静默丢弃）", async () => {
  const { feishuDocIRToSourceMarkdown } = await import("../src/feishu/markdown.js");
  const baseIr = nativeDocBaseIr();
  baseIr.blocks.h1!.children = ["nested1"];
  baseIr.blocks.nested1 = {
    id: "nested1", type: "text", parentId: "h1", children: [], editable: true,
    text: [{ kind: "text", text: "123", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {},
  };
  const md = feishuDocIRToSourceMarkdown(baseIr);
  assert.ok(md.includes("# 旧标题"), md);
  assert.ok(/^123$/m.test(md), `子块文本必须出现在 markdown 中：\n${md}`);
});

test("渲染后再次规划：嵌套子段落与草稿段落配对 → 无任何操作（防重复插入）", async () => {
  const { feishuDocIRToSourceMarkdown } = await import("../src/feishu/markdown.js");
  const { planTextPatch } = await import("../src/feishu/patch.js");
  const baseIr = nativeDocBaseIr();
  baseIr.blocks.h1!.children = ["nested1"];
  baseIr.blocks.nested1 = {
    id: "nested1", type: "text", parentId: "h1", children: [], editable: true,
    text: [{ kind: "text", text: "123", attrs: {}, raw: {} }], resource: null, attrs: {}, raw: {},
  };
  const rendered = feishuDocIRToSourceMarkdown(baseIr);
  const plan = planTextPatch({ baseIr, draftMarkdown: rendered });
  assert.equal(plan.status, "ready");
  if (plan.status === "ready") {
    assert.equal(plan.operations.length + plan.inserts.length + plan.deletes.length, 0, "自身渲染结果必须与基线零差异");
  }
});
