import type { FeishuOpenApiClient } from "./client.js";
import { openApiUrl } from "./tree.js";

/**
 * 飞书云端文档搜索（搜索云文档 v2）：
 * POST /search/v2/doc_wiki/search，scope search:docs:read，
 * user_access_token / tenant_access_token 均可，搜索范围是「当前用户可见」的云文档与知识库。
 * 限流 100 次/分钟；query 最长 30 字符；page_size 0~20。
 */

export type OnlineDocHit = {
  /** DOC = 云文档（token 即 document_id）；WIKI = 知识库节点（token 为 node token，需解析 obj_token） */
  entity_type: "DOC" | "WIKI";
  title: string;
  summary?: string;
  token: string;
  doc_types: string[];
  url?: string;
  owner_name?: string;
  update_time?: string;
  /** fsmore 可同步（docx 文档或 wiki 节点） */
  syncable: boolean;
};

export type OnlineSearchResult = {
  hits: OnlineDocHit[];
  total: number;
  has_more: boolean;
  page_token?: string;
};

type ResUnit = {
  title_highlighted?: string;
  summary_highlighted?: string;
  entity_type?: string;
  result_meta?: {
    token?: string;
    doc_types?: string[];
    update_time?: string | number;
    url?: string;
    owner_name?: string;
  };
};

type SearchResponse = {
  total?: number;
  has_more?: boolean;
  page_token?: string;
  res_units?: ResUnit[];
};

/** 飞书返回的高亮标记 <em>…</em> 去掉，保留纯文本 */
function stripHighlight(value: string | undefined): string {
  return (value ?? "").replace(/<\/?em[^>]*>/g, "").trim();
}

function toIsoTime(value: string | number | undefined): string | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : String(value);
}

/** docx 文档才是 fsmore 当前管线支持的类型（旧版 doc / sheet / bitable 等暂不可同步） */
export function isSyncableDocType(entityType: string, docTypes: string[]): boolean {
  const types = new Set(docTypes.map((type) => type.toUpperCase()));
  if (entityType === "WIKI") {
    return true; // wiki 节点内容多为 docx，解析 obj_type 后再判定
  }
  return types.has("DOCX");
}

export function toOnlineDocHit(unit: ResUnit): OnlineDocHit | null {
  const meta = unit.result_meta ?? {};
  const token = meta.token ?? "";
  if (!token) {
    return null;
  }
  const entityType = unit.entity_type === "WIKI" ? "WIKI" : "DOC";
  const docTypes = meta.doc_types ?? [];
  return {
    entity_type: entityType,
    title: stripHighlight(unit.title_highlighted) || token,
    summary: stripHighlight(unit.summary_highlighted) || undefined,
    token,
    doc_types: docTypes,
    url: meta.url || undefined,
    owner_name: meta.owner_name || undefined,
    update_time: toIsoTime(meta.update_time),
    syncable: isSyncableDocType(entityType, docTypes),
  };
}

/** 排序方式：默认相关度，或按编辑/创建/最近打开时间 */
export type OnlineSearchSort = "relevance" | "edited" | "created" | "opened";

const SORT_TYPE_MAP: Record<OnlineSearchSort, string> = {
  relevance: "DEFAULT_TYPE",
  edited: "EDIT_TIME",
  created: "CREATE_TIME",
  opened: "OPEN_TIME",
};

export async function searchOnlineDocs(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { query: string; pageSize?: number; pageToken?: string; sort?: OnlineSearchSort },
): Promise<OnlineSearchResult> {
  const query = input.query.trim();
  if (!query) {
    throw new Error("搜索关键词不能为空");
  }
  if (query.length > 30) {
    throw new Error("搜索关键词过长（飞书限制 30 字符以内）");
  }

  const filter = input.sort && input.sort !== "relevance"
    ? { sort_type: SORT_TYPE_MAP[input.sort] }
    : {};
  const data = await client.postJson<SearchResponse>(
    openApiUrl("/search/v2/doc_wiki/search"),
    accessToken,
    {
      query,
      // 接口要求至少一个筛选器：云文档与知识库都搜（空对象表示不额外过滤）
      doc_filter: filter,
      wiki_filter: filter,
      page_size: Math.max(1, Math.min(20, input.pageSize ?? 10)),
      page_token: input.pageToken || undefined,
    },
  );

  const hits = (data.res_units ?? [])
    .map(toOnlineDocHit)
    .filter((hit): hit is OnlineDocHit => hit !== null);
  return {
    hits,
    total: data.total ?? hits.length,
    has_more: data.has_more === true,
    page_token: data.has_more ? data.page_token : undefined,
  };
}
