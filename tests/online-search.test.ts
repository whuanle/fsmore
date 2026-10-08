import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

// WORKSPACE_DIR / DATA_DIR 在模块加载时解析：先指到临时目录，再动态导入被测模块
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsmore-online-"));
process.env.FSMORE_DATA_DIR = tmpDir;

type Modules = typeof import("../src/workspace/sync.js") & typeof import("../src/feishu/search.js");
let mods: Modules;

function textRun(content: string) {
  return { text_run: { content, text_element_style: {} } };
}

/** 假飞书客户端：按 URL 分发（wiki 解析 / docx meta / blocks / 在线搜索） */
function fakeClient(overrides: {
  searchResponse?: Record<string, unknown>;
  wikiNode?: Record<string, unknown> | null;
} = {}) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const docMeta = (documentId: string, title: string, revisionId: number) => ({
    document: { document_id: documentId, title, revision_id: revisionId },
  });
  const docBlocks = (documentId: string) => ({
    items: [
      { block_id: documentId, block_type: 1, children: ["b1"] },
      { block_id: "b1", block_type: 2, parent_id: documentId, text: { elements: [textRun("正文内容")] } },
    ],
    has_more: false,
  });

  const client = {
    async getJson(url: string) {
      calls.push({ url });
      if (url.includes("/wiki/v2/spaces/get_node")) {
        if (overrides.wikiNode === null) {
          throw new Error("飞书 API 错误 230027：not found");
        }
        return { node: overrides.wikiNode };
      }
      if (/\/docx\/v1\/documents\/[^/]+\/blocks/.test(url)) {
        const docId = /\/documents\/([^/?]+)\/blocks/.exec(url)?.[1] ?? "";
        return docBlocks(docId);
      }
      if (/\/docx\/v1\/documents\//.test(url)) {
        if (url.includes("DOCN1")) {
          return docMeta("DOCN1", "Wiki 命中文档", 11);
        }
        return docMeta("DOCD1", "云文档命中文档", 5);
      }
      return {};
    },
    async postJson(url: string, _token: string, body: unknown) {
      calls.push({ url, body });
      if (url.includes("/search/v2/doc_wiki/search")) {
        return overrides.searchResponse ?? {};
      }
      return {};
    },
  };
  return { client: client as unknown as import("../src/feishu/client.js").FeishuOpenApiClient, calls };
}

