import fs from "node:fs";
import type { FeishuUserTokens } from "./feishu/client.js";
import { CONFIG_PATH, DATA_DIR } from "./paths.js";

export type AppConfig = {
  appId: string;
  appSecret: string;
  port: number;
  host: string;
  syncConcurrency: number;
  /** 扫码授权获取的 user_access_token（存在时优先于 tenant 通道） */
  userToken?: FeishuUserTokens;
  /** 授权用户名（展示用） */
  userName?: string;
};

const DEFAULTS: AppConfig = {
  appId: "",
  appSecret: "",
  port: 7788,
  host: "127.0.0.1",
  syncConcurrency: 3,
};

export function loadConfig(): AppConfig {
  let fileValue: Partial<AppConfig> & { allowWrite?: boolean } = {};
  try {
    fileValue = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<AppConfig> & { allowWrite?: boolean };
  } catch {
    // 首次启动还没有配置文件
  }

  // allowWrite 开关已移除（默认可写），旧配置里的字段丢弃
  delete fileValue.allowWrite;

  const config: AppConfig = { ...DEFAULTS, ...fileValue };
  if (process.env.FSMORE_APP_ID) {
    config.appId = process.env.FSMORE_APP_ID;
  }
  if (process.env.FSMORE_APP_SECRET) {
    config.appSecret = process.env.FSMORE_APP_SECRET;
  }
  if (process.env.FSMORE_PORT) {
    config.port = Number(process.env.FSMORE_PORT) || DEFAULTS.port;
  }
  config.syncConcurrency = Math.min(8, Math.max(1, Number(config.syncConcurrency) || DEFAULTS.syncConcurrency));
  config.port = Math.max(1, Math.floor(config.port) || DEFAULTS.port);
  return config;
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 3)}${"*".repeat(value.length - 6)}${value.slice(-3)}`;
}
