import type { FeishuDocIR, FeishuDocIRBlock } from "./ir.js";
import { normalizeFeishuDocBlocksToIR, type FeishuRawDocBlock } from "./normalizer.js";
import { feishuDocIRToSourceMarkdown } from "./markdown.js";

/**
 * 无损原生块重推（照抄 MaomiAgent feishu-doc-working-copy-compiler +
 * feishu-doc-lossless-native-block-repush）：
 * 文档含表格/多维表格/电子表格等原生块时，用基线 IR 原样保留这些块的 raw 结构，
 * 仅重写草稿中可编辑文本，再经 docs_ai 覆写实现无损回写。
 */

export type FeishuDocWorkingCopyBlockedChange = {
  blockId: string;
  reason: string;
};

export type FeishuDocWorkingCopyResult = {
  current: FeishuDocIR;
  blockedChanges: FeishuDocWorkingCopyBlockedChange[];
  preservedUnknownBlocks: string[];
};

const EDITABLE_BLOCK_PATTERN = /<!--feishu:block:([^>]+)-->([\s\S]*?)<!--\/feishu:block:\1-->/g;

/** 从草稿中提取带锚点的可编辑块文本（照抄 buildFeishuDocCurrentIR） */
export function buildFeishuDocCurrentIR(input: { base: FeishuDocIR; draft: string }): FeishuDocWorkingCopyResult {
  const current = structuredClone(input.base);
  const blockedChanges: FeishuDocWorkingCopyBlockedChange[] = [];
  const preservedUnknownBlocks = Object.values(input.base.blocks)
    .filter((block) => block.type === "undefined")
    .map((block) => block.id);

  for (const [blockId, rawBody] of extractAnchoredEditableBodies(input.draft)) {
    const block = current.blocks[blockId];
    if (!block || !block.editable) {
      continue;
    }

    const normalized = normalizeEditableBody(block.type, rawBody);
    block.text = [{ kind: "text", text: normalized, attrs: {}, raw: {} }];
  }

  for (const blockId of preservedUnknownBlocks) {
    if (!input.draft.includes(`blockId="${blockId}"`) && !input.draft.includes(`block-id="${blockId}"`)) {
      blockedChanges.push({ blockId, reason: "unsupported or unknown block removed from draft" });
    }
  }

  return {
    current,
    blockedChanges,
    preservedUnknownBlocks,
  };
}

function extractAnchoredEditableBodies(draft: string): Array<[string, string]> {
  const matches: Array<[string, string]> = [];
  for (const match of draft.matchAll(EDITABLE_BLOCK_PATTERN)) {
    const blockId = match[1]?.trim();
    if (!blockId) {
      continue;
    }
    matches.push([blockId, (match[2] ?? "").trim()]);
  }
  return matches;
}

function normalizeEditableBody(type: FeishuDocIRBlock["type"], rawBody: string): string {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return "";
  }

  if (type.startsWith("heading")) {
    return trimmed.replace(/^#{1,9}\s+/, "").trim();
  }

  switch (type) {
    case "bullet":
      return trimmed.replace(/^-\s+/, "").trim();
    case "ordered":
      return trimmed.replace(/^\d+\.\s+/, "").trim();
    case "quote":
      return trimmed
        .split(/\r?\n/)
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
    case "todo":
      return trimmed.replace(/^-\s+\[[ xX]?\]\s+/, "").trim();
    case "code": {
      const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/m.exec(trimmed);
      return fenced ? fenced[1] ?? "" : trimmed;
    }
    default:
      return trimmed;
  }
}

const LOSSLESS_NATIVE_BLOCK_TYPES = new Set<FeishuDocIRBlock["type"]>([
  "table",
  "table-cell",
  "bitable",
  "sheet",
]);

const LOSSLESS_NATIVE_BLOCK_TAG_PATTERN = /<(?:feishu-)?(?:table|table-cell|bitable|sheet)\b/i;

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
] as const;

export type FeishuDocLosslessNativeBlockRepushPlan =
  | {
      status: "blocked";
      message: string;
    }
  | {
      status: "ready";
      markdown: string;
      ir: FeishuDocIR;
      sourceBlocks: FeishuRawDocBlock[];
    };

export function shouldUseLosslessNativeBlockRepush(input: {
  draftMarkdown: string;
  baselineMarkdown?: string;
  baseIr?: FeishuDocIR | null;
}): boolean {
  if (LOSSLESS_NATIVE_BLOCK_TAG_PATTERN.test(input.draftMarkdown)) {
    return true;
  }

  if (input.baselineMarkdown && LOSSLESS_NATIVE_BLOCK_TAG_PATTERN.test(input.baselineMarkdown)) {
    return true;
  }

  return Object.values(input.baseIr?.blocks ?? {}).some((block) => LOSSLESS_NATIVE_BLOCK_TYPES.has(block.type));
}

