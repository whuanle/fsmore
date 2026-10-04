import { randomUUID } from "node:crypto";
import type { FeishuOpenApiClient } from "./client.js";
import { openApiUrl } from "./tree.js";
import type { FeishuRawDocBlock } from "./normalizer.js";
import { nativeTablesToMarkdown } from "./native-tables.js";
import { executeTextPatch, planTextPatch } from "./patch.js";

/**
 * 文档回写（按 2026-10-04 对飞书 docs_ai 端点的实测结论实现，实验记录见 scripts 诊断与提交说明）：
 *
 * 实测飞书 docs_ai PUT /docs_ai/v1/documents/:id (markdown) 行为：
 * - markdown 表格 → 完整转成飞书表格块（31/32）✓
 * - 原生 <table>/<table-cell>、<divider>、<grid-column>、<quote-container>、<board> → 4010 移除标签、内容平铺 ✗
 * - <whiteboard token> → 触发白板克隆，克隆失败即变空板（degrade 2105）✗
 * - blockId/cells 等属性 → 5002 丢弃 ✗
 *
 * 因此推送策略为：
 * 1. 纯 markdown 文档（无任何原生标签、无图片）→ 官方 convert → 清空子块 → descendant 重建（带版本锁）
 * 2. 含原生标签 → 安全变换后走 docs_ai 覆写：
 *    - <table>/<table-cell> → markdown 表格（无损数据，飞书重建表格块）
 *    - <divider /> → ---
 *    - 容器类标签（callout/grid/grid-column/quote-container/view 等）→ 解包保留内部内容
 *    - 画板/图片/附件/表格类数据块（board/whiteboard/diagram/mindnote/sheet/bitable/image/file）→ 阻断推送（宁拒推不毁数据）
 * 3. docs_ai 返回 partial_success 或含 degrade 4010/5002 警告 → 视为失败阻断（防静默损坏）
 * 4. 覆写成功后 PATCH 页块文本恢复文档标题（docs_ai 会把标题改成正文 H1，实测）
 */

const FEISHU_MARKDOWN_DESCENDANT_LIMIT = 1000;

const FEISHU_NATIVE_MARKDOWN_TAG_NAMES = [
  "undefined",
  "image",
  "file",
  "callout",
  "grid",
  "grid-column",
  "divider",
  "quote-container",
  "table",
  "table-cell",
  "view",
  "iframe",
  "whiteboard",
  "mindnote",
  "diagram",
  "sheet",
  "bitable",
  "board",
  "chat-card",
  "link-preview",
  "jira-issue",
  "add-ons",
  "isv",
  "okr",
  "source-synced",
  "reference-synced",
  "ai-template",
] as const;

const FEISHU_DOCS_AI_COMPATIBLE_NATIVE_MARKDOWN_TAG_NAMES = [
  "callout",
  "grid",
  "grid-column",
  "divider",
  "quote-container",
  "table",
  "table-cell",
  "view",
  "iframe",
  "whiteboard",
  "mindnote",
  "diagram",
  "sheet",
  "bitable",
  "board",
  "chat-card",
  "link-preview",
  "jira-issue",
  "add-ons",
  "isv",
  "okr",
  "source-synced",
  "reference-synced",
  "ai-template",
] as const;

const FEISHU_DOCS_AI_INCOMPATIBLE_NATIVE_MARKDOWN_TAG_NAMES = [
  "undefined",
  "image",
  "file",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FEISHU_NATIVE_MARKDOWN_TAG_PATTERN = new RegExp(
  `<\\/?(?:feishu-)?(?:${FEISHU_NATIVE_MARKDOWN_TAG_NAMES.map((name) => escapeRegExp(name)).join("|")})\\b`,
  "i",
);

const FEISHU_DOCS_AI_COMPATIBLE_NATIVE_MARKDOWN_TAG_PATTERN = new RegExp(
  `<\\/?(?:feishu-)?(?:${FEISHU_DOCS_AI_COMPATIBLE_NATIVE_MARKDOWN_TAG_NAMES.map((name) => escapeRegExp(name)).join("|")})\\b`,
  "i",
);

const FEISHU_DOCS_AI_INCOMPATIBLE_NATIVE_MARKDOWN_TAG_PATTERN = new RegExp(
  `<\\/?(?:feishu-)?(?:${FEISHU_DOCS_AI_INCOMPATIBLE_NATIVE_MARKDOWN_TAG_NAMES.map((name) => escapeRegExp(name)).join("|")})\\b`,
  "i",
);

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\(([^)\r\n]+)\)/;

