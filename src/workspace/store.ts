import fs from "node:fs";
import path from "node:path";
import { INDEX_PATH, WORKSPACE_DIR } from "../paths.js";
import type { RootKind } from "../feishu/tree.js";

/**
 * 工作区索引：roots（文档源）+ nodes（树节点与同步状态），持久化为 data/index.json。
 * markdown 文件在 data/workspace/ 下，索引记录它们的工作区相对路径（POSIX 分隔符）。
 */

export type RootEntry = {
  id: string;
  kind: RootKind;
  token: string;
  spaceId?: string;
  title: string;
  domain?: string;
  addedAt: string;
};

export type NodeKind = "space" | "wiki" | "folder" | "doc" | "other";

export type NodeEntry = {
  token: string;
  kind: NodeKind;
  rootId: string;
  parentToken: string | null;
  title: string;
  objType?: string;
  hasChild?: boolean;
  docId?: string;
  remoteUrl?: string;
  /** 同步后的 markdown 路径（工作区相对，POSIX 分隔符） */
  mdPath?: string;
  revisionId?: string;
  syncedAt?: string;
  syncError?: string;
  /** 已下载资源（工作区相对路径，POSIX） */
  assetPaths?: string[];
  childrenListedAt?: string;
};

export type FsmoreIndex = {
  version: 1;
  roots: RootEntry[];
  nodes: Record<string, NodeEntry>;
  savedAt: string;
};

function emptyIndex(): FsmoreIndex {
  return { version: 1, roots: [], nodes: {}, savedAt: new Date().toISOString() };
}

export class WorkspaceStore {
  private index: FsmoreIndex = emptyIndex();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(readonly indexPath: string = INDEX_PATH) {
    this.load();
  }

  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as FsmoreIndex;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.roots) && typeof parsed.nodes === "object") {
        this.index = parsed;
      }
    } catch {
      this.index = emptyIndex();
    }
  }

  save(): void {
    this.index.savedAt = new Date().toISOString();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.flush(), 150);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.index, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.indexPath);
  }

  // ---------- roots ----------

  get roots(): RootEntry[] {
    return this.index.roots;
  }

  getRoot(id: string): RootEntry | undefined {
    return this.index.roots.find((root) => root.id === id);
  }

  addRoot(root: RootEntry): void {
    const existing = this.index.roots.find((item) => item.token === root.token);
    if (existing) {
      Object.assign(existing, root, { id: existing.id, addedAt: existing.addedAt });
      return;
    }
    this.index.roots.push(root);
  }

  removeRoot(id: string): void {
    this.index.roots = this.index.roots.filter((root) => root.id !== id);
    for (const [token, node] of Object.entries(this.index.nodes)) {
      if (node.rootId === id) {
        delete this.index.nodes[token];
      }
    }
  }

  // ---------- nodes ----------

  getNode(token: string): NodeEntry | undefined {
    return this.index.nodes[token];
  }

  upsertNode(node: NodeEntry): void {
    this.index.nodes[node.token] = node;
  }

  get nodes(): Record<string, NodeEntry> {
    return this.index.nodes;
  }

  childrenOf(parentToken: string): NodeEntry[] {
    return Object.values(this.index.nodes).filter((node) => node.parentToken === parentToken);
  }

  nodesOfRoot(rootId: string): NodeEntry[] {
    return Object.values(this.index.nodes).filter((node) => node.rootId === rootId);
  }

  /** 从节点向上回溯到根的标题链（用于生成 markdown 路径） */
  titleChain(token: string): string[] {
    const chain: string[] = [];
    let current = this.index.nodes[token];
    let guard = 0;
    while (current && guard < 32) {
      chain.unshift(current.title);
      current = current.parentToken ? this.index.nodes[current.parentToken] : undefined;
      guard += 1;
    }
    return chain;
  }

  /** 根→…→该节点的 token 链（URL 多层路径用，token 永不变化） */
  tokenChain(token: string): string[] {
    const chain: string[] = [];
    let current = this.index.nodes[token];
    let guard = 0;
    while (current && guard < 32) {
      chain.unshift(current.token);
      current = current.parentToken ? this.index.nodes[current.parentToken] : undefined;
      guard += 1;
    }
    return chain;
  }

  /** 检查 mdPath 是否已被其他节点占用 */
  findPathOwner(mdPath: string, excludeToken: string): NodeEntry | undefined {
    return Object.values(this.index.nodes).find((node) => node.token !== excludeToken && node.mdPath === mdPath);
  }

  syncedDocs(): NodeEntry[] {
    return Object.values(this.index.nodes)
      .filter((node) => !!node.mdPath)
      .sort((a, b) => (b.syncedAt ?? "").localeCompare(a.syncedAt ?? ""));
  }

  counts(): { roots: number; nodes: number; synced: number } {
    return {
      roots: this.index.roots.length,
      nodes: Object.keys(this.index.nodes).length,
      synced: Object.values(this.index.nodes).filter((node) => !!node.mdPath).length,
    };
  }

  /**
   * 清空全部节点的同步状态（清空 .maomi 缓存后调用）。
   * 树结构（roots/节点层级）保留，文档回到未同步状态，重新同步即可恢复。
   */
  clearSyncedState(): number {
    let cleared = 0;
    for (const node of Object.values(this.index.nodes)) {
      if (node.mdPath || node.syncedAt || node.revisionId || node.syncError || node.assetPaths) {
        delete node.mdPath;
        delete node.syncedAt;
        delete node.revisionId;
        delete node.syncError;
        delete node.assetPaths;
        cleared += 1;
      }
    }
    if (cleared) {
      this.save();
    }
    return cleared;
  }
}

