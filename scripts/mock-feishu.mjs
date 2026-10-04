/**
 * 飞书 OpenAPI 模拟服务器（仅用于本地端到端联调/演示，scripts/e2e.sh 配套使用）。
 * 覆盖：tenant token、wiki get_node、wiki nodes、docx document/blocks、媒体下载。
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_FEISHU_PORT ?? 7999);

// 1x1 红色 PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const spaceId = "7891234567890123456";
const rootNodeToken = "wikmockroot01";
const rootDocId = "DOCmockroot001";
const childDocId = "DOCmockchild01";
const childNodeToken = "wikmockchild01";
const pureDocId = "DOCmockpure001";
const pureNodeToken = "wikmockpure01";
const calloutDocId = "DOCmockcallout01";
const calloutNodeToken = "wikmockcallout01";
const docToken = "DOCmockdoc0001";

const wikiNode = (item) => ({
  node_token: item.nodeToken,
  obj_token: item.objToken,
  obj_type: "docx",
  title: item.title,
  has_child: !!item.hasChild,
  space_id: spaceId,
  parent_node_token: item.parent ?? rootNodeToken,
});

const blocksOf = (documentId, title) => [
  { block_id: documentId, block_type: 1, children: ["b_h1", "b_text", "b_bullet", "b_ordered", "b_todo", "b_code", "b_quote", "b_table", "b_img", "b_file", "b_divider"], parent_id: "" },

  { block_id: "b_h1", block_type: 3, parent_id: documentId, children: [], heading1: { elements: [{ text_run: { content: "产品概述", text_element_style: {} } }] } },
  {
    block_id: "b_text", block_type: 2, parent_id: documentId, children: [],
    text: {
      elements: [
        { text_run: { content: "这是", text_element_style: {} } },
        { text_run: { content: "加粗", text_element_style: { bold: true } } },
        { text_run: { content: "与", text_element_style: {} } },
        { text_run: { content: "inlineCode()", text_element_style: { inline_code: true } } },
        { text_run: { content: "以及链接", text_element_style: { link: { url: "https://example.com" } } } },
      ],
    },
  },
  { block_id: "b_bullet", block_type: 12, parent_id: documentId, children: ["b_bullet_child"], bullet: { elements: [{ text_run: { content: "一级要点", text_element_style: {} } }] } },
  { block_id: "b_bullet_child", block_type: 12, parent_id: "b_bullet", children: [], bullet: { elements: [{ text_run: { content: "二级要点", text_element_style: {} } }] } },
  { block_id: "b_ordered", block_type: 13, parent_id: documentId, children: [], ordered: { elements: [{ text_run: { content: "有序步骤", text_element_style: {} } }] } },
  { block_id: "b_todo", block_type: 17, parent_id: documentId, children: [], todo: { elements: [{ text_run: { content: "待办事项", text_element_style: {} } }], style: { done: false } } },
  { block_id: "b_code", block_type: 14, parent_id: documentId, children: [], code: { elements: [{ text_run: { content: "console.log(\"hi\");", text_element_style: {} } }], style: { language: 26 } } },
  { block_id: "b_quote", block_type: 15, parent_id: documentId, children: [], quote: { elements: [{ text_run: { content: "引用一句话", text_element_style: {} } }] } },
  {
    block_id: "b_table", block_type: 31, parent_id: documentId,
    children: ["c1", "c2", "c3", "c4"],
    table: { cells: ["c1", "c2", "c3", "c4"], property: { row_size: 2, column_size: 2, header_row: true } },
  },
  { block_id: "c1", block_type: 32, parent_id: "b_table", table_cell: { elements: [{ text_run: { content: "模块", text_element_style: {} } }] } },
  { block_id: "c2", block_type: 32, parent_id: "b_table", table_cell: { elements: [{ text_run: { content: "状态", text_element_style: {} } }] } },
  { block_id: "c3", block_type: 32, parent_id: "b_table", table_cell: { elements: [{ text_run: { content: "同步引擎", text_element_style: {} } }] } },
  { block_id: "c4", block_type: 32, parent_id: "b_table", table_cell: { elements: [{ text_run: { content: "已完成", text_element_style: {} } }] } },
  { block_id: "b_img", block_type: 27, parent_id: documentId, children: [], image: { token: "imgmock001", width: 690, height: 1256 } },
  { block_id: "b_file", block_type: 28, parent_id: documentId, children: [], file: { token: "filemock01", name: "需求附件.pdf" } },
  { block_id: "b_divider", block_type: 16, parent_id: documentId, children: [], divider: {} },
].map((block) => (block.block_id === documentId ? { ...block, ...{ /* title 不在 block 里 */ } } : block));

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

