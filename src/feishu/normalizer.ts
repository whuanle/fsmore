import { createHash } from "node:crypto";
import type {
  FeishuDocIR,
  FeishuDocIRAsset,
  FeishuDocIRBlock,
  FeishuDocIRBlockType,
  FeishuDocIRTextRun,
} from "./ir.js";
import { isRecord } from "./ir.js";

/**
 * 原始 docx block → IR 归一化（参考 MaomiAgent feishu-doc-ir-normalizer 移植，
 * 扩展：富文本样式、mention_doc/mention_user/equation 元素、todo/code 等属性别名）。
 */

export type FeishuRawDocBlock = Record<string, unknown> & {
  block_id?: string;
  parent_id?: string;
  block_type?: number;
  children?: string[];
};

const BLOCK_TYPE_BY_NUMBER: Record<number, FeishuDocIRBlockType> = {
  1: "page",
  2: "text",
  3: "heading1",
  4: "heading2",
  5: "heading3",
  6: "heading4",
  7: "heading5",
  8: "heading6",
  9: "heading7",
  10: "heading8",
  11: "heading9",
  12: "bullet",
  13: "ordered",
  14: "code",
  15: "quote",
  16: "divider",
  17: "todo",
  19: "callout",
  27: "image",
  28: "file",
  31: "table",
  32: "table-cell",
  34: "bitable",
  35: "sheet",
  36: "mindnote",
  37: "whiteboard",
  43: "board",
};

const BLOCK_TYPE_BY_PAYLOAD_KEY: Array<[string, FeishuDocIRBlockType]> = [
  ["page", "page"],
  ["text", "text"],
  ["heading1", "heading1"],
  ["heading2", "heading2"],
  ["heading3", "heading3"],
  ["heading4", "heading4"],
  ["heading5", "heading5"],
  ["heading6", "heading6"],
  ["heading7", "heading7"],
  ["heading8", "heading8"],
  ["heading9", "heading9"],
  ["bullet", "bullet"],
  ["ordered", "ordered"],
  ["code", "code"],
  ["quote", "quote"],
  ["divider", "divider"],
  ["todo", "todo"],
  ["callout", "callout"],
  ["quote_container", "quote-container"],
  ["quoteContainer", "quote-container"],
  ["grid", "grid"],
  ["grid_column", "grid-column"],
  ["gridColumn", "grid-column"],
  ["table", "table"],
  ["table_cell", "table-cell"],
  ["tableCell", "table-cell"],
  ["view", "view"],
  ["image", "image"],
  ["file", "file"],
  ["iframe", "iframe"],
  ["whiteboard", "whiteboard"],
  ["mindnote", "mindnote"],
  ["diagram", "diagram"],
  ["sheet", "sheet"],
  ["bitable", "bitable"],
  ["board", "board"],
  ["chat_card", "chat-card"],
  ["chatCard", "chat-card"],
  ["link_preview", "link-preview"],
  ["linkPreview", "link-preview"],
  ["jira_issue", "jira-issue"],
  ["jiraIssue", "jira-issue"],
  ["add_ons", "add-ons"],
  ["addOns", "add-ons"],
  ["isv", "isv"],
  ["okr", "okr"],
  ["source_synced", "source-synced"],
  ["sourceSynced", "source-synced"],
  ["reference_synced", "reference-synced"],
  ["referenceSynced", "reference-synced"],
  ["ai_template", "ai-template"],
  ["aiTemplate", "ai-template"],
];

const TEXT_CONTAINER_KEYS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "todo",
  "quote",
  "code",
  "table_cell",
  "tableCell",
] as const;

const RESOURCE_TOKEN_KEYS = [
  "token",
  "file_token",
  "fileToken",
  "whiteboard_token",
  "whiteboardToken",
  "mindnote_token",
  "mindnoteToken",
  "diagram_token",
  "diagramToken",
  "bitable_token",
  "bitableToken",
  "spreadsheet_token",
  "spreadsheetToken",
] as const;

const TOP_LEVEL_ATTR_KEYS = [
  "token",
  "url",
  "href",
  "src",
  "title",
  "name",
  "description",
  "summary",
  "type",
  "view_type",
  "viewType",
  "sheet_id",
  "sheetId",
  "spreadsheet_token",
  "spreadsheetToken",
  "bitable_token",
  "bitableToken",
  "whiteboard_token",
  "whiteboardToken",
  "mindnote_token",
  "mindnoteToken",
  "diagram_token",
  "diagramToken",
] as const;

