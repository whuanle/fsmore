import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Router } from "express";
import { listWikiSpaces, parseFeishuLink } from "../feishu/tree.js";
import { describeFeishuError } from "../feishu/errors.js";
import { downloadAsset } from "../feishu/assets.js";
import { searchDocTitles, searchDocs } from "../workspace/search.js";
import {
  assetDirAbsolute,
  maomiCacheDirAbsolute,
  mdAbsolutePath,
  type NodeEntry,
  type WorkspaceStore,
} from "../workspace/store.js";
import { WORKSPACE_DIR } from "../paths.js";
import type { SyncEngine } from "../workspace/sync.js";
import type { JobManager } from "../jobs.js";
import type { FeishuOpenApiClient, FeishuTokenManager } from "../feishu/client.js";
import type { AppConfig } from "../config.js";
import { MCP_ENDPOINT, MCP_TOOLS_INFO } from "../mcp/info.js";
import { FEISHU_AUTH_BASE, feishuOAuthScope } from "../feishu/base.js";
import { renderDocPage, renderErrorPage } from "../web/viewer.js";

/** 构造 OAuth 回调地址（必须与飞书「安全设置 → 重定向 URL」完全一致） */
export function buildRedirectUri(config: AppConfig): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}/api/oauth/callback`;
}

export type AppContext = {
  getConfig: () => AppConfig;
  setConfig: (patch: Partial<AppConfig>) => AppConfig;
  client: FeishuOpenApiClient;
  tokens: FeishuTokenManager;
  store: WorkspaceStore;
  engine: SyncEngine;
  jobs: JobManager;
};

/** 资产映射：token → 本地资源 URL；画板导出图优先返回已裁边版本（<token>.trimmed.png） */
function buildAssetMap(assetPaths: string[]): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const relative of assetPaths) {
    const fileName = relative.split("/").pop() ?? "";
    const token = fileName.replace(/\.[^.]+$/, "");
    if (!token) {
      continue;
    }
    const trimmedRel = relative.replace(/\.[^.]+$/, ".trimmed.png");
    const useRel = fs.existsSync(mdAbsolutePath(trimmedRel)) ? trimmedRel : relative;
    assets[token] = `/workspace/${useRel}`;
  }
  return assets;
}

/** 统计 .maomi 缓存目录大小与文件数（目录不存在时 exists:false、大小为 0） */
function cacheStats(): { path: string; exists: boolean; bytes: number; files: number } {
  const cacheDir = maomiCacheDirAbsolute();
  const result = { path: cacheDir, exists: fs.existsSync(cacheDir), bytes: 0, files: 0 };
  if (!result.exists) {
    return result;
  }
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        result.bytes += fs.statSync(full).size;
        result.files += 1;
      }
    }
  };
  try {
    walk(cacheDir);
  } catch { /* 个别文件读取失败时返回已统计部分 */ }
  return result;
}

export function createApiRouter(ctx: AppContext): Router {  const router = express.Router();

  /** OAuth state 一次性校验（10 分钟有效） */
  const oauthStates = new Map<string, number>();
  const newOAuthState = (): string => {
    const state = randomUUID();
    oauthStates.set(state, Date.now());
    for (const [key, created] of oauthStates) {
      if (Date.now() - created > 10 * 60 * 1000) {
        oauthStates.delete(key);
      }
    }
    return state;
  };

  const requireCredentials = (): string | null => {
    const config = ctx.getConfig();
    return config.appId && config.appSecret ? null : "尚未配置飞书应用凭证，请先在「设置」页填写 App ID / App Secret";
  };

  const guard = (handler: (req: express.Request) => Promise<unknown> | unknown) => async (req: express.Request, res: express.Response) => {
    try {
      const result = await handler(req);
      res.json(result ?? { ok: true });
    } catch (error) {
      res.status(400).json({ error: describeFeishuError(error) });
    }
  };

  // ---------- 状态与配置 ----------

  router.get("/status", (_req, res) => {
    const config = ctx.getConfig();
    const userAuthorized = !!config.userToken;
    res.json({
      version: "0.1.0",
      configured: !!(config.appId && config.appSecret),
      appId: config.appId,
      connected: userAuthorized || !!ctx.tokens.tenantExpiresAt,
      tokenExpiresAt: userAuthorized ? config.userToken?.accessTokenExpiresAt : ctx.tokens.tenantExpiresAt,
      auth: {
        channel: userAuthorized ? "user" : "tenant",
        userAuthorized,
        userName: config.userName ?? "",
        userTokenExpiresAt: config.userToken?.accessTokenExpiresAt,
        refreshTokenExpiresAt: config.userToken?.refreshTokenExpiresAt,
        tenantTokenExpiresAt: ctx.tokens.tenantExpiresAt,
        autoRefresh: ctx.tokens.refreshInfo,
        /** 当前授权令牌里是否已授予编辑 scope（按词精确匹配；飞书可能同时授出 docx:document 与只读子集） */
        writeScopeGranted: (config.userToken?.scope ?? "").split(/\s+/).includes("docx:document"),
        /** 画板读取 scope（文档内画板下载为图片依赖它，缺失时画板位置显示占位） */
        boardScopeGranted: !!config.userToken?.scope?.includes("board:whiteboard:node:read"),
        redirectUri: buildRedirectUri(config),
      },
      counts: ctx.store.counts(),
      dataDir: path.dirname(ctx.store.indexPath),
      workspaceDir: WORKSPACE_DIR,
      port: config.port,
      mcpEndpoint: MCP_ENDPOINT,
    });
  });

  router.post("/config", guard(async (req) => {
    const body = (req.body ?? {}) as { appId?: string; appSecret?: string; syncConcurrency?: number };
    const patch: Partial<AppConfig> = {};
    // 防御式覆盖：空值或含 * 的掩码串一律忽略，避免把已保存的真实凭证改坏
    if (typeof body.appId === "string" && body.appId.trim() && !body.appId.includes("*")) {
      patch.appId = body.appId.trim();
    }
    if (typeof body.appSecret === "string" && body.appSecret.trim() && !body.appSecret.includes("*")) {
      patch.appSecret = body.appSecret.trim();
    }
    if (typeof body.syncConcurrency === "number") {
      patch.syncConcurrency = Math.min(8, Math.max(1, Math.floor(body.syncConcurrency)));
    }
    return revealConfig(ctx.setConfig(patch));
  }));

  router.get("/config", (_req, res) => {
    res.json(revealConfig(ctx.getConfig()));
  });

  router.post("/config/test", guard(async () => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const token = await ctx.tokens.getTenantToken(true);
    return { ok: true, expiresAt: ctx.tokens.tenantExpiresAt, tokenPreview: `${token.slice(0, 6)}…` };
  }));

  // ---------- 扫码授权（OAuth user_access_token） ----------

  router.get("/oauth/url", guard(() => {
    const config = ctx.getConfig();
    if (!config.appId) {
      throw new Error("请先填写并保存 App ID");
    }
    const redirectUri = buildRedirectUri(config);
    const scope = feishuOAuthScope();
    const url = new URL(`${FEISHU_AUTH_BASE}/open-apis/authen/v1/authorize`);
    url.searchParams.set("app_id", config.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", newOAuthState());
    // URLSearchParams 会把空格编码为 +，飞书授权页对 scope 更认可 %20
    return { url: url.toString().replace(/\+/g, "%20"), redirectUri, scope };
  }));

  router.get("/oauth/callback", async (req, res) => {
    const respond = (ok: boolean, title: string, detail: string) => {
      res.status(ok ? 200 : 400).type("html").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>fsmore 授权</title>
<style>
  body { font-family: "PingFang SC","Microsoft YaHei",sans-serif; background:#f4f5f7; display:flex;
         align-items:center; justify-content:center; height:100vh; margin:0; }
  .box { background:#fff; border-radius:16px; box-shadow:0 10px 40px rgba(31,35,41,.14);
         padding:44px 48px; text-align:center; max-width:420px; }
  .icon { width:56px; height:56px; border-radius:50%; margin:0 auto 18px; font-size:28px;
          display:flex; align-items:center; justify-content:center; }
  .ok .icon { background:#e6f6ec; } .err .icon { background:#fdeceb; }
  h1 { font-size:18px; margin:0 0 10px; color:#1f2329; }
  p { font-size:13px; color:#646a73; margin:0; line-height:1.7; word-break:break-all; }
</style></head>
<body class="${ok ? "ok" : "err"}"><div class="box">
  <div class="icon">${ok ? "✅" : "⚠️"}</div>
  <h1>${title}</h1><p>${detail}</p>
</div>
<script>
  try { window.opener && window.opener.postMessage({ type: "fsmore-oauth", ok: ${ok ? "true" : "false"} }, "*"); } catch (e) {}
  if (${ok ? "true" : "false"}) { setTimeout(function () { window.close(); }, 1600); }
</script>
</body></html>`);
    };

    try {
      const query = req.query as { code?: string; state?: string; error?: string; error_description?: string };
      if (query.error) {
        respond(false, "授权未完成", query.error_description || query.error);
        return;
      }
      const state = query.state ?? "";
      const created = oauthStates.get(state);
      oauthStates.delete(state);
      if (!query.code || !created || Date.now() - created > 10 * 60 * 1000) {
        respond(false, "授权状态无效", "state 校验失败或已超时，请回到 fsmore 重新发起扫码授权。");
        return;
      }

      const config = ctx.getConfig();
      const redirectUri = buildRedirectUri(config);
      const tokens = await ctx.client.exchangeOAuthCode({
        appId: config.appId,
        appSecret: config.appSecret,
        code: query.code,
        redirectUri,
      });
      ctx.setConfig({ userToken: tokens });

      let userName = "";
      try {
        const info = await ctx.client.getUserInfo(tokens.accessToken);
        userName = info.name ?? "";
        ctx.setConfig({ userName });
      } catch {
        // 用户信息仅用于展示，失败不影响授权
      }

      respond(true, "授权成功", `已获得你的飞书文档访问权限${userName ? `（${userName}）` : ""}，本窗口将自动关闭，请回到 fsmore 查看。`);
    } catch (error) {
      respond(false, "授权失败", describeFeishuError(error));
    }
  });

  router.post("/oauth/disconnect", guard(() => {
    ctx.setConfig({ userToken: undefined, userName: undefined });
    return { ok: true };
  }));

  // ---------- 文档源（roots） ----------

  router.get("/roots", guard(() => ({
    roots: ctx.store.roots.map((root) => {
      const nodes = ctx.store.nodesOfRoot(root.id);
      return {
        ...root,
        nodesTotal: nodes.length,
        docsTotal: nodes.filter((node) => node.kind === "doc" && node.docId).length,
        docsSynced: nodes.filter((node) => node.mdPath).length,
      };
    }),
  })));

  router.post("/roots", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { link?: string; wikiSpaceId?: string; wikiSpaceName?: string };
    if (body.wikiSpaceId) {
      const added = await ctx.engine.addWikiSpace(body.wikiSpaceId, body.wikiSpaceName?.trim() || body.wikiSpaceId);
      return added;
    }
    const link = body.link?.trim();
    if (!link) {
      throw new Error("请提供飞书链接或 token");
    }
    const { rootId, root } = await ctx.engine.addRoot(link);
    return { rootId, root };
  }));

  router.delete("/roots/:id", guard((req) => {
    ctx.store.removeRoot(req.params.id ?? "");
    ctx.store.save();
    return { ok: true };
  }));

  router.get("/feishu/wiki-spaces", guard(async () => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const spaces = await ctx.tokens.withToken((accessToken) => listWikiSpaces(ctx.client, accessToken));
    return { spaces };
  }));

  // ---------- 目录树 ----------

  router.get("/tree", guard((req) => {
    const token = String(req.query.token ?? "");
    const parent = ctx.store.getNode(token);
    if (!parent) {
      throw new Error(`索引中不存在节点：${token}`);
    }
    const children = ctx.store.childrenOf(token).sort((a, b) => a.title.localeCompare(b.title, "zh"));
    return { parent, children };
  }));

  router.post("/tree/refresh", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { token?: string };
    const token = body.token?.trim();
    if (!token) {
      throw new Error("缺少 token");
    }
    const node = ctx.store.getNode(token);
    if (!node) {
      throw new Error(`索引中不存在节点：${token}（请从根节点开始展开）`);
    }
    const root = ctx.store.getRoot(node.rootId);
    if (!root) {
      throw new Error("节点所属文档源已被删除");
    }

    const isRoot = root.token === token;
    const kind = node.kind === "folder" ? "folder" : isRoot ? root.kind : "wiki_node";
    await ctx.engine.ensureTreeListed({
      rootId: node.rootId,
      startToken: token,
      kind,
      spaceId: root.spaceId,
      domain: root.domain,
    });

    const children = ctx.store.childrenOf(token).sort((a, b) => a.title.localeCompare(b.title, "zh"));
    return { parent: ctx.store.getNode(token), children };
  }));

  // ---------- 同步 ----------

  router.post("/sync/node", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { token?: string; force?: boolean };
    const token = body.token?.trim();
    if (!token) {
      throw new Error("缺少 token");
    }
    const node = ctx.store.getNode(token);
    if (!node) {
      throw new Error(`索引中不存在节点：${token}`);
    }

    // 非文档节点（wiki 容器/文件夹）→ 同步其子树；文档 → 直接同步
    if (node.kind === "doc") {
      const result = await ctx.engine.syncDoc(token, { force: body.force });
      return { mode: "doc", result };
    }
    const root = ctx.store.getRoot(node.rootId);
    if (!root) {
      throw new Error("节点所属文档源已被删除");
    }
    const jobId = await ctx.engine.syncRoot(node.rootId, { force: body.force });
    return { mode: "subtree", jobId };
  }));

  router.post("/sync/root", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { rootId?: string; force?: boolean };
    if (!body.rootId) {
      throw new Error("缺少 rootId");
    }
    const jobId = await ctx.engine.syncRoot(body.rootId, { force: body.force, relist: body.force });
    return { jobId };
  }));

  router.post("/sync/all", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { force?: boolean };
    const jobId = await ctx.engine.syncAll({ force: body.force });
    return { jobId };
  }));

  // ---------- 回写飞书 ----------

  router.post("/push/doc", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { token?: string; path?: string; force?: boolean };
    let token = body.token?.trim();
    if (!token && body.path) {
      const normalized = body.path.replace(/\\/g, "/").replace(/^\/+/, "");
      const owner = Object.values(ctx.store.nodes).find((candidate) => candidate.mdPath === normalized);
      token = owner?.token;
    }
    if (!token) {
      throw new Error("缺少 token 或 path");
    }
    const result = await ctx.engine.pushDoc(token, { force: body.force });
    return { ok: true, token, ...result };
  }));

  // ---------- 任务 ----------

  router.get("/jobs", (_req, res) => {
    res.json({ jobs: ctx.jobs.list().map((job) => ctx.jobs.snapshot(job)) });
  });

  router.get("/jobs/:id", (req, res) => {
    const job = ctx.jobs.get(req.params.id ?? "");
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.json(ctx.jobs.snapshot(job));
  });

  router.get("/jobs/:id/events", (req, res) => {
    const job = ctx.jobs.get(req.params.id ?? "");
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", ctx.jobs.snapshot(job));

    const unsubscribe = ctx.jobs.subscribe(job.id, (event, payload) => {
      send(event, payload);
      if (event === "done") {
        res.end();
      }
    });
    req.on("close", unsubscribe);
  });

  // ---------- 已同步文档 / 预览 / 搜索 ----------

  router.get("/docs", (_req, res) => {
    const docs = ctx.store.syncedDocs().map((node) => ({
      title: node.title,
      path: node.mdPath,
      token: node.token,
      syncedAt: node.syncedAt,
      revisionId: node.revisionId,
      syncError: node.syncError,
      remoteUrl: node.remoteUrl,
      rootId: node.rootId,
    }));
    res.json({ total: docs.length, docs });
  });

  router.get("/doc/content", guard((req) => {
    const docPath = String(req.query.path ?? "");
    if (!docPath) {
      throw new Error("缺少 path 参数");
    }
    const normalized = docPath.replace(/\\/g, "/");
    const absolute = mdAbsolutePath(normalized);
    if (!absolute.startsWith(WORKSPACE_DIR) || !fs.existsSync(absolute)) {
      throw new Error(`文件不存在：${docPath}`);
    }
    const node = Object.values(ctx.store.nodes).find((candidate) => candidate.mdPath === normalized);
    const chain = node ? ctx.store.tokenChain(node.token) : [];
    const assets = buildAssetMap(node?.assetPaths ?? []);
    return {
      path: normalized,
      absolutePath: absolute,
      mdDir: path.posix.dirname(normalized),
      title: node?.title ?? path.basename(normalized, ".md"),
      token: node?.token,
      /** 根→…→本文档 的 token 链（地址栏多层路径用，token 稳定） */
      chain,
      syncedAt: node?.syncedAt,
      revisionId: node?.revisionId,
      remoteUrl: node?.remoteUrl,
      assets,
      content: fs.readFileSync(absolute, "utf8"),
    };
  }));

  /** 查看器整页 HTML（iframe 同源 src 加载；服务端 marked 渲染，不再前端拼 srcdoc）。只读本地文件，无需凭证 */
  router.get("/doc/render", (req: express.Request, res: express.Response) => {
    try {
      const errorMessage = String(req.query.error ?? "");
      if (errorMessage) {
        res.type("text/html").send(renderErrorPage(errorMessage));
        return;
      }
      const docPath = String(req.query.path ?? "");
      const normalized = docPath.replace(/\\/g, "/");
      const absolute = mdAbsolutePath(normalized);
      if (!normalized.endsWith(".md") || !absolute.startsWith(WORKSPACE_DIR) || !fs.existsSync(absolute)) {
        res.type("text/html").send(renderErrorPage(`文件不存在：${docPath}`));
        return;
      }
      const node = Object.values(ctx.store.nodes).find((candidate) => candidate.mdPath === normalized);
      const boardScopeOk = (ctx.getConfig().userToken?.scope ?? "").split(/\s+/).includes("board:whiteboard:node:read");
      res.type("text/html").send(renderDocPage({
        rawMarkdown: fs.readFileSync(absolute, "utf8"),
        assets: buildAssetMap(node?.assetPaths ?? []),
        boardScopeOk,
      }));
    } catch (error) {
      res.type("text/html").send(renderErrorPage(error instanceof Error ? error.message : String(error)));
    }
  });

  /** 保存编辑后的 markdown（写回本地文件；推送飞书由 /api/push/doc 基于 MaomiAgent 四级策略执行） */
  router.post("/doc/content", guard((req) => {
    const body = (req.body ?? {}) as { path?: string; content?: string; base?: string };
    const docPath = String(body.path ?? "").replace(/\\/g, "/");
    const absolute = mdAbsolutePath(docPath);
    if (!docPath.endsWith(".md") || !absolute.startsWith(WORKSPACE_DIR)) {
      throw new Error(`非法路径：${docPath}`);
    }
    if (!fs.existsSync(absolute)) {
      throw new Error(`文件不存在：${docPath}`);
    }
    if (typeof body.content !== "string") {
      throw new Error("缺少 content");
    }
    // 防呆：编辑期间文件被同步/推送更新过（如推送后自动重拉），拒绝旧编辑覆盖新文件
    if (typeof body.base === "string") {
      const current = fs.readFileSync(absolute, "utf8");
      if (current !== body.base) {
        throw new Error("文件在编辑期间已被更新（可能是推送后的自动重新同步），本次保存已取消。请取消编辑、重新打开文档后再改。");
      }
    }
    fs.writeFileSync(absolute, body.content.endsWith("\n") ? body.content : `${body.content}\n`, "utf8");
    return { ok: true, path: docPath };
  }));

  router.get("/search", guard((req) => {
    const query = String(req.query.q ?? "");
    return { hits: searchDocs(ctx.store, query, 30) };
  }));

  /** 按文档标题搜索已列出的索引节点（含未同步文档，左目录搜索框用） */
  router.get("/tree/search", guard((req) => {
    const query = String(req.query.q ?? "");
    return { hits: searchDocTitles(ctx.store, query) };
  }));

  // ---------- 在线搜索（飞书云端，含未同步文档） ----------

  router.post("/search/online", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { query?: string; limit?: number };
    const query = body.query?.trim();
    if (!query) {
      throw new Error("缺少 query");
    }
    const result = await ctx.engine.searchOnline({
      query,
      pageSize: typeof body.limit === "number" ? Math.max(1, Math.min(20, Math.floor(body.limit))) : 10,
    });
    const hits = result.hits.map((hit) => {
      const node = ctx.store.getNode(hit.token);
      return { ...hit, synced: !!node?.mdPath, md_path: node?.mdPath };
    });
    return { total: result.total, has_more: result.has_more, hits };
  }));

  /** 把一条在线搜索命中拉取到本地（注册进「在线搜索」文档源并同步） */
  router.post("/search/online/pull", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { token?: string; entity_type?: string; url?: string; title?: string };
    const token = body.token?.trim();
    if (!token) {
      throw new Error("缺少 token");
    }
    const result = await ctx.engine.pullOnlineDoc({
      token,
      entityType: body.entity_type === "WIKI" ? "WIKI" : "DOC",
      url: body.url,
      title: body.title,
    });
    return { result, node: ctx.store.getNode(token) };
  }));

  // ---------- 资源 ----------

  /** 保存画板裁边图（前端 canvas 裁掉飞书导出图四周空白后回存，<token>.trimmed.png；避免大 dataURL 塞进 iframe srcdoc） */
  router.post("/assets/trim", guard((req) => {
    const body = (req.body ?? {}) as { path?: string; dataUrl?: string };
    const rel = String(body.path ?? "").replace(/\\/g, "/");
    if (!/^_assets\/[A-Za-z0-9_./-]+\.(jpg|jpeg|png|webp)$/.test(rel)) {
      throw new Error(`非法资源路径：${rel}`);
    }
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl ?? ""));
    if (!match?.[1]) {
      throw new Error("仅支持 png dataUrl");
    }
    const trimmedRel = rel.replace(/\.[^.]+$/, ".trimmed.png");
    const absolute = mdAbsolutePath(trimmedRel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, Buffer.from(match[1], "base64"));
    return { path: trimmedRel, url: `/workspace/${trimmedRel}` };
  }));

  router.post("/assets/fetch", guard(async (req) => {
    const missing = requireCredentials();
    if (missing) {
      throw new Error(missing);
    }
    const body = (req.body ?? {}) as { token?: string; kind?: "file" | "image" | "whiteboard" };
    if (!body.token) {
      throw new Error("缺少资源 token");
    }
    const assetToken: string = body.token;
    const result = await ctx.tokens.withToken((accessToken) => downloadAsset({
      client: ctx.client,
      accessToken,
      token: assetToken,
      kind: body.kind ?? "file",
      destDir: assetDirAbsolute("shared"),
    }));
    return result;
  }));

  // ---------- 缓存统计与清空（.maomi 文档缓存） ----------

  router.get("/cache/stats", (_req, res) => {
    res.json(cacheStats());
  });

  router.post("/cache/clear", guard(() => {
    const cacheDir = maomiCacheDirAbsolute();
    const stats = cacheStats();
    if (stats.exists) {
      // 防呆：只允许删工作区内的 .maomi 目录
      if (!cacheDir.startsWith(WORKSPACE_DIR + path.sep)) {
        throw new Error(`缓存目录异常，拒绝清理：${cacheDir}`);
      }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    const clearedNodes = ctx.store.clearSyncedState();
    return { ok: true, ...stats, clearedNodes };
  }));

  router.get("/mcp/info", (_req, res) => {
    const config = ctx.getConfig();
    const baseUrl = `http://127.0.0.1:${config.port}`;
    res.json({
      endpoint: `${baseUrl}${MCP_ENDPOINT}`,
      tools: MCP_TOOLS_INFO,
    });
  });

  return router;
}

/**
 * 配置回显（本地单用户工具，凭证本就以明文存于 data/config.json）：
 * App ID / App Secret 原样返回，前端输入框直接回填，密钥用密码框 + 显示切换。
 */
function revealConfig(config: AppConfig) {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    hasAppSecret: !!config.appSecret,
    syncConcurrency: config.syncConcurrency,
    port: config.port,
  };
}

export type { NodeEntry, WorkspaceStore };
