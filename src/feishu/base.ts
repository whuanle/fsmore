/** 飞书 OpenAPI 基地址：默认官方；可用 FSMORE_API_BASE 覆盖（支持 Lark 国际版 / 本地联调） */
export const FEISHU_API_BASE = (
  process.env.FSMORE_API_BASE ?? "https://open.feishu.cn/open-apis"
).replace(/\/+$/, "");

/** 飞书 OAuth 授权页基地址（扫码授权页面所在域） */
export const FEISHU_AUTH_BASE = (
  process.env.FSMORE_AUTH_BASE ?? "https://accounts.feishu.cn"
).replace(/\/+$/, "");

/**
 * 扫码授权申请的 scope。默认可写：docx:document 编辑文档（推送回飞书）；
 * board:whiteboard:node:read/create 读取画板与白板 mermaid 增量回写（对齐 MaomiAgent DEFAULT_DEVELOPER_SCOPES）。
 */
export function feishuOAuthScope(): string {
  return [
    "offline_access",
    "docx:document",
    "docx:document.block:convert",
    "wiki:wiki:readonly",
    "drive:drive:readonly",
    "board:whiteboard:node:read",
    "board:whiteboard:node:create",
  ].join(" ");
}