const TABLE_ATTR_ALIAS_TYPES = new Set<FeishuDocIRBlockType>(["table", "table-cell"]);

export function normalizeFeishuDocBlocksToIR(input: {
  documentId: string;
  title: string;
  revisionId: string;
  pulledAt: string;
  documentIdType: "document_id" | "wiki_node_token";
  nodeToken?: string;
  blocks: FeishuRawDocBlock[];
}): FeishuDocIR {
  const blocks: Record<string, FeishuDocIRBlock> = {};
  const assets: Record<string, FeishuDocIRAsset> = {};
  const rootBlockId = resolveRootBlockId(input.blocks, input.documentId);

  for (const [index, rawBlock] of input.blocks.entries()) {
    const id = rawBlock.block_id || `block_${index + 1}`;
    const type = resolveBlockType(rawBlock);
    const resource = extractResource(rawBlock, type);
    const attrs = extractAttrs(rawBlock, type);

    if (resource && !assets[resource.token]) {
      assets[resource.token] = {
        token: resource.token,
        kind: resource.kind,
        mime: "",
        localPath: "",
        status: "missing",
        width: typeof attrs.width === "number" ? attrs.width : undefined,
        height: typeof attrs.height === "number" ? attrs.height : undefined,
        name: typeof attrs.name === "string" ? attrs.name : undefined,
      };
    }

    blocks[id] = {
      id,
      type,
      parentId: rawBlock.parent_id || null,
      children: Array.isArray(rawBlock.children)
        ? rawBlock.children.filter((child): child is string => typeof child === "string")
        : [],
      editable: type !== "page" && type !== "undefined",
      text: extractTextRuns(rawBlock),
      resource,
      attrs,
      raw: rawBlock,
    };
  }

  return {
    schemaVersion: 1,
    document: {
      id: input.documentId,
      title: input.title,
      revisionId: input.revisionId,
      rootBlockId,
      pulledAt: input.pulledAt,
      source: {
        nodeToken: input.nodeToken,
        documentIdType: input.documentIdType,
      },
    },
    blocks,
    assets,
    integrity: {
      contentHash: hashJson(blocks),
      rawHash: hashJson(input.blocks),
    },
  };
}

function resolveBlockType(block: FeishuRawDocBlock): FeishuDocIRBlockType {
  if (typeof block.block_type === "number") {
    return BLOCK_TYPE_BY_NUMBER[block.block_type] || inferBlockTypeFromPayload(block);
  }
  return inferBlockTypeFromPayload(block);
}

function inferBlockTypeFromPayload(block: FeishuRawDocBlock): FeishuDocIRBlockType {
  for (const [key, type] of BLOCK_TYPE_BY_PAYLOAD_KEY) {
    if (block[key] !== undefined) {
      return type;
    }
  }
  return "undefined";
}

function resolveRootBlockId(blocks: FeishuRawDocBlock[], documentId: string): string {
  return blocks.find((block) => block.block_id === documentId)?.block_id
    || blocks.find((block) => block.block_type === 1)?.block_id
    || blocks[0]?.block_id
    || documentId;
}

function extractTextRuns(block: FeishuRawDocBlock): FeishuDocIRTextRun[] {
  const container = findTextContainer(block);
  if (!container) {
    return [];
  }

  const elements = Array.isArray(container.elements) ? container.elements : [];
  const runs = elements.flatMap(extractTextRunFromElement);
  const directContent = typeof container.content === "string" ? container.content : "";
  return runs.length > 0 || directContent.length === 0
    ? runs
    : [{ kind: "text", text: directContent, attrs: {}, raw: container }];
}