const FEISHU_MERMAID_SOURCE_MARKERS = [
  "graph ",
  "flowchart ",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "erDiagram",
  "journey",
  "mindmap",
  "timeline",
  "gitGraph",
  "pie ",
  "quadrantChart",
  "requirement",
  "xychart-beta",
  "block-beta",
  "sankey-beta",
  "packet-beta",
  "architecture-beta",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
] as const;

export function containsFeishuNativeMarkdownTag(markdown: string): boolean {
  return FEISHU_NATIVE_MARKDOWN_TAG_PATTERN.test(markdown);
}

export function containsDocsAiCompatibleNativeMarkdownTag(markdown: string): boolean {
  return FEISHU_DOCS_AI_COMPATIBLE_NATIVE_MARKDOWN_TAG_PATTERN.test(markdown);
}

export function containsDocsAiIncompatibleNativeMarkdownTag(markdown: string): boolean {
  return FEISHU_DOCS_AI_INCOMPATIBLE_NATIVE_MARKDOWN_TAG_PATTERN.test(markdown);
}

export function containsMarkdownImage(markdown: string): boolean {
  return MARKDOWN_IMAGE_PATTERN.test(markdown);
}

function escapeMarkdownAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractMarkdownAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const value = (match?.[1] ?? match?.[2] ?? "").trim();
  return value.length > 0 ? value : null;
}

function normalizeFenceLanguage(info: string): string {
  const language = info.trim().split(/\s+/)[0] ?? "";
  return language.trim().toLowerCase();
}

function looksLikeFeishuDocsMermaidSource(source: string): boolean {
  const normalized = source.trimStart();
  if (!normalized) {
    return false;
  }
  return FEISHU_MERMAID_SOURCE_MARKERS.some((marker) => normalized.startsWith(marker));
}

/** mermaid 围栏 → <whiteboard type="mermaid"> 占位（docs_ai 覆写格式） */
export function transformMermaidMarkdownBlocks(markdown: string): {
  markdown: string;
  containsMermaidBlock: boolean;
} {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let activeFence: {
    fence: string;
    info: string;
    body: string[];
    originalLines: string[];
  } | null = null;
  let containsMermaidBlock = false;

  for (const line of lines) {
    if (!activeFence) {
      const match = /^(\s*)(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
      if (!match) {
        output.push(line);
        continue;
      }

      activeFence = {
        fence: match[2] ?? "```",
        info: match[3] ?? "",
        body: [],
        originalLines: [line],
      };
      continue;
    }

    activeFence.originalLines.push(line);
    if (new RegExp(`^\\s*${escapeRegExp(activeFence.fence)}\\s*$`).test(line)) {
      const source = activeFence.body.join("\n").trim();
      const isMermaid = normalizeFenceLanguage(activeFence.info) === "mermaid"
        || looksLikeFeishuDocsMermaidSource(source);

      if (isMermaid) {
        containsMermaidBlock = true;
        output.push(
          source
            ? `<whiteboard type="mermaid">\n${source}\n</whiteboard>`
            : '<whiteboard type="mermaid"></whiteboard>',
        );
      } else {
        output.push(...activeFence.originalLines);
      }

      activeFence = null;
      continue;
    }

    activeFence.body.push(line);
  }

  if (activeFence) {
    output.push(...activeFence.originalLines);
  }

  return {
    markdown: output.join("\n"),
    containsMermaidBlock,
  };
}

/** board/whiteboard 标签归一化为 <whiteboard token="..." />（docs_ai 覆写格式） */
function normalizeDocsAiWhiteboardPlaceholders(markdown: string): string {
  const rewritePlaceholder = (attrs: string, original: string): string => {
    const token = extractMarkdownAttribute(attrs, "token")
      ?? extractMarkdownAttribute(attrs, "whiteboard_token")
      ?? extractMarkdownAttribute(attrs, "whiteboardToken");
    if (!token) {
      return original;
    }

    return `<whiteboard token="${escapeMarkdownAttribute(token)}" />`;
  };

  return markdown
    .replace(/<(?:board|whiteboard)\b([^>]*)\/>/gi, (match, attrs: string) => rewritePlaceholder(attrs, match))
    .replace(/<(?:board|whiteboard)\b([^>]*)>\s*<\/(?:board|whiteboard)>/gi, (match, attrs: string) => rewritePlaceholder(attrs, match));
}

export function normalizeDocsAiOverwriteMarkdown(markdown: string): {
  markdown: string;
  containsMermaidBlock: boolean;
} {
  const transformed = transformMermaidMarkdownBlocks(markdown);
  return {
    markdown: normalizeDocsAiWhiteboardPlaceholders(transformed.markdown),
    containsMermaidBlock: transformed.containsMermaidBlock,
  };
}

export function shouldUseDocsAiMarkdownOverwrite(input: {
  draftMarkdown: string;
  baselineMarkdown: string;
  /** fsmore 无 baseIr 时传 null */
  baseIr?: { rootPushStrategy?: string } | null;
}): boolean {
  if (containsDocsAiCompatibleNativeMarkdownTag(input.draftMarkdown)) {
    return true;
  }

  if (containsDocsAiCompatibleNativeMarkdownTag(input.baselineMarkdown)) {
    return true;
  }

  if (normalizeDocsAiOverwriteMarkdown(input.draftMarkdown).containsMermaidBlock) {
    return true;
  }

  if (normalizeDocsAiOverwriteMarkdown(input.baselineMarkdown).containsMermaidBlock) {
    return true;
  }

  return input.baseIr?.rootPushStrategy === "docs_ai_markdown_overwrite";
}

function stripMergeInfo(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      stripMergeInfo(item);
    }
    return;
  }

  if ("merge_info" in value) {
    delete (value as Record<string, unknown>).merge_info;
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    stripMergeInfo(nested);
  }
}

