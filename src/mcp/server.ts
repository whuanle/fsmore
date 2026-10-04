import fs from "node:fs";
import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { FeishuOpenApiClient, FeishuTokenManager } from "../feishu/client.js";
import { downloadAsset } from "../feishu/assets.js";
import { describeFeishuError } from "../feishu/errors.js";
import type { JobManager } from "../jobs.js";
import { SyncEngine } from "../workspace/sync.js";
import { searchDocs } from "../workspace/search.js";
import { assetDirAbsolute, mdAbsolutePath, type NodeEntry, type WorkspaceStore } from "../workspace/store.js";
import { WORKSPACE_DIR } from "../paths.js";
import type { AppConfig } from "../config.js";
import { MCP_ENDPOINT } from "./info.js";

/**
 * MCP Server（Streamable HTTP，无状态模式）：把工作台能力暴露给任意支持 MCP 的 AI。
 * AI 既可以像普通文件一样直接读 data/workspace 下的 markdown，也可以通过这些工具
 * 随时搜索、读取、按需拉取最新的飞书文档与资源。
 */

export type McpServices = {
  config: AppConfig;
  store: WorkspaceStore;
  engine: SyncEngine;
  jobs: JobManager;
  client: FeishuOpenApiClient;
  tokens: FeishuTokenManager;
};

