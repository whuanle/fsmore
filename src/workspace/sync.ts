import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { FeishuOpenApiClient } from "../feishu/client.js";
import type { FeishuTokenManager } from "../feishu/client.js";
import { fetchAllBlocks, fetchDocumentIR, fetchDocumentMeta } from "../feishu/doc-reader.js";
import { downloadAsset } from "../feishu/assets.js";
import { listChildren, openApiUrl, recognizeRoot, resolveWikiNode, buildRemoteUrl, SYNCABLE_OBJ_TYPES, type RemoteNode, type RootKind } from "../feishu/tree.js";
import { searchOnlineDocs, type OnlineSearchResult, type OnlineSearchSort } from "../feishu/search.js";
import { describeFeishuError } from "../feishu/errors.js";
import { FEISHU_MARKDOWN_RENDER_VERSION, feishuDocIRToSourceMarkdown } from "../feishu/markdown.js";
import { updateWhiteboardWithMermaid } from "../feishu/whiteboard.js";
import {
  pushDocumentWithStrategies,
  stripFrontMatter,
} from "../feishu/writer.js";
import type { FeishuDocIR } from "../feishu/ir.js";
import type { FeishuRawDocBlock } from "../feishu/normalizer.js";
import { DATA_DIR, WORKSPACE_DIR } from "../paths.js";
import type { JobManager } from "../jobs.js";

/** 回写基线（照抄 MaomiAgent base IR / base markdown / raw source 语义） */
export type DocBaseline = {
  ir: FeishuDocIR;
  markdown: string;
  sourceBlocks: FeishuRawDocBlock[];
  revisionId: string;
  savedAt: string;
};
import {
  assetDirAbsolute,
  assetDirPosix,
  ensureWorkspaceDir,
  feishuBaseMarkdownPosix,
  feishuDocCacheDirPosix,
  feishuDocMarkdownPosix,
  mdAbsolutePath,
  toPosix,
  type NodeEntry,
  type WorkspaceStore,
} from "./store.js";

/**
 * 同步引擎：
 * - 单文档同步：meta（revision 比对跳过）→ blocks → IR → 资源下载 → markdown 落盘
 * - 空间/根同步：先确保树已列出，再并发同步所有文档（revision 未变则秒跳）
 */

export type SyncDocResult = {
  token: string;
  title: string;
  mdPath: string;
  changed: boolean;
  skipped: boolean;
  assets: number;
  revisionId: string;
};

/** 「在线搜索」虚拟文档源：搜索命中后拉取的文档都挂在它下面（固定 id，避免重复创建） */
export const ONLINE_SEARCH_ROOT_ID = "online-search";

/** 「新建文档」虚拟文档源：create_doc 建在「我的空间」（无归属文档源）的文档挂在这里 */
export const CREATED_DOCS_ROOT_ID = "created-docs";

/** get_tree 单次返回的节点数上限（防大知识库撑爆 AI 上下文；截断时 truncated=true，可换 token 分段取） */
export const TREE_VIEW_NODE_LIMIT = 500;

/** 目录树节点视图（get_tree 返回结构） */
export type TreeNodeView = {
  token: string;
  kind: "space" | "wiki" | "folder" | "doc" | "other";
  title: string;
  obj_type?: string;
  has_child: boolean;
  doc_id?: string;
  url?: string;
  synced: boolean;
  md_path?: string;
  sync_error?: string;
  children_listed: boolean;
  /** 列子树失败时的错误信息（该节点作为叶子返回） */
  list_error?: string;
  children?: TreeNodeView[];
};