/** 规范化文件名（Windows/Unix 通用非法字符、控制字符、首尾点空格） */
export function sanitizeFilename(name: string, fallback = "untitled"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const noLeadingDots = cleaned.replace(/^[.\s]+/, "");
  return (noLeadingDots.slice(0, 80).trim() || fallback);
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** markdown 文件的绝对路径 */
export function mdAbsolutePath(mdPath: string): string {
  return path.join(WORKSPACE_DIR, ...mdPath.split("/"));
}

/** 资源目录（工作区相对，POSIX）：_assets/{docId} */
export function assetDirPosix(docId: string): string {
  return `_assets/${docId.replace(/[^A-Za-z0-9_-]/g, "") || "doc"}`;
}

export function assetDirAbsolute(docId: string): string {
  return path.join(WORKSPACE_DIR, ...assetDirPosix(docId).split("/"));
}

// ---------- MaomiAgent 式落库布局（token 命名，照抄 .maomi/feishu-docs） ----------
//
// <workspace>/.maomi/feishu-docs/
//   <token>.md                      当前 markdown（frontmatter + 源码 markdown）
//   baselines/<token>.base.md       基线 markdown（纯源码 markdown）
//   <token>/
//     document.ir.json              当前 IR
//     base.ir.json                  基线 IR
//     document.source.json          当前原始 blocks
//     base.source.json              基线原始 blocks

const MAOMI_DIR_NAME = ".maomi";
const FEISHU_DOCS_DIR = ".maomi/feishu-docs";
const FEISHU_BASELINES_DIR = ".maomi/feishu-docs/baselines";

/** 本地缓存根目录（工作区下 .maomi）：清空缓存的目标 */
export function maomiCacheDirAbsolute(): string {
  return path.join(WORKSPACE_DIR, MAOMI_DIR_NAME);
}

/** token → 安全目录名/文件名（token 本身是字母数字，防御性清洗） */
export function sanitizeTokenPart(token: string, fallback = "untitled-doc"): string {
  const cleaned = token.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned || fallback;
}

/** 文档 markdown（工作区相对，POSIX）：.maomi/feishu-docs/{token}.md */
export function feishuDocMarkdownPosix(token: string): string {
  return `${FEISHU_DOCS_DIR}/${sanitizeTokenPart(token)}.md`;
}

/** 基线 markdown：.maomi/feishu-docs/baselines/{token}.base.md */
export function feishuBaseMarkdownPosix(token: string): string {
  return `${FEISHU_BASELINES_DIR}/${sanitizeTokenPart(token)}.base.md`;
}

/** 文档缓存目录（IR / source json）：.maomi/feishu-docs/{token}/ */
export function feishuDocCacheDirPosix(token: string): string {
  return `${FEISHU_DOCS_DIR}/${sanitizeTokenPart(token)}`;
}

export { ensureWorkspaceDir } from "../paths.js";
