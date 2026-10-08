# fsmore · 飞书本地 AI 工作台

把飞书知识库 / 云空间文档同步为**本地 Markdown 文件**，提供 Web 管理界面，并通过 **MCP 服务**让 AI（Claude / Codex / Cursor / ZCode…）随时搜索、读取、同步甚至回写你的飞书文档。

## 安装

需要 Node.js ≥ 20。

```bash
npm install -g @whuanle/fsmore
```

免安装试用：

```bash
npx @whuanle/fsmore
```

## 启动

```bash
fsmore
```

打开 <http://127.0.0.1:7788> 即是 Web 控制台，`Ctrl+C` 停止。

## 首次使用

1. 到[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**，在「权限管理」开通以下权限并**发布版本**：

   | 权限 | 用途 |
   | --- | --- |
   | `docx:document` | 读取与编辑文档 |
   | `docx:document.block:convert` | Markdown 与文档块互转 |
   | `wiki:wiki:readonly` | 读取知识库 |
   | `wiki:wiki` | 在知识库节点下新建文档 |
   | `drive:drive:readonly` | 读取云空间与图片附件 |
   | `search:docs:read` | 在线搜索云文档（搜索在线文档并自动拉取） |
   | `board:whiteboard:node:read` | 读取画板 |
   | `board:whiteboard:node:create` | 画板回写 |

2. Web 控制台 → **设置**，填入 App ID / App Secret 保存；
3. 复制设置页显示的回调地址（`http://127.0.0.1:7788/api/oauth/callback`），粘贴到开放平台应用的「安全设置 → 重定向 URL」，否则授权页会报「redirect_uri 不合法」；
4. 设置页点**「打开飞书扫码授权」**，用飞书扫码确认。授权长期自动续期，过期会提示重新扫码。

之后到**文档树**页粘贴知识库 / 云空间文件夹 / 单篇文档的链接，点 **⬇ 拉取** / **⟳ 同步全部**，文档即同步为本地 Markdown。

## MCP 接入

端点：<http://127.0.0.1:7788/mcp>（Streamable HTTP）

```json
{
  "mcpServers": {
    "fsmore": { "url": "http://127.0.0.1:7788/mcp" }
  }
}
```

**Claude Code**

```bash
claude mcp add --transport http fsmore http://127.0.0.1:7788/mcp
```

**Codex CLI**（`~/.codex/config.toml`）

```toml
[mcp_servers.fsmore]
url = "http://127.0.0.1:7788/mcp"
```

常用工具：`search_online` 在飞书云端搜索文档（不限已同步范围，命中后自动拉取到本地），`get_tree` 获取目录树（可从任意节点展开），`resolve_docs` 批量解析 token/标题到本地路径，`create_doc` 新建飞书文档，`add_root` 添加文档源，`search_docs` / `read_doc` 搜索与读取本地文档，`sync_doc` / `sync_space` 按需拉取最新版，`list_assets` / `fetch_asset` 获取图片附件，`push_doc` 把本地修改回写飞书（完整清单见 Web 控制台「MCP 接入」页）。也可以不用 MCP，直接让 AI 读取工作区目录下的 `.md` 文件。

## 数据与配置

数据默认存放在 `~/.fsmore/`（源码运行时为仓库 `data/`），其中 `workspace/` 是给 AI 读写的 Markdown 工作区。

| 环境变量 | 说明 |
| --- | --- |
| `FSMORE_PORT` | 服务端口（默认 7788，改后需同步更新飞书重定向 URL） |
| `FSMORE_DATA_DIR` | 数据目录 |
| `FSMORE_WORKSPACE_DIR` | Markdown 工作区目录 |
| `FSMORE_APP_ID` / `FSMORE_APP_SECRET` | 飞书应用凭证（也可在设置页填写） |
| `FSMORE_API_BASE` | 飞书 API 基地址，Lark 国际版设为 `https://open.larksuite.com/open-apis` |

服务默认只监听 127.0.0.1 且无鉴权，请勿暴露到公网。

## 开发

```bash
git clone https://github.com/whuanle/fsmore.git
cd fsmore && npm install
npm run dev          # 开发模式
npm test             # 单元测试
bash scripts/e2e.sh  # 端到端测试（内置飞书 API 模拟，无需真实凭证）
```

MIT License。飞书文档转换核心移植自 [MaomiAgent](https://github.com/) 项目。
