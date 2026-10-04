/** MCP 端点路径与工具清单（供 server / Web UI / /api/mcp/info 共用） */

export const MCP_ENDPOINT = "/mcp";

export const MCP_TOOLS_INFO: Array<{ name: string; description: string }> = [
  { name: "list_spaces", description: "列出已添加的飞书文档源与本地 markdown 工作区路径" },
  { name: "list_docs", description: "列出已同步的文档（路径/标题/token/同步时间/版本），支持按源与关键词过滤" },
  { name: "search_docs", description: "在本地全部 markdown 中做关键词全文搜索，返回得分与摘要" },
  { name: "read_doc", description: "读取一篇文档的 markdown（支持按路径或飞书 token 定位，支持长文分段）" },
  { name: "get_doc_meta", description: "查看文档元信息：飞书原文链接、版本、同步时间、资源列表" },
  { name: "sync_doc", description: "把一篇文档从飞书拉取/更新到本地（版本未变化时跳过）" },
  { name: "sync_space", description: "后台同步一个文档源或全部文档源，返回任务 id" },
  { name: "get_job", description: "查询后台同步任务的进度与结果" },
  { name: "list_assets", description: "列出文档内图片/附件/白板的本地文件路径" },
  { name: "fetch_asset", description: "按飞书资源 token 随时下载资源到本地（图片/附件/白板导出）" },
  { name: "push_doc", description: "把本地 markdown 回写覆盖飞书文档正文（四级无损策略：白板增量/无损原生块重推/docs_ai 覆写/纯 Markdown 重建；需开启写入权限）" },
];
