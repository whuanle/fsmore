import type { FeishuDocIR, FeishuDocIRBlock } from "./ir.js";
import { isReversibleMermaidAsset } from "./whiteboard.js";

/**
 * 源码 markdown 渲染器版本：渲染语义变化（如标题子块不再丢弃）时递增。
 * 写入 frontmatter；同步跳过前校验——旧版本渲染的文件必须重拉重渲染一次。
 */
export const FEISHU_MARKDOWN_RENDER_VERSION = 2;

/**
 * IR → 源码 Markdown（照抄 MaomiAgent feishu-doc-source-markdown-codec）：
 * 图片/附件/高亮块/栅格等以飞书原生标签保留（<image token=... />、<callout ...>...），
 * 可逆白板渲染为 mermaid 围栏 —— 该格式与 MaomiAgent 严格验证过的回写链路配套：
 * 含原生标签的内容走 docs_ai 整文覆写实现无损回写。
 */

export function feishuDocIRToSourceMarkdown(ir: FeishuDocIR): string {
  const root = ir.blocks[ir.document.rootBlockId];
  const lines = (root?.children ?? [])
    .map((id) => blockToSourceMarkdown(ir, id))
    .filter((line) => line.length > 0);
  return `${lines.join("\n\n")}\n`;
}

function blockToSourceMarkdown(ir: FeishuDocIR, blockId: string): string {
  const block = ir.blocks[blockId];
  if (!block) {
    return "";
  }

  const reversibleAsset = block.resource?.token
    ? ir.assets[block.resource.token]
    : undefined;
  if (isReversibleMermaidAsset(reversibleAsset)) {
    return `\`\`\`mermaid\n${reversibleAsset.reversible.source}\n\`\`\``;
  }

  const text = blockText(block);
  const children = childBlocksToSourceMarkdown(ir, block);
  const body = blockBody(text, children);
  const hasVisibleText = text.trim().length > 0;

  if (block.type.startsWith("heading")) {
    const level = headingLevel(block.type);
    if (!level) {
      return nativeBlockComponent(ir, block, body);
    }
    // 飞书标题是可折叠容器：子块是紧跟标题的真实内容，渲染成后续段落（此前被静默丢弃）
    return withFlowChildren(hasVisibleText ? `${"#".repeat(level)} ${text}` : "", children);
  }

  switch (block.type) {
    case "text":
      return withFlowChildren(hasVisibleText ? text : "", children);
    case "bullet":
      return withFlowChildren(hasVisibleText ? `- ${text}` : "", children);
    case "ordered":
      return withFlowChildren(hasVisibleText ? `1. ${text}` : "", children);
    case "quote":
      return withFlowChildren(hasVisibleText ? `> ${text}` : "", children);
    case "code":
      return withFlowChildren(hasVisibleText ? `\`\`\`\n${text}\n\`\`\`` : "", children);
    case "todo":
      return withFlowChildren(hasVisibleText ? `- [ ] ${text}` : "", children);
    case "image":
      return selfClosingComponent("image", componentAttrs(componentPropsFromBlock(ir, block)));
    case "file":
      return selfClosingComponent("file", componentAttrs(componentPropsFromBlock(ir, block)));
    case "callout":
      return nativeComponent("callout", componentAttrs(componentPropsFromBlock(ir, block, { includeBlockId: true })), body);
    case "grid":
      return nativeComponent("grid", componentAttrs(componentPropsFromBlock(ir, block, { includeBlockId: true })), body);
    case "grid-column":
      return nativeComponent("grid-column", componentAttrs(componentPropsFromBlock(ir, block, { includeBlockId: true })), body);
    default:
      return nativeBlockComponent(ir, block, body);
  }
}

function childBlocksToSourceMarkdown(ir: FeishuDocIR, block: FeishuDocIRBlock): string {
  return block.children
    .map((id) => blockToSourceMarkdown(ir, id))
    .filter((line) => line.length > 0)
    .join("\n\n");
}

/** 流式块（标题/列表/引用等）的子块内容追加渲染，绝不静默丢弃远端真实内容 */
function withFlowChildren(line: string, children: string): string {
  return [line, children]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
}

function blockText(block: FeishuDocIRBlock): string {
  return block.text.map((run) => run.text).join("");
}

function blockBody(text: string, children: string): string {
  return [text, children]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
}

function headingLevel(type: string): number | null {
  const match = /^heading([1-6])$/.exec(type);
  return match ? Number(match[1]) : null;
}

function nativeBlockComponent(ir: FeishuDocIR, block: FeishuDocIRBlock, body: string): string {
  return nativeComponent(
    block.type,
    componentAttrs(componentPropsFromBlock(ir, block, { includeBlockId: true })),
    body,
  );
}

function flowComponent(name: string, attrs: string, children: string): string {
  return `<${name}${attrs}>\n${children}\n</${name}>`;
}

function selfClosingComponent(name: string, attrs: string): string {
  return `<${name}${attrs} />`;
}

function nativeComponent(name: string, attrs: string, body: string): string {
  return body ? flowComponent(name, attrs, body) : selfClosingComponent(name, attrs);
}

function componentPropsFromBlock(
  ir: FeishuDocIR,
  block: FeishuDocIRBlock,
  options: { includeBlockId?: boolean } = {},
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {};

  if (options.includeBlockId) {
    attrs.blockId = block.id;
  }

  if (block.resource?.token) {
    attrs.token = block.resource.token;
  }

  for (const [key, value] of Object.entries(block.attrs)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attrs[key] = value;
    }
  }

  return attrs;
}

function componentAttrs(values: Record<string, unknown>): string {
  const attrs = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`);
  return attrs.join("");
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