function findTextContainer(block: FeishuRawDocBlock): Record<string, unknown> | null {
  for (const key of TEXT_CONTAINER_KEYS) {
    const value = block[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return null;
}

function extractTextRunFromElement(element: unknown): FeishuDocIRTextRun[] {
  if (!isRecord(element)) {
    return [];
  }

  // MaomiAgent 验证版：仅提取纯文本内容（样式不进入 markdown，保证拉取/回写可逆）
  const textRun = element.text_run;
  if (isRecord(textRun) && typeof textRun.content === "string") {
    return [{ kind: "text", text: textRun.content, attrs: {}, raw: element }];
  }

  const mentionDoc = element.mention_doc;
  if (isRecord(mentionDoc)) {
    const title = typeof mentionDoc.title === "string" ? mentionDoc.title : "";
    const url = typeof mentionDoc.url === "string" ? mentionDoc.url : "";
    return [{
      kind: "mention_doc",
      text: title || url || "文档链接",
      url: url || undefined,
      attrs: {},
      raw: element,
    }];
  }

  const mentionUser = element.mention_user;
  if (isRecord(mentionUser)) {
    const userId = typeof mentionUser.user_id === "string" ? mentionUser.user_id : "";
    return [{ kind: "mention_user", text: `@${userId || "用户"}`, attrs: {}, raw: element }];
  }

  return [];
}

function extractResource(
  block: FeishuRawDocBlock,
  type: FeishuDocIRBlockType,
): { token: string; kind: FeishuDocIRAsset["kind"] } | null {
  if (type === "image") {
    return resourceFromBlockOrContainer(block, block.image, "image");
  }
  if (type === "file") {
    return resourceFromBlockOrContainer(block, block.file, "file");
  }
  if (type === "board") {
    return resourceFromBlockOrContainer(block, resolveAttrsContainer(block, type), "whiteboard");
  }
  if (type === "whiteboard") {
    return resourceFromBlockOrContainer(block, block.whiteboard, "whiteboard");
  }
  if (type === "mindnote") {
    return resourceFromBlockOrContainer(block, block.mindnote, "mindnote");
  }
  if (type === "diagram") {
    return resourceFromBlockOrContainer(block, block.diagram, "diagram");
  }
  return null;
}

function resourceFromBlockOrContainer(
  block: FeishuRawDocBlock,
  value: unknown,
  kind: FeishuDocIRAsset["kind"],
): { token: string; kind: FeishuDocIRAsset["kind"] } | null {
  const token = readTokenValue(value) ?? readTokenValue(block);
  if (!token) {
    return null;
  }
  return { token, kind };
}

function extractAttrs(block: FeishuRawDocBlock, type: FeishuDocIRBlockType): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const container = resolveAttrsContainer(block, type);

  if (container) {
    collectPrimitiveAttrs(container, attrs);
  }

  for (const key of TOP_LEVEL_ATTR_KEYS) {
    const value = block[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const normalizedKey = normalizeAttrKey(key);
      if (normalizedKey && attrs[normalizedKey] === undefined) {
        attrs[normalizedKey] = value;
      }
    }
  }

  if (TABLE_ATTR_ALIAS_TYPES.has(type)) {
    aliasPrefixedPrimitiveAttrs(attrs, "property-");
  }
  if (type === "todo") {
    aliasPrimitiveAttr(attrs, "style-done", "done");
  }
  if (type === "code") {
    aliasPrimitiveAttr(attrs, "style-language", "language");
    aliasPrimitiveAttr(attrs, "style-wrap", "wrap");
  }

  aliasPrimitiveAttr(attrs, "file-name", "name");
  aliasPrimitiveAttr(attrs, "mime-type", "mime");
  return attrs;
}

function resolveAttrsContainer(
  block: FeishuRawDocBlock,
  type: FeishuDocIRBlockType,
): Record<string, unknown> | null {
  for (const [key, candidateType] of BLOCK_TYPE_BY_PAYLOAD_KEY) {
    if (candidateType !== type) {
      continue;
    }
    const value = block[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return null;
}

function normalizeAttrKey(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\s]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function collectPrimitiveAttrs(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  prefix = "",
  depth = 0,
) {
  if (depth > 2) {
    return;
  }

  for (const [rawKey, value] of Object.entries(source)) {
    const key = normalizeAttrKey(rawKey);
    if (!key) {
      continue;
    }

    const targetKey = prefix ? `${prefix}-${key}` : key;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (target[targetKey] === undefined) {
        target[targetKey] = value;
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length > 0 && value.every((item) => (
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      ))) {
        if (target[targetKey] === undefined) {
          target[targetKey] = value.join(",");
        }
      }
      continue;
    }

    if (isRecord(value)) {
      collectPrimitiveAttrs(value, target, targetKey, depth + 1);
    }
  }
}

function aliasPrimitiveAttr(
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
) {
  const value = target[sourceKey];
  if ((typeof value === "string" || typeof value === "number" || typeof value === "boolean") && target[targetKey] === undefined) {
    target[targetKey] = value;
  }
}

function aliasPrefixedPrimitiveAttrs(target: Record<string, unknown>, prefix: string) {
  for (const key of Object.keys(target)) {
    if (!key.startsWith(prefix) || key.length <= prefix.length) {
      continue;
    }
    aliasPrimitiveAttr(target, key, key.slice(prefix.length));
  }
}

function readTokenValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of RESOURCE_TOKEN_KEYS) {
    const token = value[key];
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
  }
  return null;
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
