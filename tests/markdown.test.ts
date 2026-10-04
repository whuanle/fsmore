import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFeishuDocBlocksToIR, type FeishuRawDocBlock } from "../src/feishu/normalizer.js";
import { feishuDocIRToSourceMarkdown } from "../src/feishu/markdown.js";
import {
  applyRecoveredMermaidWhiteboards,
  buildReversibleMermaidPushPlan,
} from "../src/feishu/whiteboard.js";

function blocksWithRoot(blocks: FeishuRawDocBlock[], documentId = "DOC123"): FeishuRawDocBlock[] {
  return [
    { block_id: documentId, block_type: 1, children: blocks.map((block) => block.block_id ?? "") },
    ...blocks,
  ];
}

function buildIR(blocks: FeishuRawDocBlock[], documentId = "DOC123") {
  return normalizeFeishuDocBlocksToIR({
    documentId,
    title: "测试文档",
    revisionId: "7",
    pulledAt: "2026-01-01T00:00:00.000Z",
    documentIdType: "document_id",
    blocks: blocksWithRoot(blocks, documentId),
  });
}

function textRun(content: string) {
  return { text_run: { content, text_element_style: {} } };
}

test("标题/文本/分割线（纯文本，样式不入 markdown）", () => {
  const ir = buildIR([
    {
      block_id: "b1",
      block_type: 3,
      parent_id: "DOC123",
      heading1: { elements: [textRun("项目背景"), { text_run: { content: "加粗", text_element_style: { bold: true } } }] },
      children: [],
    },
    { block_id: "b2", block_type: 2, parent_id: "DOC123", text: { elements: [textRun("普通文本")] }, children: [] },
    { block_id: "b3", block_type: 16, parent_id: "DOC123", divider: {}, children: [] },
  ]);
  const md = feishuDocIRToSourceMarkdown(ir);
  // 与 MaomiAgent 一致：块间空行分隔；富文本样式不保留（保证可回写）
  assert.match(md, /# 项目背景加粗/);
  assert.match(md, /普通文本/);
  // divider 不做特殊转换，走原生标签（docs_ai 覆写可无损还原）
  assert.match(md, /<divider blockId="b3" \/>/);
});

test("列表（MaomiAgent 平铺格式）", () => {
  const ir = buildIR([
    {
      block_id: "l1",
      block_type: 12,
      parent_id: "DOC123",
      bullet: { elements: [textRun("一级")] },
      children: ["l2"],
    },
    {
      block_id: "l2",
      block_type: 12,
      parent_id: "l1",
      bullet: { elements: [textRun("二级")] },
      children: [],
    },
  ]);
  const md = feishuDocIRToSourceMarkdown(ir);
  // MaomiAgent 源码格式：子块平铺（不缩进），空行分隔
  assert.ok(md.includes("- 一级"), md);
  assert.ok(md.includes("- 二级"), md);
});

test("图片/文件 → 原生标签（可回写）", () => {
  const ir = buildIR([
    {
      block_id: "img1",
      block_type: 27,
      parent_id: "DOC123",
      image: { token: "img001", width: 200, height: 100 },
      children: [],
    },
    {
      block_id: "file1",
      block_type: 28,
      parent_id: "DOC123",
      file: { token: "file001", name: "需求附件.pdf" },
      children: [],
    },
  ]);
  const md = feishuDocIRToSourceMarkdown(ir);
  assert.ok(md.includes('<image token="img001"'), md);
  assert.ok(md.includes('<file token="file001"'), md);
  assert.ok(md.includes('name="需求附件.pdf"'), md);
});

test("高亮块 → callout 原生组件（子块嵌套其中）", () => {
  const ir = buildIR([
    {
      block_id: "callout1",
      block_type: 19,
      parent_id: "DOC123",
      callout: { background_color: 1 },
      children: ["callout_child"],
    },
    {
      block_id: "callout_child",
      block_type: 2,
      parent_id: "callout1",
      text: { elements: [textRun("提示信息")] },
      children: [],
    },
  ]);
  const md = feishuDocIRToSourceMarkdown(ir);
  assert.ok(md.includes('<callout blockId="callout1"'), md);
  assert.ok(md.includes("</callout>"), md);
  assert.ok(md.includes("提示信息"), md);
});

test("白板：不可逆 → whiteboard 原生标签；可逆 → mermaid 围栏", () => {
  const ir = buildIR([
    {
      block_id: "wb1",
      block_type: 37,
      parent_id: "DOC123",
      whiteboard: { token: "wbtoken01" },
      children: [],
    },
  ]);

  const mdWithoutRecovery = feishuDocIRToSourceMarkdown(ir);
  assert.ok(mdWithoutRecovery.includes('<whiteboard blockId="wb1" token="wbtoken01"'), mdWithoutRecovery);

  const recovered = applyRecoveredMermaidWhiteboards({
    ir,
    recovered: [{
      whiteboardToken: "wbtoken01",
      format: "mermaid",
      source: "flowchart TD\n  A --> B",
      origin: "whiteboard_code_export",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  const mdRecovered = feishuDocIRToSourceMarkdown(recovered);
  assert.ok(mdRecovered.includes("```mermaid\nflowchart TD\n  A --> B\n```"), mdRecovered);
});

test("白板增量推送计划：未修改 → 无变更；修改 → 生成更新清单；换位置 → 阻断", () => {
  const base = buildIR([
    {
      block_id: "wb1",
      block_type: 37,
      parent_id: "DOC123",
      whiteboard: { token: "wbtoken01" },
      children: [],
    },
  ]);
  const ir = applyRecoveredMermaidWhiteboards({
    ir: base,
    recovered: [{
      whiteboardToken: "wbtoken01",
      format: "mermaid",
      source: "flowchart TD\n  A --> B",
      origin: "whiteboard_code_export",
      resolvedAt: "2026-01-01T00:00:00.000Z",
    }],
  });

  // 未修改：update + 空变更清单（围栏替换回 <whiteboard> 标签走 docs_ai，白板不重绘）
  const untouched = buildReversibleMermaidPushPlan({
    draftMarkdown: "前文\n\n```mermaid\nflowchart TD\n  A --> B\n```\n",
    baseIr: ir,
  });
  assert.equal(untouched.kind, "update");
  assert.ok(untouched.kind === "update" && untouched.changedWhiteboards.length === 0);
  assert.ok(untouched.kind === "update" && untouched.documentMarkdown.includes('<whiteboard token="wbtoken01" />'));

  // 修改内容：update + changedWhiteboards，且草稿中围栏被替换回 <whiteboard token>
  const updated = buildReversibleMermaidPushPlan({
    draftMarkdown: "前文\n\n```mermaid\nflowchart TD\n  A --> C\n```\n",
    baseIr: ir,
  });
  assert.equal(updated.kind, "update");
  assert.ok(updated.kind === "update" && updated.changedWhiteboards.length === 1);
  assert.ok(updated.kind === "update" && updated.documentMarkdown.includes('<whiteboard token="wbtoken01" />'));

  // 数量变化：阻断
  const countChanged = buildReversibleMermaidPushPlan({
    draftMarkdown: "```mermaid\nflowchart TD\n  A --> B\n```\n\n```mermaid\nflowchart LR\n  X --> Y\n```",
    baseIr: ir,
  });
  assert.equal(countChanged.kind, "blocked");
});

test("未知块类型 → 原生组件占位（不丢结构）", () => {
  const ir = buildIR([
    { block_id: "u1", block_type: 99, parent_id: "DOC123", okr: {}, children: [] },
  ]);
  const md = feishuDocIRToSourceMarkdown(ir);
  assert.ok(md.includes("<okr"), md);
});
