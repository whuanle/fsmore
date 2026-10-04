/**
 * 探测飞书 /descendant 接口 index 参数的真实语义（应用身份 + 应用自有空间里的草稿文档，
 * 全程不触碰用户 user_token / refresh_token，不会污染实例授权）。
 * 复现 Bug：锚点是 heading 且 index=锚点位置+1 时，新块落进了 heading 内部而非 root。
 */
import { readFileSync } from "node:fs";

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
    const json = await res.json();
    return { status: res.status, json };
  };

  // 1. 建草稿文档（应用云空间）
  const created = await api("POST", "/docx/v1/documents", { title: "fsmore-desc-index-probe" });
  if (created.json.code !== 0) throw new Error(`create failed: ${JSON.stringify(created.json)}`);
  const docId = created.json.data.document.document_id;
  console.log("scratch doc:", docId);

  try {
    // 2. root 下建 [heading2, text, text]
    const h = "probH" + Date.now().toString(36);
    const a = "probA" + Date.now().toString(36);
    const b = "probB" + Date.now().toString(36);
    const mk = await api("POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: [h, a, b],
      descendants: [
        { block_id: h, block_type: 4, parent_id: docId, heading2: { elements: [{ text_run: { content: "H" } }] } },
        { block_id: a, block_type: 2, parent_id: docId, text: { elements: [{ text_run: { content: "A" } }] } },
        { block_id: b, block_type: 2, parent_id: docId, text: { elements: [{ text_run: { content: "B" } }] } },
      ],
    });
    console.log("mk blocks:", mk.json.code, mk.json.msg);

    const childrenOf = async () => {
      const r = await api("GET", `/docx/v1/documents/${docId}/blocks/${docId}/children?page_size=100`);
      return (r.json.data?.items ?? []).map((i) => `${i.block_id}:${i.block_type}`);
    };
    console.log("root children before:", await childrenOf());

    // 3. 完全复刻 executeTextPatch 的插入：锚点=heading2(root 第0位) index=1
    const x = "probX" + Date.now().toString(36);
    const ins = await api("POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: [x],
      descendants: [
        { block_id: x, block_type: 2, parent_id: docId, text: { elements: [{ text_run: { content: "X" } }] } },
      ],
      index: 1,
    });
    console.log("insert index=1:", ins.json.code, ins.json.msg);

    // 4. 拉全部 blocks 看 X 落在哪
    const all = await api("GET", `/docx/v1/documents/${docId}/blocks?page_size=500`);
    const blocks = all.json.data?.items ?? [];
    const xBlock = blocks.find((i) => i.block_id === x);
    console.log("X parent_id:", xBlock?.parent_id, "| X == root?", xBlock?.parent_id === docId);
    const hBlock = blocks.find((i) => i.block_id === h);
    console.log("H children:", JSON.stringify(hBlock?.children));
    console.log("root children after:", await childrenOf());

    // 5. 对照组：锚点=text A（root 第1/2位）时 index=2
    const y = "probY" + Date.now().toString(36);
    const ins2 = await api("POST", `/docx/v1/documents/${docId}/blocks/${docId}/descendant`, {
      children_id: [y],
      descendants: [
        { block_id: y, block_type: 2, parent_id: docId, text: { elements: [{ text_run: { content: "Y" } }] } },
      ],
      index: 2,
    });
    console.log("insert index=2:", ins2.json.code, ins2.json.msg);
    const all2 = await api("GET", `/docx/v1/documents/${docId}/blocks?page_size=500`);
    const blocks2 = all2.json.data?.items ?? [];
    const yBlock = blocks2.find((i) => i.block_id === y);
    console.log("Y parent_id:", yBlock?.parent_id, "| Y == root?", yBlock?.parent_id === docId);
    console.log("root children final:", await childrenOf());
  } finally {
    // 6. 尽力清理（无 drive 删除权限则留待人工，应用空间内不影响用户）
    const del = await api("DELETE", `/drive/v1/files/${docId}?type=docx`);
    console.log("cleanup delete:", del.json.code, del.json.msg);
  }
}

main().catch((error) => {
  console.error("PROBE FAILED:", error.message);
  process.exitCode = 1;
});
