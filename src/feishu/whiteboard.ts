import { createHash } from "node:crypto";
import type { FeishuOpenApiClient } from "./client.js";
import { openApiUrl } from "./tree.js";
import type { FeishuDocIR, FeishuDocIRAsset, FeishuDocIRBlock, FeishuDocIRReversibleAsset } from "./ir.js";

/**
 * 白板可逆恢复与增量回写（照抄 MaomiAgent feishu-doc-whiteboard-reversible 与
 * feishu-doc-remote-whiteboard-api）：白板代码导出为 mermaid 后，
 * 本地编辑 mermaid 围栏即可增量回写白板，无需整文覆盖。
 */

const REVERSIBLE_MERMAID_COUNT_CHANGED_MESSAGE = "当前文档的 Mermaid 白板数量已变化，暂不支持安全回写。已保留本地草稿。";
const REVERSIBLE_MERMAID_ORDER_CHANGED_MESSAGE = "当前文档的 Mermaid 白板顺序已变化，暂不支持安全回写。已保留本地草稿。";

export const REVERSIBLE_MERMAID_BLOCK_MESSAGES = {
  countChanged: REVERSIBLE_MERMAID_COUNT_CHANGED_MESSAGE,
  orderChanged: REVERSIBLE_MERMAID_ORDER_CHANGED_MESSAGE,
} as const;

export type RecoveredMermaidWhiteboard = {
  whiteboardToken: string;
  format: "mermaid";
  source: string;
  origin: FeishuDocIRReversibleAsset["origin"];
  resolvedAt: string;
};

export type MermaidFence = {
  start: number;
  end: number;
  source: string;
};

export type ReversibleMermaidPushPlanNone = { kind: "none" };
export type ReversibleMermaidPushPlanBlocked = { kind: "blocked"; message: string };
export type ReversibleMermaidPushPlanUpdate = {
  kind: "update";
  documentMarkdown: string;
  changedWhiteboards: Array<{
    whiteboardToken: string;
    source: string;
    sourceChecksum: string;
    ordinal: number;
  }>;
};

export type ReversibleMermaidPushPlan =
  | ReversibleMermaidPushPlanNone
  | ReversibleMermaidPushPlanBlocked
  | ReversibleMermaidPushPlanUpdate;