export class SyncEngine {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly client: FeishuOpenApiClient,
    private readonly tokens: FeishuTokenManager,
    private readonly store: WorkspaceStore,
    private readonly jobs: JobManager,
  ) {}

  // ---------- 树列出 ----------

  /** 确保某个根（或节点）的整棵子树都已拉取到索引（BFS，带上限保护） */
  async ensureTreeListed(input: { rootId: string; startToken: string; kind: RootKind; spaceId?: string; domain?: string; jobId?: string; maxNodes?: number }): Promise<number> {
    const maxNodes = input.maxNodes ?? 3000;
    let listed = 0;
    const queue: Array<{ token: string; kind: RootKind; spaceId?: string; domain?: string }> = [
      { token: input.startToken, kind: input.kind, spaceId: input.spaceId, domain: input.domain },
    ];

    while (queue.length > 0 && listed < maxNodes) {
      const current = queue.shift()!;
      if (this.store.getNode(current.token)?.childrenListedAt) {
        // 已列出过：直接把索引里的子节点入队（不重复请求远端）
        for (const child of this.store.childrenOf(current.token)) {
          if (canHaveChildren(child)) {
            queue.push({ token: child.token, kind: child.kind === "folder" ? "folder" : "wiki_node", spaceId: child.kind === "folder" ? undefined : input.spaceId, domain: input.domain });
          }
        }
        continue;
      }

      const children = await this.tokens.withToken((accessToken) =>
        listChildren(this.client, accessToken, {
          kind: current.kind,
          token: current.token,
          spaceId: current.spaceId,
          domain: current.domain,
        }));
      listed += 1;
      this.upsertRemoteChildren(input.rootId, current.token, children);
      for (const child of children) {
        if (child.hasChild || child.kind === "folder") {
          queue.push({
            token: child.token,
            kind: child.kind === "folder" ? "folder" : "wiki_node",
            spaceId: current.spaceId,
            domain: current.domain,
          });
        }
      }
      const listedNode = this.store.getNode(current.token);
      if (listedNode) {
        listedNode.childrenListedAt = new Date().toISOString();
      }
      this.store.save();
      if (input.jobId) {
        this.jobs.log(input.jobId, `已列出 ${current.token} 的 ${children.length} 个子节点`);
      }
    }

    this.store.save();
    return listed;
  }

  /** 远端子节点写入索引（保留原有同步状态），ensureTreeListed 与按层列树共用 */
  private upsertRemoteChildren(rootId: string, parentToken: string, children: RemoteNode[]): void {
    for (const child of children) {
      const prev = this.store.getNode(child.token);
      this.store.upsertNode({
        token: child.token,
        kind: child.kind === "wiki" ? "wiki" : child.kind,
        rootId,
        parentToken,
        title: child.title,
        objType: child.objType ?? prev?.objType,
        hasChild: child.hasChild || child.kind === "folder",
        docId: child.docId ?? prev?.docId,
        remoteUrl: child.remoteUrl ?? prev?.remoteUrl,
        mdPath: prev?.mdPath,
        revisionId: prev?.revisionId,
        syncedAt: prev?.syncedAt,
      });
    }
  }

  /**
   * 列出一个节点的直接子节点：缓存优先，未列出过时向远端拉取一次并写入索引。
   * 返回列出的子节点数（缓存命中返回 0）。
   */
  async ensureChildrenListed(token: string): Promise<number> {
    const node = this.store.getNode(token);
    if (!node) {
      throw new Error(`索引中不存在节点：${token}（可用 list_spaces 查看文档源，或 get_tree 从头展开）`);
    }
    if (node.childrenListedAt || !canHaveChildren(node)) {
      return 0;
    }
    const root = this.store.getRoot(node.rootId);
    if (!root) {
      throw new Error(`节点所属文档源已被删除：${token}`);
    }
    const isRoot = root.token === token;
    const kind: RootKind = node.kind === "folder" ? "folder" : isRoot ? root.kind : "wiki_node";
    const children = await this.tokens.withToken((accessToken) =>
      listChildren(this.client, accessToken, {
        kind,
        token,
        spaceId: root.spaceId,
        domain: root.domain,
      }));
    this.upsertRemoteChildren(root.id, token, children);
    node.childrenListedAt = new Date().toISOString();
    this.store.save();
    return children.length;
  }

  // ---------- 目录树视图（MCP get_tree） ----------

  /**
   * 获取目录树：不传参数返回全部文档源顶层，传 space_id 限定某个文档源，
   * 传 token 从指定节点位置展开。默认 depth=3、未列出的节点自动向远端拉取一层。
   */
  async getTree(input: { token?: string; spaceId?: string; depth?: number; listRemote?: boolean } = {}): Promise<{ truncated: boolean; nodes: TreeNodeView[] }> {
    const depth = Math.max(1, Math.min(10, Math.floor(input.depth ?? 3)));
    const listRemote = input.listRemote !== false;

    let starts: NodeEntry[];
    if (input.token) {
      const node = this.store.getNode(input.token) ?? this.findByDocId(input.token);
      if (!node) {
        throw new Error(`索引中不存在节点：${input.token}（用 list_spaces 查看文档源，或不带参数 get_tree 返回全部文档源顶层）`);
      }
      starts = [node];
    } else if (input.spaceId) {
      const root = this.store.getRoot(input.spaceId);
      const rootNode = root ? this.store.getNode(root.token) : undefined;
      if (!rootNode) {
        throw new Error(`文档源不存在：${input.spaceId}（用 list_spaces 查看已添加的文档源）`);
      }
      starts = [rootNode];
    } else {
      starts = this.store.roots
        .map((root) => this.store.getNode(root.token))
        .filter((node): node is NodeEntry => !!node);
    }

    let emitted = 0;
    let truncated = false;
    const build = async (node: NodeEntry, level: number): Promise<TreeNodeView> => {
      emitted += 1;
      const view: TreeNodeView = {
        token: node.token,
        kind: node.kind,
        title: node.title,
        obj_type: node.objType,
        has_child: canHaveChildren(node),
        doc_id: node.docId,
        url: node.remoteUrl,
        synced: !!node.mdPath,
        md_path: node.mdPath,
        sync_error: node.syncError,
        children_listed: !!node.childrenListedAt,
      };
      if (level >= depth || !canHaveChildren(node)) {
        return view;
      }
      if (listRemote && !node.childrenListedAt) {
        try {
          await this.ensureChildrenListed(node.token);
          view.children_listed = true;
        } catch (error) {
          // 列子树失败不中断整棵树：该节点作为叶子返回并携带错误
          view.list_error = describeFeishuError(error);
          return view;
        }
      }
      if (!node.childrenListedAt) {
        // 本地未列出且不拉远端：子级未知，作为叶子返回（children 为空数组会误读成空文件夹）
        return view;
      }
      const children = this.store.childrenOf(node.token)
        .sort((a, b) => a.title.localeCompare(b.title, "zh"));
      view.children = [];
      for (const child of children) {
        if (emitted >= TREE_VIEW_NODE_LIMIT) {
          truncated = true;
          break;
        }
        view.children.push(await build(child, level + 1));
      }
      return view;
    };

    const nodes: TreeNodeView[] = [];
    for (const start of starts) {
      if (emitted >= TREE_VIEW_NODE_LIMIT) {
        truncated = true;
        break;
      }
      nodes.push(await build(start, 1));
    }
    return { truncated, nodes };
  }

  /** token 反查：先按节点 token，再按内容 doc_id 兜底 */
  private findByDocId(tokenOrDocId: string): NodeEntry | undefined {
    return Object.values(this.store.nodes).find((node) => node.docId === tokenOrDocId);
  }

  // ---------- 单文档同步 ----------

  async syncDoc(token: string, options: { force?: boolean } = {}): Promise<SyncDocResult> {
    const node = this.store.getNode(token);
    if (!node) {
      throw new Error(`文档不在工作台索引中：${token}，请先在文档树中拉取/添加`);
    }
    if (node.kind === "other" || !node.docId) {
      throw new Error(`该节点不是可同步的飞书文档（类型：${node.objType ?? node.kind}）`);
    }

    ensureWorkspaceDir();
    // 全部以用户角色请求（未授权时回退应用身份），令牌临近过期自动刷新重试
    const docId: string = node.docId;
    const meta = await this.tokens.withToken((accessToken) => fetchDocumentMeta(this.client, accessToken, docId));

    if (
      !options.force
      && node.revisionId
      && node.revisionId === meta.revisionId
      && node.mdPath
      && fs.existsSync(mdAbsolutePath(node.mdPath))
      && !this.mdNeedsRerender(node.mdPath)
    ) {
      return {
        token,
        title: node.title,
        mdPath: node.mdPath,
        changed: false,
        skipped: true,
        assets: node.assetPaths?.length ?? 0,
        revisionId: meta.revisionId,
      };
    }

    // 本地保护（MaomiAgent 草稿语义）：本地文件相对基线有未推送的修改时，拒绝用云端覆盖，除非 force
    if (!options.force && node.mdPath) {
      const localFile = mdAbsolutePath(node.mdPath);
      if (fs.existsSync(localFile)) {
        const localBody = stripFrontMatter(fs.readFileSync(localFile, "utf8")).trim();
        const baseline = this.readBaseline(token);
        if (baseline && localBody && localBody !== baseline.markdown.trim()) {
          throw new Error(
            "本地文档有未推送的修改，同步会覆盖这些修改。请先「推送回飞书」保存你的改动，"
            + "或确认放弃本地修改后再次同步（会提示强制覆盖）。",
          );
        }
      }
    }

    const { ir, blocks: sourceBlocks } = await this.tokens.withToken((accessToken) =>
      fetchDocumentIR(this.client, accessToken, docId, { meta, nodeToken: node.kind === "wiki" ? token : undefined }));
    const previousMdPath = node.mdPath;
    const mdPath = this.resolveMarkdownPath(node);
    const { md, assetPaths } = await this.hydrateAssetsAndRenderMarkdown(ir);
    const absolute = mdAbsolutePath(mdPath);
    const syncedAt = new Date().toISOString();
    const frontMatter = [
      "---",
      `title: ${JSON.stringify(meta.title || node.title)}`,
      "source: feishu",
      `source_url: ${node.remoteUrl ?? ""}`,
      `feishu_token: ${node.token}`,
      `feishu_doc_id: ${ir.document.id}`,
      `revision_id: ${meta.revisionId}`,
      `render_version: ${FEISHU_MARKDOWN_RENDER_VERSION}`,
      `synced_at: ${syncedAt}`,
      "---",
      "",
    ].join("\n");

    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${frontMatter}\n${md}`, "utf8");

    // 持久化回写基线（照抄 MaomiAgent 的 base IR/base markdown/raw source 落库布局，按 token 命名）：
    // 推送策略、无损重推与白板增量判定都依赖「上次拉取」的 IR、markdown 与原始 blocks
    this.writeBaseline(token, { ir, markdown: md, sourceBlocks, revisionId: meta.revisionId, savedAt: syncedAt });

    // 从旧标题路径布局迁移：删除同一文档的旧 md 副本
    this.migrateLegacyMarkdown(previousMdPath, mdPath);

    node.mdPath = mdPath;
    node.revisionId = meta.revisionId;
    node.syncedAt = syncedAt;
    node.title = meta.title || node.title;
    node.syncError = undefined;
    node.assetPaths = assetPaths;
    this.store.upsertNode(node);
    this.store.save();

    return {
      token,
      title: node.title,
      mdPath,
      changed: true,
      skipped: false,
      assets: assetPaths.length,
      revisionId: meta.revisionId,
    };
  }

  /** 下载文档内图片/白板图片资源（供 web 渲染按 token 映射本地文件） */
  private async hydrateAssetsAndRenderMarkdown(ir: FeishuDocIR): Promise<{ md: string; assetPaths: string[] }> {
    const assetsDirAbsolute = assetDirAbsolute(ir.document.id);
    const assetsDirPosixValue = assetDirPosix(ir.document.id);
    const assetTokens = Object.values(ir.assets);
    const assetPaths: string[] = [];

    // 画板类（whiteboard/mindnote/diagram）走 download_as_image，飞书限流严格（99991400）：
    // 单独低并发 + 限流自动退避重试；普通图片/附件维持原并发
    const isBoardKind = (kind: string) => kind === "whiteboard" || kind === "mindnote" || kind === "diagram";
    const boardAssets = assetTokens.filter((asset) => isBoardKind(asset.kind));
    const otherAssets = assetTokens.filter((asset) => !isBoardKind(asset.kind));

    const downloadOne = async (asset: (typeof assetTokens)[number], allowRateLimitRetry: boolean): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await this.tokens.withToken((accessToken) => downloadAsset({
            client: this.client,
            accessToken,
            token: asset.token,
            kind: asset.kind,
            destDir: assetsDirAbsolute,
          }));
          assetPaths.push(toPosix(path.join(assetsDirPosixValue, result.fileName)));
          asset.localPath = toPosix(path.join(assetsDirPosixValue, result.fileName));
          asset.status = "cached";
          asset.mime = result.mime;
          asset.bytes = result.bytes;
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const rateLimited = message.includes("99991400") || message.includes("frequency limit") || message.includes("触发飞书接口限流");
          if (allowRateLimitRetry && rateLimited && attempt < 4) {
            // 指数退避 + 抖动：~1.5s / 3s / 6s / 12s
            await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt + Math.random() * 500));
            continue;
          }
          asset.status = "error";
          asset.error = message;
          return;
        }
      }
    };

    const runPool = async (items: typeof assetTokens, concurrency: number, allowRateLimitRetry: boolean): Promise<void> => {
      let cursor = 0;
      const workers = Array.from({ length: Math.max(0, Math.min(concurrency, items.length)) }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const asset = items[index];
          if (!asset) {
            return;
          }
          await downloadOne(asset, allowRateLimitRetry);
        }
      });
      await Promise.all(workers);
    };

    const otherConcurrency = Math.max(1, Math.min(6, this.getConfig().syncConcurrency + 2));
    await Promise.all([
      runPool(otherAssets, otherConcurrency, false),
      runPool(boardAssets, 2, true),
    ]);

    // 照抄 MaomiAgent 源码 markdown 编解码：原生标签 + 可逆白板 mermaid 围栏
    const rendered = feishuDocIRToSourceMarkdown(ir);
    return { md: rendered, assetPaths };
  }

  /**
   * 本地 md 是否需要重新拉取渲染：
   * - 渲染器版本落后（渲染语义修复后旧文件必须重渲染一次，否则 revision 未变时永远跳过）
   * - markdown 里引用的画板图片缺失（如旧授权缺画板权限时下载失败，重新授权后补齐）
   */
  private mdNeedsRerender(mdPath: string): boolean {
    let md: string;
    try {
      md = fs.readFileSync(mdAbsolutePath(mdPath), "utf8");
    } catch {
      return true;
    }
    if (!new RegExp(`render_version:\\s*"?${FEISHU_MARKDOWN_RENDER_VERSION}"?`).test(md)) {
      return true;
    }
    const docId = /feishu_doc_id:\s*"?([A-Za-z0-9]+)"?/.exec(md)?.[1];
    if (!docId) {
      return true;
    }
    const boardTokens = new Set(
      [...md.matchAll(/<(?:board|whiteboard|diagram|mindnote)\b[^>]*\stoken="([^"]+)"/g)]
        .map((match) => match[1] ?? ""),
    );
    if (boardTokens.size === 0) {
      return false;
    }
    let files: string[];
    try {
      files = fs.readdirSync(assetDirAbsolute(docId));
    } catch {
      return true; // 资产目录不存在 → 必缺
    }
    const sanitized = (token: string) => token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    return [...boardTokens].some((token) => !files.some((file) => file.startsWith(sanitized(token))));
  }

  // ---------- 回写基线存取（MaomiAgent 式 .maomi/feishu-docs 布局） ----------

  /** 旧版基线（data/baselines/<docId>.json），仅作读取回退，不再写入 */
  private legacyBaselinePath(docId: string): string {
    return path.join(DATA_DIR, "baselines", `${docId.replace(/[^A-Za-z0-9_-]/g, "") || "doc"}.json`);
  }

  private writeBaseline(token: string, baseline: DocBaseline): void {
    const cacheDir = path.join(WORKSPACE_DIR, ...feishuDocCacheDirPosix(token).split("/"));
    fs.mkdirSync(cacheDir, { recursive: true });
    const writeJson = (fileName: string, value: unknown) => {
      const target = path.join(cacheDir, fileName);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, target);
    };
    writeJson("document.ir.json", baseline.ir);
    writeJson("base.ir.json", baseline.ir);
    writeJson("document.source.json", {
      docId: baseline.ir.document.id,
      token,
      fetchedAt: baseline.savedAt,
      revisionId: baseline.revisionId,
      blocks: baseline.sourceBlocks,
    });
    writeJson("base.source.json", {
      docId: baseline.ir.document.id,
      token,
      fetchedAt: baseline.savedAt,
      revisionId: baseline.revisionId,
      blocks: baseline.sourceBlocks,
    });

    // 基线 markdown：纯源码 markdown（无 frontmatter），供推送对比
    const baseMdAbsolute = mdAbsolutePath(feishuBaseMarkdownPosix(token));
    fs.mkdirSync(path.dirname(baseMdAbsolute), { recursive: true });
    fs.writeFileSync(baseMdAbsolute, `${baseline.markdown}\n`, "utf8");

    // 迁移完成：清掉旧版单文件基线
    try { fs.rmSync(this.legacyBaselinePath(baseline.ir.document.id), { force: true }); } catch { /* 忽略 */ }
  }

  private readBaseline(token: string): DocBaseline | null {
    // 新布局：base.ir.json + baselines/<token>.base.md
    try {
      const cacheDir = path.join(WORKSPACE_DIR, ...feishuDocCacheDirPosix(token).split("/"));
      const ir = JSON.parse(fs.readFileSync(path.join(cacheDir, "base.ir.json"), "utf8")) as FeishuDocIR;
      const markdown = fs.readFileSync(mdAbsolutePath(feishuBaseMarkdownPosix(token)), "utf8").trim();
      let sourceBlocks: FeishuRawDocBlock[] | null = null;
      try {
        const source = JSON.parse(fs.readFileSync(path.join(cacheDir, "base.source.json"), "utf8")) as { blocks?: FeishuRawDocBlock[] };
        sourceBlocks = source.blocks ?? null;
      } catch { /* source 缺失时推送策略回退 */ }
      if (ir?.document?.id && typeof markdown === "string") {
        return {
          ir,
          markdown,
          sourceBlocks: sourceBlocks ?? [],
          revisionId: ir.document.revisionId,
          savedAt: ir.document.pulledAt ?? "",
        };
      }
    } catch {
      // 无新布局基线 → 尝试旧版
    }
    // 旧版回退：data/baselines/<docId>.json（docId 未知时无法定位，返回 null 走无基线策略）
    for (const legacy of this.legacyBaselineCandidates(token)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, "utf8")) as DocBaseline;
        if (parsed?.ir?.document?.id && typeof parsed.markdown === "string") {
          return parsed;
        }
      } catch { /* continue */ }
    }
    return null;
  }

  /** 旧版基线按 docId 命名，无法从 token 反查；扫目录按内容匹配 token（只在没找到新基线时用） */
  private legacyBaselineCandidates(_token: string): string[] {
    try {
      const dir = path.join(DATA_DIR, "baselines");
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  /** markdown 路径：MaomiAgent 方案——一律按 node token 命名，标题变化不移动文件，更新即覆写 */
  private resolveMarkdownPath(node: NodeEntry): string {
    return feishuDocMarkdownPosix(node.token);
  }

  /** 同步成功后迁移旧布局：删除标题路径的旧 md（同一文档的过期副本） */
  private migrateLegacyMarkdown(oldMdPath: string | undefined | null, newMdPath: string): void {
    if (!oldMdPath || oldMdPath === newMdPath || oldMdPath.startsWith(".maomi/")) {
      return;
    }
    try {
      fs.rmSync(mdAbsolutePath(oldMdPath), { force: true });
    } catch { /* 删除失败不影响同步 */ }
  }

  // ---------- 回写飞书 ----------

  /**
   * 把本地 markdown 推回飞书文档（照抄 MaomiAgent 三级策略）：
   * 白板 mermaid 增量 → docs_ai 整文覆写 → 纯 markdown 重建。
   * 默认带版本乐观锁：本地同步之后远端被人改过时会拒绝，force=true 强制覆盖。
   * 被策略阻断时抛出 MaomiAgent 同款中文原因（本地草稿保持不变）。
   */
  async pushDoc(
    token: string,
    options: { force?: boolean } = {},
  ): Promise<{ strategy: string; revisionId?: string; blockCount?: number; changedWhiteboards?: number }> {
    // 权限预检：scope 按词精确匹配（飞书可能同时授予 docx:document 与其只读子集，两者并存时编辑有效）
    this.requireScope("docx:document", "推送文档");

    const node = this.store.getNode(token);
    if (!node) {
      throw new Error(`文档不在工作台索引中：${token}`);
    }
    if (!node.docId || !node.mdPath) {
      throw new Error("该节点尚未同步到本地（没有可回写的 markdown），请先拉取");
    }
    const docId: string = node.docId;

    const raw = fs.readFileSync(mdAbsolutePath(node.mdPath), "utf8");
    const markdown = stripFrontMatter(raw).trim();
    if (!markdown) {
      throw new Error("本地 markdown 内容为空，已取消回写");
    }

    // 远端当前版本：与本地同步版本不一致 → 说明有人改过远端，默认拒绝
    const meta = await this.tokens.withToken((accessToken) => fetchDocumentMeta(this.client, accessToken, docId));
    if (!options.force && node.revisionId && meta.revisionId && meta.revisionId !== node.revisionId) {
      throw new Error(
        `远端文档在本地同步后已被修改（远端版本 ${meta.revisionId}，本地基于版本 ${node.revisionId}）。`
        + `请先「重新同步」确认远端改动后再回写；如确认要覆盖远端，请使用强制回写。`,
      );
    }

    const baseline = this.readBaseline(token);
    const lockRevision = options.force ? "-1" : (node.revisionId || meta.revisionId || "-1");

    const outcome = await this.tokens.withToken((accessToken) => pushDocumentWithStrategies(this.client, accessToken, {
      docId,
      title: node.title,
      draftMarkdown: markdown,
      baselineMarkdown: baseline?.markdown ?? "",
      baseIr: baseline?.ir ?? null,
      sourceBlocks: baseline?.sourceBlocks ?? null,
      revisionId: lockRevision,
    }));

    if (outcome.status === "blocked") {
      throw new Error(outcome.message);
    }

    // 推送成功：刷新远端版本，并强制重新拉取以重建本地基线（等价 MaomiAgent settle 后状态）
    node.syncedAt = new Date().toISOString();
    node.revisionId = outcome.revisionId ?? meta.revisionId;
    this.store.upsertNode(node);
    this.store.save();
    await this.syncDoc(token, { force: true });

    return {
      strategy: outcome.strategy,
      revisionId: node.revisionId,
      blockCount: outcome.blockCount,
    };
  }

  // ---------- 批量同步 ----------

  /** 同步一个根下的全部文档（先列树再同步），在后台任务中执行 */
  async syncRoot(rootId: string, options: { force?: boolean; relist?: boolean } = {}): Promise<string> {
    const root = this.store.getRoot(rootId);
    if (!root) {
      throw new Error(`文档源不存在：${rootId}`);
    }

    const job = this.jobs.create("sync-root", `同步「${root.title}」`);
    void this.runSyncJob(job.id, async () => {
      const rootNode = this.store.getNode(root.token);
      if (options.relist || !rootNode?.childrenListedAt) {
        this.jobs.log(job.id, "正在拉取目录树…");
        await this.ensureTreeListed({
          rootId,
          startToken: root.token,
          kind: root.kind,
          spaceId: root.spaceId,
          domain: root.domain,
          jobId: job.id,
        });
      }

      const docNodes = this.store.nodesOfRoot(rootId).filter((node) => node.kind === "doc" && node.docId);
      this.jobs.patch(job.id, { total: docNodes.length });
      this.jobs.log(job.id, `共 ${docNodes.length} 篇文档待同步`);

      let changed = 0;
      let skipped = 0;
      let failed = 0;
      await this.runPool(docNodes, this.getConfig().syncConcurrency, async (node) => {
        try {
          const result = await this.syncDoc(node.token, { force: options.force });
          if (result.skipped) {
            skipped += 1;
          } else {
            changed += 1;
            this.jobs.log(job.id, `✓ ${result.title} → ${result.mdPath}`);
          }
        } catch (error) {
          failed += 1;
          node.syncError = describeFeishuError(error);
          this.store.upsertNode(node);
          this.jobs.addError(job.id, `${node.title}: ${node.syncError}`);
        }
        this.jobs.patch(job.id, { changed, skipped, failed, done: changed + skipped + failed });
      });

      return { docs: docNodes.length };
    });

    return job.id;
  }

  /** 同步所有根 */
  async syncAll(options: { force?: boolean } = {}): Promise<string> {
    const job = this.jobs.create("sync-all", "同步全部文档源");
    void this.runSyncJob(job.id, async () => {
      const roots = this.store.roots;
      if (roots.length === 0) {
        this.jobs.log(job.id, "尚未添加任何文档源");
        return { roots: 0 };
      }

      let total = 0;
      for (const root of roots) {
        if (options.force || this.store.nodesOfRoot(root.id).length === 0) {
          this.jobs.log(job.id, `正在拉取「${root.title}」目录树…`);
          await this.ensureTreeListed({
            rootId: root.id,
            startToken: root.token,
            kind: root.kind,
            spaceId: root.spaceId,
            domain: root.domain,
            jobId: job.id,
          });
        }
        total += this.store.nodesOfRoot(root.id).filter((node) => node.kind === "doc" && node.docId).length;
      }
      this.jobs.patch(job.id, { total });

      for (const root of roots) {
        const docNodes = this.store.nodesOfRoot(root.id).filter((node) => node.kind === "doc" && node.docId);
        this.jobs.log(job.id, `开始同步「${root.title}」（${docNodes.length} 篇）`);
        let changed = 0;
        let skipped = 0;
        let failed = 0;
        await this.runPool(docNodes, this.getConfig().syncConcurrency, async (node) => {
          try {
            const result = await this.syncDoc(node.token, { force: options.force });
            if (result.skipped) {
              skipped += 1;
            } else {
              changed += 1;
              this.jobs.log(job.id, `✓ ${result.title} → ${result.mdPath}`);
            }
          } catch (error) {
            failed += 1;
            node.syncError = describeFeishuError(error);
            this.store.upsertNode(node);
            this.jobs.addError(job.id, `${node.title}: ${node.syncError}`);
          }
          this.jobs.patch(job.id, { changed, skipped, failed, done: changed + skipped + failed });
        });
      }

      return { roots: roots.length, docs: total };
    });
    return job.id;
  }

  private async runSyncJob(jobId: string, body: () => Promise<unknown>): Promise<void> {
    try {
      const result = await body();
      this.jobs.finish(jobId, result);
    } catch (error) {
      this.jobs.fail(jobId, describeFeishuError(error));
    }
  }

  private async runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (!item) {
          return;
        }
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  // ---------- 在线搜索 ----------

  /**
   * 飞书云端搜索文档（搜索范围 = 当前授权用户可见的全部云文档与知识库，不限于已添加的文档源）。
   * 缺少 search:docs:read 权限时给出可操作的提示。
   */
  async searchOnline(input: { query: string; pageSize?: number; pageToken?: string; sort?: OnlineSearchSort }): Promise<OnlineSearchResult> {
    try {
      return await this.tokens.withToken((accessToken) =>
        searchOnlineDocs(this.client, accessToken, input));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/scope|permission|denied|无权限|999916/i.test(message)) {
        throw new Error(
          `在线搜索失败：缺少「搜索云文档」权限（search:docs:read）。`
          + `请在飞书开放平台为应用开通该权限并发布版本，然后到「设置」页重新扫码授权。原始错误：${message}`,
        );
      }
      throw error;
    }
  }

  /** 确保虚拟文档源存在（幂等）：kind 固定 "search"（不向远端列树），返回其 rootId */
  private ensureVirtualRoot(id: string, title: string): string {
    const existing = this.store.roots.find((root) => root.id === id);
    if (existing) {
      return existing.id;
    }
    this.store.addRoot({
      id,
      kind: "search",
      token: id,
      title,
      addedAt: new Date().toISOString(),
    });
    // 根节点登记为已列出（childrenListedAt），同步/刷新任务不会尝试向远端列它的子树
    this.store.upsertNode({
      token: id,
      kind: "space",
      rootId: id,
      parentToken: null,
      title,
      hasChild: true,
      childrenListedAt: new Date().toISOString(),
    });
    this.store.save();
    return id;
  }

  /**
   * 新建飞书文档并同步到本地：
   * - parent_token 是 wiki 节点/知识库根 → POST /wiki/v2/spaces/:space_id/nodes（obj_type=docx，需 wiki:wiki 写权限）
   * - parent_token 是云空间文件夹 → POST /docx/v1/documents?folder_token=…
   * - 不传 → 建在「我的空间」根目录
   * 建完注册进索引（有归属挂归属文档源，否则挂「新建文档」虚拟根）并 syncDoc 拉回本地空文档。
   */
  async createDoc(input: { title: string; parentToken?: string }): Promise<SyncDocResult & { url?: string; rootId: string }> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("文档标题不能为空");
    }

    let docId = "";
    let nodeToken = "";
    let url: string | undefined;
    let rootId: string | undefined;
    let parentForNode: string | null = null;

    const parentToken = input.parentToken?.trim();
    if (parentToken) {
      const known = this.store.getNode(parentToken);
      if (known && (known.kind === "doc" || known.kind === "other")) {
        throw new Error("parent_token 应为文件夹或 wiki 节点 token，不能是文档 token");
      }
      const root = known ? this.store.getRoot(known.rootId) : undefined;
      const resolved = await this.tokens.withToken((accessToken) =>
        resolveWikiNode(this.client, accessToken, parentToken));
      const wikiByRoot = !resolved
        && (root?.kind === "wiki_space" || root?.kind === "wiki_node" || known?.kind === "wiki" || known?.kind === "space");
      const knownRootId = known?.rootId;

      if (resolved || wikiByRoot) {
        // ---------- 知识库节点下创建 ----------
        this.requireScope("wiki:wiki", "在知识库节点下新建文档");
        const spaceId = resolved?.spaceId ?? root?.spaceId;
        if (!spaceId) {
          throw new Error("无法确定该 wiki 节点所属的知识库空间（space_id 缺失）");
        }
        const parentNodeToken = known
          ? (root && root.token === known.token ? undefined : known.token)
          : resolved?.nodeToken;
        const response = await this.tokens.withToken((accessToken) =>
          this.client.postJson<{ node?: { node_token?: string; obj_token?: string; title?: string; obj_type?: string } }>(
            openApiUrl(`/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`),
            accessToken,
            {
              obj_type: "docx",
              title,
              parent_node_token: parentNodeToken || undefined,
            },
          ));
        const node = response.node ?? {};
        if (!node.obj_token || !node.node_token) {
          throw new Error("飞书创建知识库节点响应缺少 obj_token/node_token");
        }
        docId = node.obj_token;
        nodeToken = node.node_token;
        url = buildRemoteUrl(undefined, "wiki", nodeToken);
        rootId = knownRootId;
        parentForNode = known ? known.token : null;
        if (!rootId) {
          rootId = this.ensureVirtualRoot(CREATED_DOCS_ROOT_ID, "新建文档");
          parentForNode = CREATED_DOCS_ROOT_ID;
        } else if (parentForNode === null) {
          parentForNode = this.store.getRoot(rootId)?.token ?? null;
        }
      } else {
        // ---------- 云空间文件夹下创建 ----------
        const created = await this.createDriveDoc(title, parentToken);
        docId = created.docId;
        nodeToken = created.docId;
        url = created.url;
        if (knownRootId && known) {
          rootId = knownRootId;
          parentForNode = known.token;
        } else {
          rootId = this.ensureVirtualRoot(CREATED_DOCS_ROOT_ID, "新建文档");
          parentForNode = CREATED_DOCS_ROOT_ID;
        }
      }
    } else {
      // ---------- 我的空间根目录 ----------
      const created = await this.createDriveDoc(title);
      docId = created.docId;
      nodeToken = created.docId;
      url = created.url;
      rootId = this.ensureVirtualRoot(CREATED_DOCS_ROOT_ID, "新建文档");
      parentForNode = CREATED_DOCS_ROOT_ID;
    }

    this.store.upsertNode({
      token: nodeToken,
      kind: "doc",
      rootId,
      parentToken: parentForNode,
      title,
      objType: "docx",
      hasChild: false,
      docId,
      remoteUrl: url,
    });
    this.store.save();

    const result = await this.syncDoc(nodeToken);
    return { ...result, url, rootId: rootId! };
  }

  /** 在云空间（默认「我的空间」根目录）创建 docx 文档并设置标题 */
  private async createDriveDoc(title: string, folderToken?: string): Promise<{ docId: string; url: string }> {
    const response = await this.tokens.withToken((accessToken) =>
      this.client.postJson<{ document?: { document_id?: string } }>(
        openApiUrl("/docx/v1/documents", { folder_token: folderToken || undefined }),
        accessToken,
        {},
      ));
    const docId = response.document?.document_id;
    if (!docId) {
      throw new Error("飞书创建文档响应缺少 document_id");
    }
    // 创建接口不能带标题：创建后 PATCH 标题
    try {
      await this.tokens.withToken((accessToken) =>
        this.client.patchJson(
          openApiUrl(`/docx/v1/documents/${encodeURIComponent(docId)}`),
          accessToken,
          { title },
        ));
    } catch {
      // 标题设置失败不阻断创建（文档仍可用，标题可在飞书里改）
    }
    return { docId, url: buildRemoteUrl(undefined, "docx", docId) };
  }

  /** OAuth scope 按词精确匹配预检（缺失时抛带补救指引的错误；飞书可能同时授出只读子集，不能用 includes） */
  private requireScope(scope: string, action: string): void {
    const granted = new Set((this.getConfig().userToken?.scope ?? "").split(/\s+/));
    if (!granted.has(scope)) {
      throw new Error(
        `${action}需要「${scope}」权限。请到「设置」页重新扫码授权（授权会自动申请该权限）；`
        + `若仍未授予，需先在飞书开放平台为应用开通该权限并发布版本。`,
      );
    }
  }

  /**
   * 把在线搜索命中的文档拉取到本地：注册到「在线搜索」文档源下（已入索引则直接复用），
   * 再走常规 syncDoc（下载资源、生成 markdown、写回写基线）。
   */
  async pullOnlineDoc(hit: {
    token: string;
    entityType: "DOC" | "WIKI";
    url?: string;
    title?: string;
  }): Promise<SyncDocResult> {
    const existing = this.store.getNode(hit.token);
    if (existing?.docId) {
      return this.syncDoc(existing.token);
    }

    const rootId = this.ensureVirtualRoot(ONLINE_SEARCH_ROOT_ID, "在线搜索");
    let node: NodeEntry;

    if (hit.entityType === "WIKI") {
      const resolved = await this.tokens.withToken((accessToken) =>
        resolveWikiNode(this.client, accessToken, hit.token));
      if (!resolved?.objToken) {
        throw new Error(`无法解析 wiki 节点 ${hit.token}（可能已被删除、无权限，或不是知识库节点）`);
      }
      if (resolved.objType && !SYNCABLE_OBJ_TYPES.has(resolved.objType)) {
        throw new Error(`该搜索结果是 ${resolved.objType}，暂不支持同步为 markdown（仅支持 docx 文档）`);
      }
      node = {
        token: hit.token,
        kind: "doc",
        rootId,
        parentToken: ONLINE_SEARCH_ROOT_ID,
        title: resolved.title || hit.title || hit.token,
        objType: resolved.objType || "docx",
        hasChild: false,
        docId: resolved.objToken,
        remoteUrl: hit.url,
      };
    } else {
      node = {
        token: hit.token,
        kind: "doc",
        rootId,
        parentToken: ONLINE_SEARCH_ROOT_ID,
        title: hit.title || hit.token,
        objType: "docx",
        hasChild: false,
        docId: hit.token,
        remoteUrl: hit.url,
      };
    }

    this.store.upsertNode(node);
    this.store.save();
    return this.syncDoc(node.token);
  }

  // ---------- 添加根 ----------

  /** 直接添加一个完整的 wiki 知识库空间作为文档源（空间本身即是根） */
  async addWikiSpace(spaceId: string, name: string): Promise<{ rootId: string; root: ReturnType<WorkspaceStore["getRoot"]> }> {
    const rootId = randomUUID();
    this.store.addRoot({
      id: rootId,
      kind: "wiki_space",
      token: spaceId,
      spaceId,
      title: name || spaceId,
      addedAt: new Date().toISOString(),
    });
    this.store.upsertNode({
      token: spaceId,
      kind: "space",
      rootId,
      parentToken: null,
      title: name || spaceId,
      hasChild: true,
    });
    this.store.save();
    return { rootId, root: this.store.getRoot(rootId) };
  }

  async addRoot(linkOrToken: string): Promise<{ rootId: string; root: ReturnType<WorkspaceStore["getRoot"]> }> {
    const accessToken = await this.tokens.getToken();
    const recognized = await recognizeRoot(this.client, accessToken, linkOrToken);

    if (recognized.kind === "wiki_node" && !recognized.spaceId) {
      throw new Error("无法识别该 wiki 节点所属的知识库空间（space_id 缺失）");
    }

    const rootId = randomUUID();
    this.store.addRoot({
      id: rootId,
      kind: recognized.kind,
      token: recognized.token,
      spaceId: recognized.spaceId,
      title: recognized.title,
      domain: recognized.domain,
      addedAt: new Date().toISOString(),
    });

    // 把根节点登记为索引节点，便于树渲染与路径生成
    this.store.upsertNode({
      token: recognized.token,
      kind: recognized.kind === "folder" ? "folder" : recognized.kind === "doc" ? "doc" : "wiki",
      rootId,
      parentToken: null,
      title: recognized.title,
      objType: recognized.objType,
      hasChild: recognized.kind !== "doc",
      docId: recognized.docId,
    });
    this.store.save();

    return { rootId, root: this.store.getRoot(rootId) };
  }
}

function canHaveChildren(node: NodeEntry): boolean {
  return node.kind === "folder" || node.kind === "wiki" || node.kind === "space" || node.hasChild === true;
}
