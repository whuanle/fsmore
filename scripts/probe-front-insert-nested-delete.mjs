/**
 * E2E 探测 v2（按文本内容定位块，不依赖自定义 id —— 飞书会重写 block_id）：
 * 1. /descendant parent_id=heading → 子块真的挂在标题下吗？
 * 2. /descendant index=0 → 落 root 最前吗？
 * 3. 标题子块的 batch_delete
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const config = JSON.parse(readFileSync(new URL("../data/config.json", import.meta.url), "utf8"));

async function main() {
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  const tokenJson = await tokenRes.json();
  if (tokenJson.code !== 0) throw new Error(`tenant token failed: ${JSON.stringify(tokenJson)}`);
  const accessToken = tokenJson.tenant_access_token;
  const api = async (method, path, body) => {
    const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };

  const created = await api("POST", "/docx/v1/documents", { title: "fsmore-probe-v2" });
  const docId = created.json.data.document.document_id;
  console.log("scratch doc:", docId);
  const newId = () => randomUUID().replace(/-/g, "").slice(0, 28);

  const textOf = (b) => JSON.stringify(b).match(/"content":"([^"]*)"/)?.[1] ?? "";
  const snapshot = async () => {
    const all = await api("GET", `/docx/v1/documents/${docId}/blocks?page_size=500`);
    const items = all.json.data?.items ?? [];
    const byId = new Map(items.map((i) => [i.block_id, i]));
    const describe = (id) => `${id}(t${i_type(byId.get(id))},"${textOf(byId.get(id) ?? {})}")`;
    function i_type(b) { return b?.block_type; }
    const rootId = items.find((i) => i.block_type === 1)?.block_id ?? docId;
    return { items, byId, rootId, describe };
  };

  try {
    const h = newId();
    const tail = newId();
    const mk = await api("POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: [h, tail],
      descendants: [
        { block_id: h, block_type: 4, parent_id: docId, heading2: { elements: [{ text_run: { content: "H" } }] } },
        { block_id: tail, block_type: 2, parent_id: docId, text: { elements: [{ text_run: { content: "TAIL" } }] } },
      ],
    });
    console.log("mk [H,TAIL]:", mk.json.code, "new block_ids:", JSON.stringify(mk.json.data?.blocks ?? mk.json.data ?? null).slice(0, 200));

    // 嵌套：parent_id = H
    const snap1 = await snapshot();
    const hRealId = snap1.items.find((i) => textOf(i) === "H")?.block_id;
    console.log("H real id:", hRealId);
    const nested = newId();
    const mkNested = await api("POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: [nested],
      descendants: [
        { block_id: nested, block_type: 2, parent_id: hRealId, text: { elements: [{ text_run: { content: "NESTED" } }] } },
      ],
    });
    console.log("mk NESTED parent_id=H:", mkNested.json.code, mkNested.json.msg);

    const snap2 = await snapshot();
    const nestedReal = snap2.items.find((i) => textOf(i) === "NESTED");
    const hBlock = snap2.byId.get(hRealId);
    console.log("H children:", JSON.stringify(hBlock?.children), "| NESTED id:", nestedReal?.block_id);
    console.log("=> NESTED 挂在 H 下?", (hBlock?.children ?? []).includes(nestedReal?.block_id));

    // front insert index=0
    const front = newId();
    const ins = await api("POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: [front],
      descendants: [
        { block_id: front, block_type: 2, parent_id: docId, text: { elements: [{ text_run: { content: "FRONT" } }] } },
      ],
      index: 0,
    });
    console.log("front insert index=0:", ins.json.code, ins.json.msg);
    const snap3 = await snapshot();
    const rootChildren = snap3.byId.get(snap3.rootId)?.children ?? [];
    console.log("root children 顺序:", rootChildren.map((id) => `"${textOf(snap3.byId.get(id) ?? {})}"`).join(" → "));

    // 删除标题子块
    if (nestedReal && (hBlock?.children ?? []).includes(nestedReal.block_id)) {
      const idx = hBlock.children.indexOf(nestedReal.blockId ?? nestedReal.block_id);
      const hChildrenNow = (await api("GET", `/docx/v1/documents/${docId}/blocks/${hRealId}/children?page_size=100`)).json.data?.items ?? [];
      const i2 = hChildrenNow.findIndex((i) => textOf(i) === "NESTED");
      const del = await api("DELETE", `/docx/v1/documents/${docId}/blocks/${hRealId}/children/batch_delete?document_revision_id=-1&client_token=${randomUUID()}`, {
        start_index: i2, end_index: i2 + 1,
      });
      console.log(`delete NESTED via heading children (idx=${i2}):`, del.json.code, del.json.msg);
      const snap4 = await snapshot();
      console.log("H children after:", JSON.stringify(snap4.byId.get(hRealId)?.children));
    }
  } finally {
    const del = await api("DELETE", `/drive/v1/files/${docId}?type=docx`);
    console.log("cleanup delete:", del.json.code, del.json.msg);
  }
}

main().catch((error) => {
  console.error("PROBE FAILED:", error.message);
  process.exitCode = 1;
});