export function createMcpServer(services: McpServices): McpServer {
  const server = new McpServer({
    name: "fsmore",
    version: "0.1.0",
  }, {
    instructions: [
      "fsmore 是飞书本地 AI 工作台：飞书文档已被同步为本机 markdown 文件（front matter 里含 feishu_token / source_url / revision_id 元信息）。",
      "推荐工作流：先用 search_docs 或 list_docs 找到相关文档 → 用 read_doc 读取 markdown → 若内容可能过期（需要最新版）再调用 sync_doc 后重新读取。",
      "修改飞书文档：直接编辑本地 .md 文件，然后调用 push_doc 回写飞书。同步的 markdown 保留飞书原生标签（<image>/<callout>/<table> 等），回写时按 MaomiAgent 四级策略无损还原；远端有新改动时会提示冲突，确认覆盖可传 force=true。",
      "文档内的图片等资源已下载到本地工作区，read_doc 返回的 markdown 里是相对路径；需要绝对路径或下载附件时用 list_assets / fetch_asset。回写时图片/附件会以文字占位，不会丢失本地文件。",
      "所有路径若不明确说明，均相对于 markdown 工作区根目录（list_spaces 返回 workspace_path）。",
    ].join("\n"),
  });

  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
  const fail = (error: unknown) => ({
    content: [{ type: "text" as const, text: `错误：${describeFeishuError(error)}` }],
    isError: true,
  });

  // ---------- list_spaces ----------

  server.registerTool("list_spaces", {
    title: "列出文档源",
    description: "列出工作台已添加的飞书文档源（知识库节点/云空间文件夹/单篇文档），以及本地 markdown 工作区根路径。",
    inputSchema: {},
  }, async () => {
    try {
      const roots = services.store.roots.map((root) => ({
        space_id: root.id,
        kind: root.kind,
        title: root.title,
        token: root.token,
        docs_synced: services.store.nodesOfRoot(root.id).filter((node) => node.mdPath).length,
      }));
      return text(JSON.stringify({
        workspace_path: WORKSPACE_DIR,
        workspace_path_note: "本机绝对路径，AI 可直接读取其中的 .md 文件",
        spaces: roots,
      }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- list_docs ----------

  server.registerTool("list_docs", {
    title: "列出已同步文档",
    description: "列出已同步到本地的飞书文档（路径、标题、token、同步时间、版本号）。可用 space（list_spaces 返回的 space_id）过滤，query 按标题/路径模糊过滤。",
    inputSchema: {
      space: z.string().optional().describe("可选。list_spaces 返回的 space_id，限定某个文档源"),
      query: z.string().optional().describe("可选。按标题或路径模糊匹配"),
      limit: z.number().int().min(1).max(500).optional().describe("返回条数上限，默认 100"),
    },
  }, async ({ space, query, limit }) => {
    try {
      const upper = limit ?? 100;
      const normalizedQuery = query?.trim().toLowerCase();
      const docs = services.store
        .syncedDocs()
        .filter((node) => (space ? node.rootId === space : true))
        .filter((node) => (normalizedQuery
          ? node.title.toLowerCase().includes(normalizedQuery) || node.mdPath?.toLowerCase().includes(normalizedQuery)
          : true))
        .slice(0, upper)
        .map((node) => ({
          title: node.title,
          path: node.mdPath,
          token: node.token,
          doc_id: node.docId,
          synced_at: node.syncedAt,
          revision_id: node.revisionId,
          source_url: node.remoteUrl,
        }));
      return text(JSON.stringify({ total: docs.length, docs }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- search_docs ----------

  server.registerTool("search_docs", {
    title: "搜索文档",
    description: "在本地已同步的飞书文档 markdown 全文中做关键词搜索，返回得分排序的命中（含摘要片段）。",
    inputSchema: {
      query: z.string().min(1).describe("搜索关键词（支持中文）"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数上限，默认 20"),
    },
  }, async ({ query, limit }) => {
    try {
      const hits = searchDocs(services.store, query, limit ?? 20);
      return text(JSON.stringify({ total: hits.length, hits }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- read_doc ----------

  server.registerTool("read_doc", {
    title: "读取文档",
    description: "读取一篇已同步文档的 markdown 内容（含 front matter 元信息）。用 path（list_docs/search_docs 返回的工作区相对路径）或 token（飞书节点 token）定位；长文档可用 offset/length 分段读取。",
    inputSchema: {
      path: z.string().optional().describe("文档的工作区相对路径，如 「产品空间/需求/登录设计.md」"),
      token: z.string().optional().describe("飞书节点 token（与 path 二选一）"),
      offset: z.number().int().min(0).optional().describe("起始字符偏移，默认 0"),
      length: z.number().int().min(1).max(200000).optional().describe("最多返回的字符数，默认 40000"),
    },
  }, async ({ path: docPath, token, offset, length }) => {
    try {
      const node = resolveDoc(services.store, { path: docPath, token });
      if (!node?.mdPath) {
        return fail(new Error(`未找到已同步文档（path=${docPath ?? ""} token=${token ?? ""}）。可先调用 search_docs/list_docs，或用 sync_doc 拉取。`));
      }
      const content = fs.readFileSync(mdAbsolutePath(node.mdPath), "utf8");
      const start = offset ?? 0;
      const max = length ?? 40000;
      const slice = content.slice(start, start + max);
      const body = slice.length < content.length - start
        ? `${slice}\n\n<!-- fsmore: 内容被截断，全文 ${content.length} 字符，可用 offset=${start + slice.length} 继续读取 -->`
        : slice;
      return text(JSON.stringify({
        title: node.title,
        path: node.mdPath,
        synced_at: node.syncedAt,
        revision_id: node.revisionId,
        truncated: start + slice.length < content.length,
        content: body,
      }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- get_doc_meta ----------

  server.registerTool("get_doc_meta", {
    title: "文档元信息",
    description: "获取一篇文档的元信息：飞书原文链接、版本号、最近同步时间、本地路径与资源列表。",
    inputSchema: {
      path: z.string().optional().describe("文档的工作区相对路径"),
      token: z.string().optional().describe("飞书节点 token（与 path 二选一）"),
    },
  }, async ({ path: docPath, token }) => {
    try {
      const node = resolveDoc(services.store, { path: docPath, token });
      if (!node) {
        return fail(new Error(`索引中未找到该文档（path=${docPath ?? ""} token=${token ?? ""}）`));
      }
      return text(JSON.stringify({
        title: node.title,
        token: node.token,
        doc_id: node.docId,
        obj_type: node.objType,
        path: node.mdPath,
        synced_at: node.syncedAt,
        revision_id: node.revisionId,
        source_url: node.remoteUrl,
        assets: node.assetPaths ?? [],
        sync_error: node.syncError,
      }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- sync_doc ----------

  server.registerTool("sync_doc", {
    title: "同步单篇文档",
    description: "从飞书拉取一篇文档的最新内容到本地（下载图片等资源并重新生成 markdown）。内容未变化时秒回跳过。返回本地路径供 read_doc 读取。",
    inputSchema: {
      token: z.string().optional().describe("飞书节点 token"),
      path: z.string().optional().describe("或传本地工作区相对路径（通过索引反查 token）"),
      force: z.boolean().optional().describe("强制重新拉取（忽略版本号比对），默认 false"),
    },
  }, async ({ token, path: docPath, force }) => {
    try {
      const node = resolveDoc(services.store, { path: docPath, token });
      if (!node) {
        return fail(new Error(`索引中未找到该文档（path=${docPath ?? ""} token=${token ?? ""}）`));
      }
      const result = await services.engine.syncDoc(node.token, { force });
      return text(JSON.stringify(result, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- sync_space ----------

  server.registerTool("sync_space", {
    title: "同步文档源",
    description: "后台同步一个文档源（space_id，来自 list_spaces）下的全部文档，或同步全部文档源。立即返回任务 ID，用 get_job 查询进度。",
    inputSchema: {
      space_id: z.string().optional().describe("要同步的文档源 id（list_spaces 返回）；不传则同步全部文档源"),
      force: z.boolean().optional().describe("强制重新拉取全部文档，默认 false（只拉取有更新的）"),
    },
  }, async ({ space_id, force }) => {
    try {
      const jobId = space_id
        ? await services.engine.syncRoot(space_id, { force })
        : await services.engine.syncAll({ force });
      return text(JSON.stringify({
        job_id: jobId,
        note: "同步已在后台开始，使用 get_job 工具（传 job_id）查询进度与结果",
      }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- push_doc ----------

  server.registerTool("push_doc", {
    title: "回写飞书文档",
    description: "把本地 markdown 推回飞书，覆盖文档正文。照抄 MaomiAgent 四级策略：白板 mermaid 增量 → 无损原生块重推 → docs_ai 整文覆写（保留 callout/表格/图片等原生标签）→ 纯 Markdown 重建。推荐流程：read_doc 读取 → 本地编辑 .md → push_doc 回写。远端有新改动时会拒绝（force 可强制）；含 markdown 图片或超出策略范围时阻断并保留本地草稿。",
    inputSchema: {
      path: z.string().optional().describe("要回写的文档工作区相对路径（通常是刚编辑过的那个）"),
      token: z.string().optional().describe("或传飞书节点 token（与 path 二选一）"),
      force: z.boolean().optional().describe("强制覆盖远端（忽略版本冲突检查），默认 false"),
    },
  }, async ({ path: docPath, token, force }) => {
    try {
      const node = resolveDoc(services.store, { path: docPath, token });
      if (!node) {
        return fail(new Error(`索引中未找到该文档（path=${docPath ?? ""} token=${token ?? ""}）`));
      }
      const result = await services.engine.pushDoc(node.token, { force });
      return text(JSON.stringify({ ok: true, title: node.title, path: node.mdPath, ...result }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- get_job ----------

  server.registerTool("get_job", {
    title: "查询任务进度",
    description: "查询同步任务的进度与结果（done/changed/skipped/failed 计数与错误列表）。",
    inputSchema: {
      job_id: z.string().min(1).describe("sync_space/sync_doc 返回的任务 id"),
    },
  }, async ({ job_id }) => {
    try {
      const job = services.jobs.get(job_id);
      if (!job) {
        return fail(new Error(`任务不存在：${job_id}`));
      }
      return text(JSON.stringify(services.jobs.snapshot(job), null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- list_assets ----------

  server.registerTool("list_assets", {
    title: "列出文档资源",
    description: "列出一篇已同步文档的本地资源（图片/白板导出/附件），含工作区相对路径与绝对路径。",
    inputSchema: {
      path: z.string().optional().describe("文档的工作区相对路径"),
      token: z.string().optional().describe("飞书节点 token（与 path 二选一）"),
    },
  }, async ({ path: docPath, token }) => {
    try {
      const node = resolveDoc(services.store, { path: docPath, token });
      if (!node) {
        return fail(new Error(`索引中未找到该文档（path=${docPath ?? ""} token=${token ?? ""}）`));
      }
      const assets = (node.assetPaths ?? []).map((relative) => ({
        path: relative,
        absolute_path: path.join(WORKSPACE_DIR, ...relative.split("/")),
      }));
      return text(JSON.stringify({ title: node.title, total: assets.length, assets }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  // ---------- fetch_asset ----------

  server.registerTool("fetch_asset", {
    title: "下载飞书资源",
    description: "按飞书资源 token 随时下载资源（图片/附件/白板图片导出）到本地工作区，返回本地路径。适合需要查看文档内图片或下载附件的场景。",
    inputSchema: {
      token: z.string().min(1).describe("飞书资源 token（文档 markdown 中的图片/附件占位会给出）"),
      kind: z.enum(["file", "image", "whiteboard"]).optional().describe("资源类型，默认 file（whiteboard 会导出为图片）"),
    },
  }, async ({ token, kind }) => {
    try {
      const result = await services.tokens.withToken((accessToken) => downloadAsset({
        client: services.client,
        accessToken,
        token,
        kind: kind ?? "file",
        destDir: assetDirAbsolute("shared"),
      }));
      return text(JSON.stringify({
        ...result,
        relative_path: path.posix.join("_assets", "shared", result.fileName),
        absolute_path: path.join(assetDirAbsolute("shared"), result.fileName),
      }, null, 2));
    } catch (error) {
      return fail(error);
    }
  });

  return server;
}

function resolveDoc(
  store: WorkspaceStore,
  input: { path?: string; token?: string },
): NodeEntry | undefined {
  if (input.token) {
    return store.getNode(input.token);
  }
  if (input.path) {
    const normalized = input.path
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
    const workspacePrefix = `${WORKSPACE_DIR.replace(/\\/g, "/")}/`;
    const withoutWorkspace = normalized.startsWith(workspacePrefix)
      ? normalized.slice(workspacePrefix.length)
      : normalized;
    return Object.values(store.nodes).find((node) => node.mdPath === withoutWorkspace);
  }
  return undefined;
}

/** 挂载到 express（无状态模式：每个请求独立 server + transport，稳定支持各类 MCP 客户端） */
export function mountMcp(app: express.Express, buildServer: () => McpServer): void {
  app.post(MCP_ENDPOINT, async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: null,
        });
      }
    }
  });

  app.get(MCP_ENDPOINT, (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint: use POST (stateless mode)" }, id: null });
  });

  app.delete(MCP_ENDPOINT, (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP endpoint: stateless mode, no session to delete" }, id: null });
  });
}
