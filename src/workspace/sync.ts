import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { FeishuOpenApiClient } from "../feishu/client.js";
import type { FeishuTokenManager } from "../feishu/client.js";
import { fetchAllBlocks, fetchDocumentIR, fetchDocumentMeta } from "../feishu/doc-reader.js";
import { downloadAsset } from "../feishu/assets.js";
import { listChildren, recognizeRoot, type RootKind } from "../feishu/tree.js";
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

      for (const child of children) {
        const prev = this.store.getNode(child.token);
        this.store.upsertNode({
          token: child.token,
          kind: child.kind === "wiki" ? "wiki" : child.kind,
          rootId: input.rootId,
          parentToken: current.token,
          title: child.title,
          objType: child.objType ?? prev?.objType,
          hasChild: child.hasChild || child.kind === "folder",
          docId: child.docId ?? prev?.docId,
          remoteUrl: child.remoteUrl ?? prev?.remoteUrl,
          mdPath: prev?.mdPath,
          revisionId: prev?.revisionId,
          syncedAt: prev?.syncedAt,
        });
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
    const grantedScopes = new Set((this.getConfig().userToken?.scope ?? "").split(/\s+/));
    if (!grantedScopes.has("docx:document")) {
      throw new Error(
        "推送失败：当前扫码授权缺少编辑权限 docx:document。\n"
        + "请到「设置 → 步骤 4 飞书扫码授权」重新扫码，授权会自动申请编辑权限。",
      );
    }

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