export function sanitizeConvertedRawBlock(block: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(block);
  stripMergeInfo(next);
  return next;
}

// ---------- 远端 API ----------

type ConvertMarkdownResponse = {
  first_level_block_ids?: string[];
  blocks?: FeishuRawDocBlock[];
};

type BatchDeleteResponse = {
  document_revision_id?: number | string;
};

type CreateDescendantsResponse = {
  document_revision_id?: number | string;
};

type DocsAiOverwriteResponse = {
  document?: {
    revision_id?: number | string;
    new_blocks?: Array<{ block_id?: string; block_type?: string | number; block_token?: string }>;
  };
  result?: string;
  updated_blocks_count?: number;
  warnings?: string[];
};

export type DocsAiOverwriteResult = {
  revisionId?: string;
  result?: string;
  warnings: string[];
  newBlocks: Array<{ blockId: string; blockType?: string; blockToken?: string }>;
};

/** docs_ai 整文覆写（照抄 overwriteDocumentV2） */
export async function overwriteDocumentV2(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { documentToken: string; content: string; format: "markdown" | "xml"; revisionId?: string | number },
): Promise<DocsAiOverwriteResult> {
  const revisionId = typeof input.revisionId === "number" && Number.isFinite(input.revisionId)
    ? input.revisionId
    : (() => {
      const trimmed = typeof input.revisionId === "string" ? input.revisionId.trim() : "";
      if (!trimmed) {
        return -1;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : trimmed;
    })();

  const data = await client.putJson<DocsAiOverwriteResponse>(
    openApiUrl(`/docs_ai/v1/documents/${encodeURIComponent(input.documentToken)}`),
    accessToken,
    {
      command: "overwrite",
      content: input.content,
      format: input.format,
      revision_id: revisionId,
    },
  );

  return {
    ...(data.document?.revision_id != null ? { revisionId: String(data.document.revision_id) } : {}),
    ...(typeof data.result === "string" && data.result.trim() ? { result: data.result.trim() } : {}),
    warnings: (Array.isArray(data.warnings) ? data.warnings : [])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    newBlocks: (Array.isArray(data.document?.new_blocks) ? data.document!.new_blocks! : [])
      .map((item) => ({
        blockId: typeof item?.block_id === "string" ? item.block_id.trim() : "",
        ...(item?.block_type != null ? { blockType: String(item.block_type) } : {}),
        ...(typeof item?.block_token === "string" ? { blockToken: item.block_token.trim() } : undefined),
      }))
      .filter((item) => item.blockId.length > 0),
  };
}

/** markdown → 飞书块（官方 convert API） */
export async function convertMarkdownToBlocks(
  client: FeishuOpenApiClient,
  accessToken: string,
  markdown: string,
): Promise<{ firstLevelBlockIds: string[]; blocks: FeishuRawDocBlock[] }> {
  const data = await client.postJson<ConvertMarkdownResponse>(
    openApiUrl("/docx/v1/documents/blocks/convert"),
    accessToken,
    { content_type: "markdown", content: markdown },
  );
  return {
    firstLevelBlockIds: (data.first_level_block_ids ?? [])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
    blocks: (data.blocks ?? []).filter((block): block is FeishuRawDocBlock => !!block && typeof block === "object"),
  };
}

async function countRootChildren(
  client: FeishuOpenApiClient,
  accessToken: string,
  docId: string,
): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  do {
    const data = await client.getJson<{ items?: unknown[]; has_more?: boolean; page_token?: string }>(
      openApiUrl(`/docx/v1/documents/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(docId)}/children`, {
        page_size: 500,
        page_token: pageToken,
      }),
      accessToken,
    );
    count += data.items?.length ?? 0;
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return count;
}

async function deleteChildren(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { docId: string; revisionId?: string; startIndex: number; endIndex: number },
): Promise<string | undefined> {
  const url = openApiUrl(
    `/docx/v1/documents/${encodeURIComponent(input.docId)}/blocks/${encodeURIComponent(input.docId)}/children/batch_delete`,
    { document_revision_id: input.revisionId?.trim() || "-1", client_token: randomUUID() },
  );
  const data = await client.deleteJson<BatchDeleteResponse>(url, accessToken, {
    start_index: input.startIndex,
    end_index: input.endIndex,
  });
  return data.document_revision_id != null ? String(data.document_revision_id) : undefined;
}

async function createDescendants(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { docId: string; revisionId?: string; childrenId: string[]; descendants: FeishuRawDocBlock[] },
): Promise<string | undefined> {
  const url = openApiUrl(
    `/docx/v1/documents/${encodeURIComponent(input.docId)}/blocks/${encodeURIComponent(input.docId)}/descendant`,
    { document_revision_id: input.revisionId?.trim() || "-1", client_token: randomUUID() },
  );
  const data = await client.postJson<CreateDescendantsResponse>(url, accessToken, {
    children_id: input.childrenId,
    descendants: input.descendants,
  });
  return data.document_revision_id != null ? String(data.document_revision_id) : undefined;
}

// ---------- 推送前安全变换（实测驱动的 docs_ai 兼容层） ----------

/** 数据类原生块：随推送还原不可靠（画板克隆失败/图片附件无对应通道），宁可阻断也不能丢 */
const DOCS_AI_BLOCKED_TAG_PATTERN = /<(?:feishu-)?(?:image|file|board|whiteboard|diagram|mindnote|sheet|bitable)\b/i;

/** 容器类原生块：标签本身不被 docs_ai 支持，但解包保留内容是安全的 */
const DOCS_AI_UNWRAP_TAG_NAMES = [
  "callout",
  "grid",
  "grid-column",
  "quote-container",
  "view",
  "iframe",
  "chat-card",
  "link-preview",
  "jira-issue",
  "add-ons",
  "isv",
  "okr",
  "source-synced",
  "reference-synced",
  "ai-template",
  "undefined",
] as const;

const DOCS_AI_UNWRAP_OPEN_PATTERN = new RegExp(
  `<(?:feishu-)?(?:${DOCS_AI_UNWRAP_TAG_NAMES.join("|")})\\b[^>]*>`,
  "gi",
);
const DOCS_AI_UNWRAP_CLOSE_PATTERN = new RegExp(
  `</(?:feishu-)?(?:${DOCS_AI_UNWRAP_TAG_NAMES.join("|")})\\s*>`,
  "gi",
);

const DOCS_AI_BLOCKED_TAG_NAME_BY_MATCH: Array<[RegExp, string]> = [
  [/<(?:feishu-)?image\b/i, "图片"],
  [/<(?:feishu-)?file\b/i, "附件"],
  [/<(?:feishu-)?(?:board|whiteboard)\b/i, "画板"],
  [/<(?:feishu-)?(?:diagram|mindnote)\b/i, "画板"],
  [/<(?:feishu-)?sheet\b/i, "电子表格"],
  [/<(?:feishu-)?bitable\b/i, "多维表格"],
];

export type DocsAiTransform =
  | { ok: true; markdown: string }
  | { ok: false; message: string };

/** 把草稿 markdown 变换为 docs_ai 可安全接收的形式；数据类原生块直接阻断 */
export function transformForDocsAi(markdown: string): DocsAiTransform {
  if (MARKDOWN_IMAGE_PATTERN.test(markdown)) {
    return { ok: false, message: "当前内容包含图片，暂不支持直接回写。已保留本地草稿。" };
  }
  for (const [pattern, label] of DOCS_AI_BLOCKED_TAG_NAME_BY_MATCH) {
    if (pattern.test(markdown)) {
      return {
        ok: false,
        message: `当前文档包含${label}块，${label}暂不支持随推送还原（推送会丢失${label}内容）。已保留本地修改，未推送。`,
      };
    }
  }

  const unwrapped = markdown
    .replace(/<(?:feishu-)?divider\b[^>]*\/>/gi, "---")
    .replace(DOCS_AI_UNWRAP_OPEN_PATTERN, "")
    .replace(DOCS_AI_UNWRAP_CLOSE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n");
  return { ok: true, markdown: nativeTablesToMarkdown(unwrapped) };
}

export type PushStrategy =
  | "text_patch"
  | "docs_ai_markdown_overwrite"
  | "markdown_convert";

export type PushDocOutcome =
  | { status: "succeeded"; strategy: PushStrategy; revisionId?: string; blockCount?: number }
  | { status: "blocked"; message: string };

export type PushDocContext = {
  docId: string;
  /** 原文档标题（docs_ai 覆写会把标题改成正文 H1，推送后恢复） */
  title?: string;
  draftMarkdown: string;
  baselineMarkdown: string;
  /** 上次拉取的 IR（兼容保留） */
  baseIr?: unknown;
  /** 上次拉取的原始 blocks（兼容保留） */
  sourceBlocks?: FeishuRawDocBlock[] | null;
  /** 纯 markdown 路径的版本乐观锁（"-1" 视为不校验） */
  revisionId?: string;
};

/** docs_ai 覆写后把标题恢复为原文档标题（PATCH 页块文本，失败不影响推送结果） */
async function preserveDocumentTitle(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { docId: string; title: string; revisionId?: string },
): Promise<void> {
  const title = input.title?.trim();
  if (!title) {
    return;
  }
  try {
    const url = openApiUrl(
      `/docx/v1/documents/${encodeURIComponent(input.docId)}/blocks/${encodeURIComponent(input.docId)}`,
      { document_revision_id: input.revisionId?.trim() || "-1", client_token: randomUUID() },
    );
    await client.patchJson(url, accessToken, {
      update_text_elements: { elements: [{ text_run: { content: title } }] },
    });
  } catch {
    // 标题恢复失败不影响已成功的正文推送
  }
}

/** docs_ai 结果判定：partial_success 或出现降级警告（4010/5002）都视为失败，绝不静默损坏远端 */
function docsAiBlockedMessage(result: DocsAiOverwriteResult): string | null {
  const normalized = result.result?.trim().toLowerCase() ?? "";
  if (normalized === "failed") {
    return result.warnings[0] ?? "当前内容回写失败，已保留本地草稿。";
  }
  if (normalized === "partial_success" || result.warnings.some(w => w.includes("degrade_code=4010") || w.includes("degrade_code=5002"))) {
    return `飞书部分支持当前内容（${result.warnings[0] ?? "partial_success"}），已取消推送保留本地草稿。`;
  }
  return null;
}

/**
 * 推送文档（对齐 MaomiAgent 推送决策树，按安全性排序）：
 * 1. 文本补丁（含原生块的文档）：草稿与基线 IR 对齐，仅 PATCH 变更文本/表格单元格，
 *    原生块永不重发（表格/画板原样保留）；任何结构变更 → 阻断
 * 2. 纯 markdown → 官方 convert → 清空子块 → descendant 重建
 * 3. 其余 → transformForDocsAi（表格转 markdown 表格/容器解包/数据块阻断）→ docs_ai 覆写 → 恢复标题
 * 失败一律 blocked + 中文原因（保留本地草稿语义），不改动远端。
 */
export async function pushDocumentWithStrategies(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: PushDocContext,
): Promise<PushDocOutcome> {
  const draft = input.draftMarkdown;
  const baseIr = (input.baseIr && typeof input.baseIr === "object" && "blocks" in input.baseIr)
    ? input.baseIr as import("./ir.js").FeishuDocIR
    : null;
  const hasNativeTag = containsFeishuNativeMarkdownTag(draft) || containsFeishuNativeMarkdownTag(input.baselineMarkdown);
  const hasMarkdownImage = containsMarkdownImage(draft) || containsMarkdownImage(input.baselineMarkdown);

  // 路径 1：文本补丁（含原生块文档的首选，MaomiAgent patch-executor 同款安全语义）
  if (baseIr && hasNativeTag) {
    const plan = planTextPatch({ baseIr, draftMarkdown: draft });
    if (plan.status === "ready") {
      const total = plan.operations.length + plan.inserts.length + plan.deletes.length;
      if (total === 0) {
        return { status: "blocked", message: "内容与基线一致，无需推送。" };
      }
      await executeTextPatch(client, accessToken, {
        docId: input.docId,
        baseRevisionId: plan.baseRevisionId,
        operations: plan.operations,
        inserts: plan.inserts,
        deletes: plan.deletes,
      });
      return {
        status: "succeeded",
        strategy: "text_patch",
        blockCount: total,
      };
    }
    if (plan.message !== "__no_native__") {
      return { status: "blocked", message: plan.message };
    }
    // 无原生块但标签检测命中（如基线残留）→ 走后续路径
  }

  // 纯 Markdown 重建路径（无原生标签、无图片）
  if (!hasNativeTag && !hasMarkdownImage) {
    const converted = await convertMarkdownToBlocks(client, accessToken, draft);
    if (converted.blocks.length > FEISHU_MARKDOWN_DESCENDANT_LIMIT || converted.firstLevelBlockIds.length > FEISHU_MARKDOWN_DESCENDANT_LIMIT) {
      return {
        status: "blocked",
        message: `当前文档块数量过多，单次回写暂不支持超过 ${FEISHU_MARKDOWN_DESCENDANT_LIMIT} 个块。已保留本地草稿。`,
      };
    }

    const descendants = converted.blocks.map((block) => sanitizeConvertedRawBlock(block as Record<string, unknown>));

    let revisionId = input.revisionId?.trim() || "-1";
    const currentRootChildCount = await countRootChildren(client, accessToken, input.docId);
    if (currentRootChildCount > 0) {
      const deleted = await deleteChildren(client, accessToken, {
        docId: input.docId,
        revisionId,
        startIndex: 0,
        endIndex: currentRootChildCount,
      });
      revisionId = deleted?.trim() || revisionId;
    }

    if (descendants.length > 0) {
      const created = await createDescendants(client, accessToken, {
        docId: input.docId,
        revisionId,
        childrenId: converted.firstLevelBlockIds,
        descendants,
      });
      revisionId = created?.trim() || revisionId;
  }

  return {
    status: "succeeded",
    strategy: "markdown_convert",
    revisionId: revisionId !== "-1" ? revisionId : undefined,
    blockCount: descendants.length,
  };
}

// docs_ai 安全覆写路径：transformForDocsAi 已把表格转 markdown、容器解包；数据类块已被阻断
const transform = transformForDocsAi(draft);
if (!transform.ok) {
  return { status: "blocked", message: transform.message };
}

const overwritten = await overwriteDocumentV2(client, accessToken, {
  documentToken: input.docId,
  content: transform.markdown,
  format: "markdown",
  revisionId: -1,
});
const blockedMessage = docsAiBlockedMessage(overwritten);
if (blockedMessage) {
  return { status: "blocked", message: blockedMessage };
}

await preserveDocumentTitle(client, accessToken, {
  docId: input.docId,
  title: input.title ?? "",
  revisionId: overwritten.revisionId,
});

return {
  status: "succeeded",
  strategy: "docs_ai_markdown_overwrite",
  revisionId: overwritten.revisionId,
  blockCount: overwritten.newBlocks.length,
};
}

export function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}