export function computeReversibleSourceChecksum(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function applyRecoveredMermaidWhiteboards(input: {
  ir: FeishuDocIR;
  recovered: RecoveredMermaidWhiteboard[];
}): FeishuDocIR {
  const ordinalByToken = getWhiteboardOrdinalByToken(input.ir);
  const nextAssets = { ...input.ir.assets };

  for (const entry of input.recovered) {
    const asset = nextAssets[entry.whiteboardToken];
    const ordinal = ordinalByToken.get(entry.whiteboardToken);
    if (!asset || ordinal === undefined) {
      continue;
    }

    nextAssets[entry.whiteboardToken] = {
      ...asset,
      reversible: {
        format: entry.format,
        source: entry.source,
        sourceChecksum: computeReversibleSourceChecksum(entry.source),
        ordinal,
        origin: entry.origin,
        state: "mermaid",
        lastResolvedAt: entry.resolvedAt,
      },
    };
  }

  return {
    ...input.ir,
    assets: nextAssets,
  };
}

export function isReversibleMermaidAsset(
  asset: FeishuDocIRAsset | undefined,
): asset is FeishuDocIRAsset & { reversible: FeishuDocIRReversibleAsset } {
  return asset?.reversible?.format === "mermaid"
    && asset.reversible.state === "mermaid";
}

export function parseMermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const pattern = /```[ \t]*mermaid[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    fences.push({
      start: match.index,
      end: match.index + match[0].length,
      source: match[1] ?? "",
    });
  }

  return fences;
}

export function buildReversibleMermaidPushPlan(input: {
  draftMarkdown: string;
  baseIr: FeishuDocIR;
}): ReversibleMermaidPushPlan {
  const assets = Object.values(input.baseIr.assets)
    .filter(isReversibleMermaidAsset)
    .sort((left, right) => left.reversible.ordinal - right.reversible.ordinal);

  if (assets.length === 0) {
    return { kind: "none" };
  }

  const fences = parseMermaidFences(input.draftMarkdown);
  if (fences.length !== assets.length) {
    return {
      kind: "blocked",
      message: REVERSIBLE_MERMAID_COUNT_CHANGED_MESSAGE,
    };
  }

  const originalOrdinalsByChecksum = new Map<string, number[]>();
  for (const asset of assets) {
    const current = originalOrdinalsByChecksum.get(asset.reversible.sourceChecksum);
    if (current) {
      current.push(asset.reversible.ordinal);
      continue;
    }
    originalOrdinalsByChecksum.set(asset.reversible.sourceChecksum, [asset.reversible.ordinal]);
  }

  for (let index = 0; index < fences.length; index += 1) {
    const fence = fences[index];
    if (!fence) {
      continue;
    }

    const originalMatches = originalOrdinalsByChecksum.get(computeReversibleSourceChecksum(fence.source));
    const originalOrdinal = originalMatches?.shift();
    if (originalOrdinal !== undefined && originalOrdinal !== index) {
      return {
        kind: "blocked",
        message: REVERSIBLE_MERMAID_ORDER_CHANGED_MESSAGE,
      };
    }
  }

  let documentMarkdown = input.draftMarkdown;
  const changedWhiteboards: ReversibleMermaidPushPlanUpdate["changedWhiteboards"] = [];

  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const fence = fences[index];
    const asset = assets[index];
    if (!fence || !asset || asset.reversible.ordinal !== index) {
      return {
        kind: "blocked",
        message: REVERSIBLE_MERMAID_ORDER_CHANGED_MESSAGE,
      };
    }

    documentMarkdown = `${documentMarkdown.slice(0, fence.start)}<whiteboard token="${asset.token}" />${documentMarkdown.slice(fence.end)}`;

    const sourceChecksum = computeReversibleSourceChecksum(fence.source);
    if (sourceChecksum !== asset.reversible.sourceChecksum) {
      changedWhiteboards.unshift({
        whiteboardToken: asset.token,
        source: fence.source,
        sourceChecksum,
        ordinal: index,
      });
    }
  }

  return {
    kind: "update",
    documentMarkdown,
    changedWhiteboards,
  };
}

export function applyReversibleMermaidPushResult(input: {
  ir: FeishuDocIR;
  changedWhiteboards: Array<{
    whiteboardToken: string;
    source: string;
    sourceChecksum: string;
  }>;
  pushedAt: string;
}): FeishuDocIR {
  if (input.changedWhiteboards.length === 0) {
    return input.ir;
  }

  const changedByToken = new Map(input.changedWhiteboards.map((entry) => [entry.whiteboardToken, entry]));
  const nextAssets = Object.fromEntries(
    Object.entries(input.ir.assets).map(([token, asset]) => {
      const changed = changedByToken.get(token);
      if (!changed || !isReversibleMermaidAsset(asset)) {
        return [token, asset];
      }

      return [token, {
        ...asset,
        reversible: {
          ...asset.reversible,
          source: changed.source,
          sourceChecksum: changed.sourceChecksum,
          state: "mermaid" as const,
          lastResolvedAt: input.pushedAt,
          lastError: undefined,
        },
      }];
    }),
  ) as FeishuDocIR["assets"];

  return {
    ...input.ir,
    assets: nextAssets,
  };
}

function getWhiteboardOrdinalByToken(ir: FeishuDocIR): Map<string, number> {
  const ordinals = new Map<string, number>();
  const visited = new Set<string>();
  let ordinal = 0;

  walkBlocks(ir, ir.document.rootBlockId, visited, (block) => {
    if (!isWhiteboardLike(block) || !block.resource?.token || ordinals.has(block.resource.token)) {
      return;
    }

    ordinals.set(block.resource.token, ordinal);
    ordinal += 1;
  });

  return ordinals;
}

function walkBlocks(
  ir: FeishuDocIR,
  blockId: string,
  visited: Set<string>,
  visit: (block: FeishuDocIRBlock) => void,
): void {
  if (visited.has(blockId)) {
    return;
  }
  visited.add(blockId);

  const block = ir.blocks[blockId];
  if (!block) {
    return;
  }

  visit(block);
  for (const childId of block.children) {
    walkBlocks(ir, childId, visited, visit);
  }
}

function isWhiteboardLike(block: FeishuDocIRBlock): boolean {
  return block.type === "whiteboard" || block.type === "board" || block.type === "diagram";
}

// ---------- 白板 API（照抄 feishu-doc-remote-whiteboard-api） ----------

type WhiteboardCodeResponse = {
  format?: string;
  output_format?: string;
  source?: string;
  code?: string;
  content?: string;
};

type WhiteboardUpdateResponse = {
  result?: string;
};

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const MERMAID_SOURCE_MARKERS = [
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

/** 判断导出的白板代码是否像 mermaid 源码（照抄 looksLikeMermaidSource） */
export function looksLikeMermaidSource(source: string): boolean {
  const normalized = source.trimStart();
  if (!normalized) {
    return false;
  }
  return MERMAID_SOURCE_MARKERS.some((marker) => normalized.startsWith(marker));
}

/**
 * 拉取后的白板可逆恢复（照抄 reverseWhiteboardsInIR）：
 * 对文档内白板逐个尝试代码导出，mermaid 源码写入 IR 的 reversible 字段。
 */
export async function recoverWhiteboardsInIR(
  client: FeishuOpenApiClient,
  accessToken: string,
  ir: FeishuDocIR,
): Promise<FeishuDocIR> {
  const tokens = [...new Set(
    Object.values(ir.blocks)
      .filter((block) => block.type === "whiteboard" || block.type === "board" || block.type === "diagram" || block.type === "mindnote")
      .filter((block) => !!block.resource?.token && !ir.assets[block.resource.token]?.reversible)
      .map((block) => block.resource!.token),
  )];
  if (tokens.length === 0) {
    return ir;
  }

  const recovered: RecoveredMermaidWhiteboard[] = [];
  for (const token of tokens) {
    try {
      const result = await queryWhiteboardCode(client, accessToken, token);
      if (!result) {
        continue;
      }
      const format = result.format.trim().toLowerCase();
      if (format && format !== "mermaid" && format !== "unknown") {
        continue;
      }
      const source = result.source.trim();
      if (!source || (format !== "mermaid" && !looksLikeMermaidSource(source))) {
        continue;
      }
      recovered.push({
        whiteboardToken: token,
        format: "mermaid",
        source,
        origin: "whiteboard_code_export",
        resolvedAt: new Date().toISOString(),
      });
    } catch {
      // 单个白板恢复失败不影响整篇文档（回退为 <whiteboard token> 组件）
    }
  }

  return recovered.length > 0
    ? applyRecoveredMermaidWhiteboards({ ir, recovered })
    : ir;
}

/** 白板代码导出（mermaid 等格式），无可导出内容时返回 null */
export async function queryWhiteboardCode(
  client: FeishuOpenApiClient,
  accessToken: string,
  whiteboardToken: string,
): Promise<{ format: string; source: string } | null> {
  const url = openApiUrl(`/board/v1/whiteboards/${encodeURIComponent(whiteboardToken)}/nodes`, {
    output_as: "code",
  });

  const response = await client.getJson<WhiteboardCodeResponse>(url, accessToken);
  const source = trimText(response.source) || trimText(response.code) || trimText(response.content);
  if (!source) {
    return null;
  }

  return {
    format: trimText(response.format) || trimText(response.output_format) || "unknown",
    source,
  };
}

/** 用 mermaid 源码覆盖白板内容（增量回写白板时使用） */
export async function updateWhiteboardWithMermaid(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { whiteboardToken: string; source: string; overwrite: boolean },
): Promise<{ result: string }> {
  const url = openApiUrl(`/board/v1/whiteboards/${encodeURIComponent(input.whiteboardToken)}/nodes`, {
    idempotent_token: createHash("sha256").update(`${input.whiteboardToken}:${input.source}:${Date.now()}`).digest("hex").slice(0, 32),
  });

  const response = await client.postJson<WhiteboardUpdateResponse>(url, accessToken, {
    input_format: "mermaid",
    source: input.source,
    overwrite: input.overwrite,
  });

  return {
    result: trimText(response.result) || "success",
  };
}