export function buildLosslessNativeBlockRepushPlan(input: {
  docId: string;
  title: string;
  draftMarkdown: string;
  baseIr: FeishuDocIR | null;
  /** 上次拉取的原始 blocks（作为无损重写文本的载体） */
  sourceBlocks: FeishuRawDocBlock[] | null;
}): FeishuDocLosslessNativeBlockRepushPlan {
  if (!input.baseIr || !input.sourceBlocks?.length) {
    return {
      status: "blocked",
      message: "请先重新拉取远端文档基线。",
    };
  }

  if (!hasLosslessNativeBlocks(input.baseIr)) {
    return {
      status: "blocked",
      message: "当前文档不包含需要走无损重推的原生块。",
    };
  }

  const missingNativeBlockReason = ensurePreservedNativeBlocksRemainPresent({
    draftMarkdown: input.draftMarkdown,
    baseIr: input.baseIr,
  });
  if (missingNativeBlockReason) {
    return {
      status: "blocked",
      message: `当前改动超出无损重推范围：${missingNativeBlockReason}`,
    };
  }

  const compiled = buildFeishuDocCurrentIR({
    base: input.baseIr,
    draft: input.draftMarkdown,
  });
  const current = applyUnanchoredHeadingFallback({
    base: input.baseIr,
    current: compiled.current,
    draftMarkdown: input.draftMarkdown,
  });
  if (compiled.blockedChanges.length > 0) {
    return {
      status: "blocked",
      message: `当前改动超出无损重推范围：${compiled.blockedChanges[0]?.reason ?? "unsupported structure change"}`,
    };
  }

  const nextSourceBlocks = input.sourceBlocks.map((block) => rewriteRawTextBlock(block, current));

  const nextIr = normalizeFeishuDocBlocksToIR({
    documentId: input.baseIr.document.id || input.docId,
    title: input.title,
    revisionId: String(input.baseIr.document.revisionId ?? ""),
    pulledAt: new Date().toISOString(),
    documentIdType: input.baseIr.document.source.documentIdType,
    ...(input.baseIr.document.source.nodeToken ? { nodeToken: input.baseIr.document.source.nodeToken } : {}),
    blocks: nextSourceBlocks,
  });

  return {
    status: "ready",
    markdown: feishuDocIRToSourceMarkdown(nextIr),
    ir: nextIr,
    sourceBlocks: nextSourceBlocks,
  };
}

/** 无锚点草稿的一级标题回退（照抄 applyUnanchoredHeadingFallback） */
function applyUnanchoredHeadingFallback(input: {
  base: FeishuDocIR;
  current: FeishuDocIR;
  draftMarkdown: string;
}): FeishuDocIR {
  if (input.draftMarkdown.includes("<!--feishu:block:")) {
    return input.current;
  }

  const headingMatch = /^#\s+(.+)$/m.exec(input.draftMarkdown);
  if (!headingMatch?.[1]?.trim()) {
    return input.current;
  }

  const firstHeadingId = input.base.blocks[input.base.document.rootBlockId]?.children
    .map((blockId) => input.base.blocks[blockId])
    .find((block) => block?.type === "heading1")?.id;
  if (!firstHeadingId || !input.current.blocks[firstHeadingId]) {
    return input.current;
  }

  const next = structuredClone(input.current);
  next.blocks[firstHeadingId] = {
    ...next.blocks[firstHeadingId]!,
    text: [{
      kind: "text",
      text: headingMatch[1].trim(),
      attrs: {},
      raw: {},
    }],
  };
  return next;
}

function hasLosslessNativeBlocks(baseIr: FeishuDocIR): boolean {
  return Object.values(baseIr.blocks).some((block) => LOSSLESS_NATIVE_BLOCK_TYPES.has(block.type));
}

function ensurePreservedNativeBlocksRemainPresent(input: {
  draftMarkdown: string;
  baseIr: FeishuDocIR;
}): string | null {
  for (const block of Object.values(input.baseIr.blocks)) {
    if (!LOSSLESS_NATIVE_BLOCK_TYPES.has(block.type)) {
      continue;
    }

    if (
      !input.draftMarkdown.includes(`blockId="${block.id}"`)
      && !input.draftMarkdown.includes(`block-id="${block.id}"`)
    ) {
      return `native block ${block.id} was removed from draft`;
    }
  }

  return null;
}

function rewriteRawTextBlock(block: FeishuRawDocBlock, current: FeishuDocIR): FeishuRawDocBlock {
  const blockId = typeof block.block_id === "string" ? block.block_id.trim() : "";
  const currentBlock = blockId ? current.blocks[blockId] : undefined;
  if (!currentBlock?.editable) {
    return structuredClone(block);
  }

  const nextBlock = structuredClone(block);
  const nextText = currentBlock.text.map((run) => run.text).join("");
  for (const key of TEXT_CONTAINER_KEYS) {
    const container = nextBlock[key];
    if (!container || typeof container !== "object") {
      continue;
    }

    (container as { content?: string }).content = nextText;
    (container as { elements?: Array<{ text_run: { content: string } }> }).elements = [{
      text_run: {
        content: nextText,
      },
    }];
    return nextBlock;
  }

  return nextBlock;
}
