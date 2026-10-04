import type { FeishuOpenApiClient } from "./client.js";
import { openApiUrl } from "./tree.js";
import { normalizeFeishuDocBlocksToIR, type FeishuRawDocBlock } from "./normalizer.js";
import { recoverWhiteboardsInIR } from "./whiteboard.js";
import type { FeishuDocIR } from "./ir.js";

/**
 * 文档内容读取：doc meta + 全量 blocks（分页）→ IR。
 * 参考 MaomiAgent feishu-doc-tree-remote-source.readDocxDocument，
 * 改进：blocks 分页循环（>500 块的大文档）。
 */

export type DocumentMeta = {
  documentId: string;
  title: string;
  revisionId: string;
  documentIdType: "document_id" | "wiki_node_token";
};

type FeishuDocumentResponse = {
  document?: { document_id?: string; title?: string; revision_id?: string | number };
};

type FeishuDocumentBlocksResponse = {
  items?: FeishuRawDocBlock[];
  has_more?: boolean;
  page_token?: string;
};

const WIKI_FALLBACK_ERRORS = ["230027", "not found", "not_found", "bad request", "field validation", "wrong kind", "wrong-kind", "23027"];

function shouldFallbackToWiki(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return WIKI_FALLBACK_ERRORS.some((marker) => message.includes(marker));
}

function readRevisionId(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" ? value : "";
}

function ensureStableBlockIds(blocks: FeishuRawDocBlock[]): FeishuRawDocBlock[] {
  return blocks.map((block, index) => (
    typeof block.block_id === "string" && block.block_id.trim().length > 0
      ? block
      : { ...block, block_id: `block_${index + 1}` }
  ));
}

function ensureDocumentRootBlock(blocks: FeishuRawDocBlock[], documentId: string): FeishuRawDocBlock[] {
  if (blocks.length === 0) {
    return [];
  }
  const normalized = ensureStableBlockIds(blocks);
  if (normalized.some((block) => block.block_id === documentId || block.block_type === 1)) {
    return normalized;
  }

  return [
    {
      block_id: documentId,
      block_type: 1,
      children: normalized
        .map((block) => block.block_id ?? "")
        .filter((blockId): blockId is string => blockId.length > 0),
    },
    ...normalized.map((block) => (
      typeof block.parent_id === "string" && block.parent_id.trim().length > 0
        ? block
        : { ...block, parent_id: documentId }
    )),
  ];
}

/** 拉取文档 meta：优先按 document_id，若 token 实为 wiki 节点则回退 wiki_node_token */
export async function fetchDocumentMeta(
  client: FeishuOpenApiClient,
  accessToken: string,
  docToken: string,
): Promise<DocumentMeta> {
  try {
    return await fetchMetaWithIdType(client, accessToken, docToken, "document_id");
  } catch (error) {
    if (!shouldFallbackToWiki(error)) {
      throw error;
    }
    return await fetchMetaWithIdType(client, accessToken, docToken, "wiki_node_token");
  }
}

async function fetchMetaWithIdType(
  client: FeishuOpenApiClient,
  accessToken: string,
  docToken: string,
  documentIdType: "document_id" | "wiki_node_token",
): Promise<DocumentMeta> {
  const query = documentIdType === "wiki_node_token" ? { document_id_type: documentIdType } : {};
  const response = await client.getJson<FeishuDocumentResponse>(
    openApiUrl(`/docx/v1/documents/${encodeURIComponent(docToken)}`, query),
    accessToken,
  );
  const document = response.document ?? {};
  const documentId = document.document_id || docToken;
  return {
    documentId,
    title: document.title || documentId,
    revisionId: readRevisionId(document.revision_id),
    documentIdType,
  };
}

/** 全量拉取 blocks（自动分页） */
export async function fetchAllBlocks(
  client: FeishuOpenApiClient,
  accessToken: string,
  docToken: string,
  documentIdType: "document_id" | "wiki_node_token" = "document_id",
): Promise<FeishuRawDocBlock[]> {
  const blocks: FeishuRawDocBlock[] = [];
  let pageToken: string | undefined;

  do {
    const response = await client.getJson<FeishuDocumentBlocksResponse>(
      openApiUrl(`/docx/v1/documents/${encodeURIComponent(docToken)}/blocks`, {
        page_size: 500,
        document_id_type: documentIdType === "wiki_node_token" ? documentIdType : undefined,
        page_token: pageToken,
      }),
      accessToken,
    );
    blocks.push(...(response.items ?? []));
    pageToken = response.has_more ? response.page_token : undefined;
  } while (pageToken);

  return blocks;
}

/** meta + blocks → 完整 IR（meta 已在外部获取时直接传入，避免重复请求） */
export function buildDocumentIR(input: {
  meta: DocumentMeta;
  blocks: FeishuRawDocBlock[];
  nodeToken?: string;
  pulledAt?: string;
}): FeishuDocIR {
  const pulledAt = input.pulledAt ?? new Date().toISOString();
  const rawBlocks = input.blocks;
  const blocks = ensureDocumentRootBlock(rawBlocks, input.meta.documentId);
  return normalizeFeishuDocBlocksToIR({
    documentId: input.meta.documentId,
    title: input.meta.title,
    revisionId: input.meta.revisionId,
    pulledAt,
    documentIdType: input.meta.documentIdType,
    nodeToken: input.nodeToken,
    blocks,
  });
}

/** 一步到位：拉取整篇文档（含白板 mermaid 可逆恢复），同时返回原始 blocks（作为无损重推基线） */
export async function fetchDocumentIR(
  client: FeishuOpenApiClient,
  accessToken: string,
  docToken: string,
  options: { nodeToken?: string; meta?: DocumentMeta } = {},
): Promise<{ ir: FeishuDocIR; blocks: FeishuRawDocBlock[] }> {
  const meta = options.meta ?? await fetchDocumentMeta(client, accessToken, docToken);
  const blocks = await fetchAllBlocks(client, accessToken, docToken, meta.documentIdType);
  const ir = buildDocumentIR({ meta, blocks, nodeToken: options.nodeToken });
  const recovered = await recoverWhiteboardsInIR(client, accessToken, ir);
  return { ir: recovered, blocks };
}
