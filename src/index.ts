#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import { loadConfig, saveConfig } from "./config.js";
import { PROJECT_ROOT, ensureWorkspaceDir, WORKSPACE_DIR } from "./paths.js";
import { FeishuOpenApiClient, FeishuTokenManager, USER_TOKEN_AUTO_REFRESH_INTERVAL_MS } from "./feishu/client.js";
import { WorkspaceStore } from "./workspace/store.js";
import { JobManager } from "./jobs.js";
import { SyncEngine } from "./workspace/sync.js";
import { createApiRouter, type AppContext } from "./api/routes.js";
import { VIEWER_CSS } from "./web/viewer.js";
import { createMcpServer, mountMcp } from "./mcp/server.js";
import { MCP_ENDPOINT } from "./mcp/info.js";

const require = createRequire(import.meta.url);

function main(): void {
  let currentConfig = loadConfig();
  ensureWorkspaceDir();

  const store = new WorkspaceStore();
  const jobs = new JobManager();
  const client = new FeishuOpenApiClient();
  const tokens = new FeishuTokenManager(
    client,
    () => ({ appId: currentConfig.appId, appSecret: currentConfig.appSecret }),
    {
      get: () => currentConfig.userToken,
      save: (userToken) => {
        currentConfig = saveConfig({ userToken });
      },
      clear: () => {
        currentConfig = saveConfig({ userToken: undefined, userName: undefined });
      },
    },
  );
  const engine = new SyncEngine(() => currentConfig, client, tokens, store, jobs);

  // 用户令牌自动续期：启动即检查一次，此后每 60 秒心跳（距过期 <10 分钟时主动刷新）
  let lastLoggedRefreshError = "";
  const autoRefreshTick = async () => {
    try {
      const result = await tokens.autoRefreshTick();
      if (result.error && result.error !== lastLoggedRefreshError) {
        lastLoggedRefreshError = result.error;
        console.warn(`[auto-refresh] 用户令牌自动续期失败（将持续重试）：${result.error}`);
      } else if (!result.error) {
        lastLoggedRefreshError = "";
      }
    } catch {
      // 心跳本身不应中断服务
    }
  };
  void autoRefreshTick();
  const refreshTimer = setInterval(() => void autoRefreshTick(), USER_TOKEN_AUTO_REFRESH_INTERVAL_MS);

  const ctx: AppContext = {
    getConfig: () => currentConfig,
    setConfig: (patch) => {
      currentConfig = saveConfig(patch);
      return currentConfig;
    },
    client,
    tokens,
    store,
    jobs,
    engine,
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));

  // MCP（streamable HTTP，无状态）
  mountMcp(app, () => createMcpServer({ config: currentConfig, store, engine, jobs, client, tokens }));

  // REST API
  app.use("/api", createApiRouter(ctx));

  // markdown 工作区静态访问（预览图片等）
  app.use("/workspace", express.static(WORKSPACE_DIR, { fallthrough: true }));

  // marked（web 预览用，直接从 node_modules 提供）
  app.get("/vendor/marked.min.js", (_req, res) => {
    for (const candidate of ["marked/marked.min.js", "marked/lib/marked.umd.js"]) {
      try {
        res.type("application/javascript").sendFile(require.resolve(candidate));
        return;
      } catch {
        // 尝试下一个候选路径
      }
    }
    res.status(404).end("// marked not found");
  });

  // 查看器内页样式（/api/doc/render 输出的 iframe 用）
  app.get("/viewer-inner.css", (_req, res) => {
    res.type("text/css").send(VIEWER_CSS);
  });

  // Web UI。app.js / style.css / index.html 禁用缓存：
  // 无构建步骤、代码直接改文件，浏览器缓存旧 JS 会造成"功能不生效/页面异常"的疑难杂症
  const webDir = path.join(PROJECT_ROOT, "src", "web");
  app.use(express.static(webDir, {
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      const base = path.basename(filePath);
      if (base === "app.js" || base === "style.css" || base === "index.html") {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(webDir, "index.html"));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const server = app.listen(currentConfig.port, currentConfig.host, () => {
    const displayHost = currentConfig.host === "0.0.0.0" ? "127.0.0.1" : currentConfig.host;
    console.log("");
    console.log("  ┌─────────────────────────────────────────────────┐");
    console.log("  │  fsmore · 飞书本地 AI 工作台                     │");
    console.log("  └─────────────────────────────────────────────────┘");
    console.log("");
    console.log(`  Web 控制台:   http://${displayHost}:${currentConfig.port}`);
    console.log(`  MCP 端点:     http://${displayHost}:${currentConfig.port}${MCP_ENDPOINT}`);
    console.log(`  工作区目录:   ${WORKSPACE_DIR}`);
    console.log(`  数据目录:     ${path.dirname(store.indexPath)}`);
    console.log("");
    if (!currentConfig.appId) {
      console.log("  ⚠️  尚未配置飞书应用凭证，请打开 Web 控制台 → 设置 页完成配置");
      console.log("");
    }
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`端口 ${currentConfig.port} 已被占用。可修改 data/config.json 的 port 或设置环境变量 FSMORE_PORT。`);
      process.exit(1);
    }
    throw error;
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });

  const shutdown = () => {
    clearInterval(refreshTimer);
    store.flush();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 供 express.static 回退：确保 web 目录存在占位（首次运行前已随源码提供）
if (!fs.existsSync(path.join(PROJECT_ROOT, "src", "web", "index.html"))) {
  console.warn("警告：未找到 src/web/index.html，Web 控制台将不可用");
}

main();