before(async () => {
  mods = await import("../src/workspace/sync.js") as Modules;
  await import("../src/feishu/search.js");
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- searchOnlineDocs：响应解析 ----------

test("解析云端搜索响应：高亮清洗、时间转换、syncable 判定、翻页透传", async () => {
  const { searchOnlineDocs } = await import("../src/feishu/search.js");
  const { client, calls } = fakeClient({
    searchResponse: {
      total: 42,
      has_more: true,
      page_token: "next-page",
      res_units: [
        {
          title_highlighted: "登录<em>设计</em>方案",
          summary_highlighted: "关于<em>设计</em>的摘要…",
          entity_type: "DOC",
          result_meta: { token: "DOCD1", doc_types: ["DOCX"], update_time: 1760000000, url: "https://feishu.cn/docx/DOCD1", owner_name: "张三" },
        },
        {
          title_highlighted: "设计表格",
          entity_type: "WIKI",
          result_meta: { token: "wikNode1", doc_types: ["WIKI"], update_time: "1760000100" },
        },
        {
          title_highlighted: "预算表",
          entity_type: "DOC",
          result_meta: { token: "SHEET1", doc_types: ["SHEET"] },
        },
      ],
    },
  });

  const result = await searchOnlineDocs(client, "token", { query: "设计", pageSize: 15 });

  assert.equal(result.total, 42);
  assert.equal(result.has_more, true);
  assert.equal(result.page_token, "next-page");
  assert.deepEqual(result.hits.map((hit) => hit.token), ["DOCD1", "wikNode1", "SHEET1"]);
  assert.equal(result.hits[0]!.title, "登录设计方案");
  assert.equal(result.hits[0]!.summary, "关于设计的摘要…");
  assert.equal(result.hits[0]!.update_time, new Date(1760000000 * 1000).toISOString());
  assert.equal(result.hits[0]!.syncable, true);
  assert.equal(result.hits[1]!.entity_type, "WIKI");
  assert.equal(result.hits[1]!.syncable, true);
  assert.equal(result.hits[2]!.syncable, false);

  const searchCall = calls.find((call) => call.url.includes("/search/v2/doc_wiki/search"));
  assert.ok(searchCall);
  const body = searchCall.body as Record<string, unknown>;
  assert.equal(body.query, "设计");
  assert.equal(body.page_size, 15);
  assert.ok(body.doc_filter && body.wiki_filter, "接口要求至少一个筛选器");
});

test("query 校验：空/超长报错", async () => {
  const { searchOnlineDocs } = await import("../src/feishu/search.js");
  const { client } = fakeClient();
  await assert.rejects(searchOnlineDocs(client, "t", { query: "  " }), /不能为空/);
  await assert.rejects(searchOnlineDocs(client, "t", { query: "一".repeat(31) }), /30 字符/);
});

// ---------- pullOnlineDoc：注册到「在线搜索」根并拉取 ----------

test("DOC 命中：注册节点并同步出 markdown", async () => {
  const { SyncEngine, ONLINE_SEARCH_ROOT_ID } = mods;
  const { WorkspaceStore } = await import("../src/workspace/store.js");
  const store = new WorkspaceStore(path.join(tmpDir, "index-doc.json"));
  const { client } = fakeClient();
  const tokens = { withToken: (fn: (t: string) => unknown) => fn("fake-token") };
  const engine = new SyncEngine(
    () => ({ syncConcurrency: 2 }) as never,
    client,
    tokens as never,
    store,
    {} as never,
  );

  const result = await engine.pullOnlineDoc({ token: "DOCD1", entityType: "DOC", title: "云文档命中文档" });

  assert.equal(result.changed, true);
  assert.equal(result.mdPath, ".maomi/feishu-docs/DOCD1.md");

  const node = store.getNode("DOCD1");
  assert.ok(node);
  assert.equal(node.kind, "doc");
  assert.equal(node.docId, "DOCD1");
  assert.equal(node.rootId, ONLINE_SEARCH_ROOT_ID);
  assert.equal(node.parentToken, ONLINE_SEARCH_ROOT_ID);

  const root = store.roots.find((item) => item.id === ONLINE_SEARCH_ROOT_ID);
  assert.ok(root, "应创建「在线搜索」虚拟文档源");
  assert.equal(root.kind, "search");
  assert.ok(store.getNode(ONLINE_SEARCH_ROOT_ID)?.childrenListedAt, "虚拟根应标记已列出，避免被同步任务向远端列树");

  const md = fs.readFileSync(path.join(tmpDir, "workspace", ...result.mdPath.split("/")), "utf8");
  assert.match(md, /feishu_doc_id: "?DOCD1"?/);
  assert.match(md, /正文内容/);

  // 幂等：再拉一次命中同一节点 → revision 未变直接跳过
  const again = await engine.pullOnlineDoc({ token: "DOCD1", entityType: "DOC" });
  assert.equal(again.skipped, true);
});

test("WIKI 命中：解析 obj_token 后同步；非 docx 类型拒绝", async () => {
  const { SyncEngine } = mods;
  const { WorkspaceStore } = await import("../src/workspace/store.js");
  const store = new WorkspaceStore(path.join(tmpDir, "index-wiki.json"));
  const tokens = { withToken: (fn: (t: string) => unknown) => fn("fake-token") };
  const engine = new SyncEngine(
    () => ({ syncConcurrency: 2 }) as never,
    fakeClient({ wikiNode: { node_token: "wikNode1", obj_token: "DOCN1", obj_type: "docx", space_id: "sp1", title: "Wiki 命中文档" } }).client,
    tokens as never,
    store,
    {} as never,
  );

  const result = await engine.pullOnlineDoc({ token: "wikNode1", entityType: "WIKI" });
  assert.equal(result.changed, true);
  const node = store.getNode("wikNode1");
  assert.ok(node);
  assert.equal(node.docId, "DOCN1");
  assert.equal(node.title, "Wiki 命中文档");

  // sheet 类型的 wiki 节点：明确拒绝
  const engineSheet = new SyncEngine(
    () => ({ syncConcurrency: 2 }) as never,
    fakeClient({ wikiNode: { node_token: "wikSheet", obj_token: "SHT1", obj_type: "sheet", space_id: "sp1", title: "表格" } }).client,
    tokens as never,
    store,
    {} as never,
  );
  await assert.rejects(
    engineSheet.pullOnlineDoc({ token: "wikSheet", entityType: "WIKI" }),
    /暂不支持同步/,
  );
});

test("WIKI 命中但节点不存在：给出可读错误", async () => {
  const { SyncEngine } = mods;
  const { WorkspaceStore } = await import("../src/workspace/store.js");
  const store = new WorkspaceStore(path.join(tmpDir, "index-404.json"));
  const tokens = { withToken: (fn: (t: string) => unknown) => fn("fake-token") };
  const engine = new SyncEngine(
    () => ({ syncConcurrency: 2 }) as never,
    fakeClient({ wikiNode: null }).client,
    tokens as never,
    store,
    {} as never,
  );
  await assert.rejects(
    engine.pullOnlineDoc({ token: "wikGone", entityType: "WIKI" }),
    /无法解析 wiki 节点/,
  );
});

// ---------- MCP 工具注册 ----------

test("MCP 服务注册了 search_online 工具", async () => {
  const { createMcpServer } = await import("../src/mcp/server.js");
  const { WorkspaceStore } = await import("../src/workspace/store.js");
  const services = {
    config: {},
    store: new WorkspaceStore(path.join(tmpDir, "index-mcp.json")),
    engine: {},
    jobs: {},
    client: {},
    tokens: {},
  } as never;
  const server = createMcpServer(services);

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fsmore-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools } = await client.listTools();
  const tool = tools.find((item) => item.name === "search_online");
  assert.ok(tool, "应注册 search_online 工具");
  assert.match(tool!.description ?? "", /飞书云端/);
  await client.close();
  await server.close();
});
