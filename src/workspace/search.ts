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
