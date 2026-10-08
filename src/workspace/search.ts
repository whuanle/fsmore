import fs from "node:fs";
import { mdAbsolutePath, type NodeEntry, type WorkspaceStore } from "./store.js";

/**
 * 本地全文搜索：直接扫描已同步的 markdown 文件（对本地工作台规模足够快）。
 * 标题命中权重高，正文按出现次数计分，返回带上下文的摘要。
 */

export type SearchHit = {
  token: string;
  title: string;
  path: string;
  score: number;
  snippet: string;
};

// ---------- 标题搜索（左侧目录树用） ----------

export type TitleSearchHit = {
  token: string;
  title: string;
  objType?: string;
  synced: boolean;
  /** 根→…→文档 的 token 链（前端按层级展开树用，token 永不变化） */
  chain: string[];
  /** 根→…→文档 的标题链（前端取除末位外的部分做面包屑） */
  path: string[];
};

/**
 * 按文档标题模糊搜索已列出的索引节点（不要求已同步）。
 * 树是懒加载的，但列目录时整棵子树都会进索引，所以这里能搜到未同步的文档。
 */
export function searchDocTitles(store: WorkspaceStore, query: string, limit = 50): TitleSearchHit[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const hits: TitleSearchHit[] = [];
  for (const node of Object.values(store.nodes)) {
    if (node.kind !== "doc" || !node.docId) continue;
    const title = node.title.toLowerCase();
    if (!title.includes(normalizedQuery)) continue;
    hits.push({
      token: node.token,
      title: node.title,
      objType: node.objType,
      synced: !!node.mdPath,
      chain: store.tokenChain(node.token),
      path: store.titleChain(node.token),
    });
  }

  return hits
    .sort((a, b) => {
      const aStarts = a.title.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      const bStarts = b.title.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
      return aStarts - bStarts || a.title.localeCompare(b.title, "zh");
    })
    .slice(0, limit);
}

// ---------- 批量解析文档本地位置（MCP resolve_docs） ----------

export type ResolvedDocLocation = {
  input_type: "token" | "title";
  input: string;
  found: boolean;
  /** token 命中的唯一节点（input_type=token 时） */
  match?: {
    token: string;
    title: string;
    kind: NodeEntry["kind"];
    obj_type?: string;
    md_path?: string;
    synced: boolean;
    doc_id?: string;
    source_url?: string;
  };
  /** 标题命中的候选（input_type=title 时，精确匹配优先，最多 5 个） */
  matches?: Array<NonNullable<ResolvedDocLocation["match"]>>;
  note?: string;
};

function toLocation(node: NodeEntry): NonNullable<ResolvedDocLocation["match"]> {
  return {
    token: node.token,
    title: node.title,
    kind: node.kind,
    obj_type: node.objType,
    md_path: node.mdPath,
    synced: !!node.mdPath,
    doc_id: node.docId,
    source_url: node.remoteUrl,
  };
}

/**
 * 批量解析文档的本地位置：
 * - tokens：节点 token 或内容 doc_id 逐个精确反查索引
 * - titles：按标题匹配（精确优先，其次包含），返回候选列表
 * 只查索引不触发网络；未同步的会带提示（AI 可接着 sync_doc / search_online）。
 */
export function resolveDocLocations(
  store: WorkspaceStore,
  input: { tokens?: string[]; titles?: string[] },
): ResolvedDocLocation[] {
  const results: ResolvedDocLocation[] = [];

  for (const raw of input.tokens ?? []) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    const node = store.getNode(token)
      ?? Object.values(store.nodes).find((item) => item.docId === token);
    if (!node) {
      results.push({
        input_type: "token",
        input: token,
        found: false,
        note: "不在本地索引：可用 search_online 搜索并拉取，或 get_tree 查看已添加文档源",
      });
      continue;
    }
    const location = toLocation(node);
    results.push({
      input_type: "token",
      input: token,
      found: true,
      match: location,
      note: location.synced ? undefined : "已在索引但未同步：先 sync_doc 拉取后再 read_doc",
    });
  }

  for (const raw of input.titles ?? []) {
    const title = raw.trim();
    if (!title) {
      continue;
    }
    const lowered = title.toLowerCase();
    const docs = Object.values(store.nodes).filter((node) => node.kind === "doc" && node.docId);
    const exact = docs.filter((node) => node.title.toLowerCase() === lowered);
    const partial = exact.length > 0
      ? []
      : docs.filter((node) => node.title.toLowerCase().includes(lowered));
    const matches = [...exact, ...partial]
      .sort((a, b) => a.title.localeCompare(b.title, "zh"))
      .slice(0, 5)
      .map(toLocation);
    results.push({
      input_type: "title",
      input: title,
      found: matches.length > 0,
      matches,
      note: matches.length === 0
        ? "本地索引无此标题：可用 search_online 到飞书云端搜索"
        : matches.length > 1 ? "多个候选，按 title 确认后用对应 token" : undefined,
    });
  }

  return results;
}

export function searchDocs(store: WorkspaceStore, query: string, limit = 20): SearchHit[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const node of store.syncedDocs()) {
    if (!node.mdPath) {
      continue;
    }
    const absolute = mdAbsolutePath(node.mdPath);
    let content = "";
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    const score = scoreDocument(node, content, normalizedQuery);
    if (score > 0) {
      hits.push({
        token: node.token,
        title: node.title,
        path: node.mdPath,
        score,
        snippet: buildSnippet(content, normalizedQuery),
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function scoreDocument(node: NodeEntry, content: string, query: string): number {
  let score = 0;
  const title = node.title.toLowerCase();
  if (title.includes(query)) {
    score += 100;
  }
  if (node.mdPath?.toLowerCase().includes(query)) {
    score += 30;
  }

  const lowered = content.toLowerCase();
  let index = lowered.indexOf(query);
  let occurrences = 0;
  while (index !== -1 && occurrences < 500) {
    occurrences += 1;
    const lineStart = content.lastIndexOf("\n", index) + 1;
    const lineEnd = content.indexOf("\n", index);
    const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (line.startsWith("#")) {
      score += 5;
    }
    index = lowered.indexOf(query, index + query.length);
  }
  score += occurrences;
  return score;
}

function buildSnippet(content: string, query: string, radius = 70): string {
  const lowered = content.toLowerCase();
  const index = lowered.indexOf(query);
  if (index === -1) {
    return content.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}