/** 记录收到的写请求，供 e2e 断言：GET /__calls 查看 */
const calls = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // ---------- 写接口（回写链路，需在通用 document 路由之前匹配） ----------

  if (p === "/open-apis/docx/v1/documents/blocks/convert" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      calls.push({ api: "convert", content: JSON.parse(body || "{}").content });
      json(res, 200, {
        code: 0,
        data: {
          first_level_block_ids: ["nb1", "nb2"],
          blocks: [
            { block_id: "nb1", block_type: 2, text: { elements: [{ text_run: { content: "回写内容第一段", text_element_style: {} } }] } },
            { block_id: "nb2", block_type: 2, text: { elements: [{ text_run: { content: "回写内容第二段", text_element_style: {} } }] } },
          ],
        },
      });
    });
    return;
  }

  if (p.startsWith("/open-apis/docs_ai/v1/documents/") && req.method === "PUT") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      calls.push({ api: "docs_ai_overwrite", content: parsed.content, format: parsed.format });
      json(res, 200, { code: 0, data: { document: { revision_id: 44 }, result: "success", new_blocks: [] } });
    });
    return;
  }

  if (/^\/open-apis\/docx\/v1\/documents\/[^/]+\/blocks\/[^/]+\/children$/.test(p) && req.method === "GET") {
    return json(res, 200, { code: 0, data: { items: [], has_more: false } });
  }

  if (p.endsWith("/children/batch_delete") && req.method === "DELETE") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      calls.push({ api: "batch_delete", query: Object.fromEntries(url.searchParams), body: JSON.parse(body || "{}") });
      json(res, 200, { code: 0, data: { document_revision_id: 42 } });
    });
    return;
  }

  if (p.endsWith("/descendant") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      calls.push({ api: "descendant", query: Object.fromEntries(url.searchParams), body: JSON.parse(body || "{}") });
      json(res, 200, { code: 0, data: { document_revision_id: 43 } });
    });
    return;
  }

  if (p === "/__calls") {
    return json(res, 200, { calls });
  }

  // ---------- 读接口 ----------

  if (p === "/open-apis/auth/v3/tenant_access_token/internal") {
    return json(res, 200, { code: 0, msg: "ok", data: { tenant_access_token: "t-mock-token", expire: 7200 } });
  }

  if (p === "/open-apis/wiki/v2/spaces/get_node") {
    const token = url.searchParams.get("token");
    if (token === rootNodeToken) {
      return json(res, 200, { code: 0, data: { node: { node_token: rootNodeToken, obj_token: rootDocId, obj_type: "docx", title: "产品空间", has_child: true, space_id: spaceId } } });
    }
    return json(res, 200, { code: 0, data: { node: { node_token: token, obj_token: docToken, obj_type: "docx", title: "单篇文档", has_child: false, space_id: spaceId } } });
  }

  if (p === `/open-apis/wiki/v2/spaces/${spaceId}/nodes`) {
    const parent = url.searchParams.get("parent_node_token");
    const items = parent === rootNodeToken
      ? [
          wikiNode({ nodeToken: childNodeToken, objToken: childDocId, title: "需求文档", hasChild: false }),
          wikiNode({ nodeToken: pureNodeToken, objToken: pureDocId, title: "纯文本文档", hasChild: false }),
          wikiNode({ nodeToken: calloutNodeToken, objToken: calloutDocId, title: "高亮块文档", hasChild: false }),
        ]
      : [];
    return json(res, 200, { code: 0, data: { items, has_more: false } });
  }

  if (p.startsWith("/open-apis/docx/v1/documents/") && p.endsWith("/blocks")) {    const documentId = p.split("/")[5];
    if (documentId === pureDocId) {
      // 纯文本文档：无任何原生块 → 推送走纯 Markdown 重建策略
      return json(res, 200, {
        code: 0,
        data: {
          items: [
            { block_id: documentId, block_type: 1, children: ["p_h1", "p_text"], parent_id: "" },
            { block_id: "p_h1", block_type: 3, parent_id: documentId, children: [], heading1: { elements: [{ text_run: { content: "纯文本文档", text_element_style: {} } }] } },
            { block_id: "p_text", block_type: 2, parent_id: documentId, children: [], text: { elements: [{ text_run: { content: "只有文字与标题的内容，可直接回写。", text_element_style: {} } }] } },
          ],
          has_more: false,
        },
      });
    }
    if (documentId === calloutDocId) {
      // 高亮块文档：含 callout 兼容原生块 → 推送走 docs_ai 整文覆写
      return json(res, 200, {
        code: 0,
        data: {
          items: [
            { block_id: documentId, block_type: 1, children: ["c_h1", "c_callout", "c_body"], parent_id: "" },
            { block_id: "c_h1", block_type: 3, parent_id: documentId, children: [], heading1: { elements: [{ text_run: { content: "高亮块文档", text_element_style: {} } }] } },
            { block_id: "c_callout", block_type: 19, parent_id: documentId, children: ["c_callout_body"], callout: { background_color: 1 } },
            { block_id: "c_callout_body", block_type: 2, parent_id: "c_callout", children: [], text: { elements: [{ text_run: { content: "重要提示内容", text_element_style: {} } }] } },
            { block_id: "c_body", block_type: 2, parent_id: documentId, children: [], text: { elements: [{ text_run: { content: "正文段落。", text_element_style: {} } }] } },
          ],
          has_more: false,
        },
      });
    }
    return json(res, 200, { code: 0, data: { items: blocksOf(documentId, "文档标题"), has_more: false } });
  }
  if (p.startsWith("/open-apis/docx/v1/documents/")) {
    const documentId = p.split("/")[5];
    const titles = {
      [rootDocId]: "产品空间首页",
      [childDocId]: "需求文档",
      [pureDocId]: "纯文本文档",
      [calloutDocId]: "高亮块文档",
    };
    return json(res, 200, { code: 0, data: { document: { document_id: documentId, title: titles[documentId] || documentId, revision_id: 42 } } });
  }

  if (p === "/open-apis/drive/v1/medias/imgmock001/download") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(PNG_BYTES);
  }
  if (p === "/open-apis/drive/v1/medias/filemock01/download") {
    res.writeHead(200, { "content-type": "application/pdf" });
    return res.end("%PDF-1.4 mock");
  }

  return json(res, 404, { code: 99991661, msg: `mock 未实现: ${p}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-feishu] listening on http://127.0.0.1:${PORT}`);
});
