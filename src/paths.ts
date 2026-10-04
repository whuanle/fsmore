import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(here, "..");

// 源码运行（仓库内有 src/index.ts）数据放仓库 data/；npm 安装的包只带 dist，数据放 ~/.fsmore，
// 避免 npm 重装/升级时清掉用户凭证与已同步文档
const runningFromSource = fs.existsSync(path.join(PROJECT_ROOT, "src", "index.ts"));
const defaultDataDir = runningFromSource
  ? path.join(PROJECT_ROOT, "data")
  : path.join(os.homedir(), ".fsmore");

/** 运行时数据目录（配置、索引、markdown 工作区） */
export const DATA_DIR = path.resolve(
  process.env.FSMORE_DATA_DIR ?? defaultDataDir,
);

/** markdown 工作区根目录：AI 直接读取这里的 .md 文件 */
export const WORKSPACE_DIR = path.resolve(
  process.env.FSMORE_WORKSPACE_DIR ?? path.join(DATA_DIR, "workspace"),
);

/** 工作区内资源（图片/附件/白板导出）统一放在该目录 */
export const ASSETS_DIR_NAME = "_assets";

export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const INDEX_PATH = path.join(DATA_DIR, "index.json");

export function ensureWorkspaceDir(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
