/* fsmore Web 控制台（无构建依赖的原生 JS 单页应用） */
"use strict";

// ---------- 基础工具 ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, type = "info", ms = 4000) {
  const box = el("div", { class: `toast ${type === "error" ? "err" : type === "ok" ? "ok" : ""}` });
  box.textContent = message;
  document.getElementById("toasts").append(box);
  setTimeout(() => box.remove(), ms);
}

async function copyText(text, hint = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(hint, "ok", 2000);
  } catch {
    const input = el("textarea", { style: "position:fixed;opacity:0" });
    input.value = text;
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
    toast(hint, "ok", 2000);
  }
}

/** 应用内确认弹窗（替代原生 confirm）：resolve(true/false) */
function confirmModal({ message, confirmText = "确定", danger = false }) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirmModal");
    const ok = document.getElementById("confirmOk");
    document.getElementById("confirmText").textContent = message;
    ok.textContent = confirmText;
    ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    modal.classList.remove("hidden");
    ok.focus();
    const close = (value) => {
      modal.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      document.getElementById("confirmCancel").removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (event) => { if (event.target === modal) close(false); };
    const onKey = (event) => { if (event.key === "Escape") close(false); };
    ok.addEventListener("click", onOk);
    document.getElementById("confirmCancel").addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function iconFor(node) {
  if (node.kind === "folder") return "📁";
  if (node.kind === "space") return "📚";
  if (node.kind === "doc") return "📄";
  const type = node.objType || "";
  if (type === "sheet") return "📈";
  if (type === "bitable") return "📊";
  if (type === "mindnote") return "🧠";
  if (type === "file") return "📎";
  if (type === "slides") return "🖼️";
  return "🗂️";
}

// ---------- 全局状态 ----------

const state = {
  status: null,
  roots: [],
  childrenCache: new Map(), // token -> [{node}]
  expanded: new Set(),
  currentJobId: null,
  jobSource: null,
  snippetTab: "generic",
  selectedToken: null,
  viewerPath: null,
  viewerNode: null,
  autoHealedBoards: null, // 已自动补拉过画板的文档 token（每个文档一次，防循环）
  search: { query: "", hits: null, loading: false, error: null }, // 文档标题搜索（左目录）
};

// ---------- 视图切换 ----------

const views = ["docs", "mcp", "settings"];

function switchView(name) {
  for (const item of document.querySelectorAll("#nav .nav-item")) {
    item.classList.toggle("active", item.dataset.view === name);
  }
  for (const view of views) {
    document.getElementById(`view-${view}`).classList.toggle("active", view === name);
  }
  if (name === "mcp") refreshMcp();
  if (name === "settings") refreshSettings();
}

document.getElementById("nav").addEventListener("click", (event) => {
  const button = event.target.closest(".nav-item");
  if (button) switchView(button.dataset.view);
});

// ---------- 侧栏收缩 ----------

function setSidebarCollapsed(collapsed) {
  document.getElementById("app").classList.toggle("collapsed", collapsed);
  document.getElementById("sidebarToggle").textContent = collapsed ? "»" : "«";
  document.getElementById("sidebarToggle").title = collapsed ? "展开侧栏" : "收起侧栏";
  try { localStorage.setItem("fsmore.sidebarCollapsed", collapsed ? "1" : "0"); } catch { /* 忽略 */ }
}

document.getElementById("sidebarToggle").addEventListener("click", () => {
  setSidebarCollapsed(!document.getElementById("app").classList.contains("collapsed"));
});

try { setSidebarCollapsed(localStorage.getItem("fsmore.sidebarCollapsed") === "1"); } catch { /* 忽略 */ }

// ---------- 状态卡 ----------

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
    const status = state.status;
    const dot = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    dot.className = `dot ${status.configured ? (status.connected ? "dot-green" : "dot-amber") : "dot-red"}`;
    text.textContent = !status.configured
      ? "未配置凭证"
      : status.connected
        ? "已连接飞书"
        : "已配置，未验证";
  } catch (error) {
    document.getElementById("statusText").textContent = "服务不可用";
  }
}

// ---------- 飞书文档视图 ----------

async function refreshRoots() {
  try {
    const data = await api("/api/roots");
    state.roots = data.roots || [];
    renderTree();
  } catch (error) {
    toast(`加载文档源失败：${error.message}`, "error");
  }
}

async function removeRoot(node) {
  if (!(await confirmModal({ message: `移除文档源「${node.title}」？`, confirmText: "移除", danger: true }))) return;
  try {
    await api(`/api/roots/${node.rootId}`, { method: "DELETE" });
    state.expanded.delete(node.token);
    state.childrenCache.delete(node.token);
    await Promise.all([refreshRoots(), refreshStatus()]);
    toast("已移除", "ok", 1500);
  } catch (error) {
    toast(`移除失败：${error.message}`, "error");
  }
}

async function submitAddRoot(link, inputEl) {
  if (!link.trim()) return;
  try {
    const data = await api("/api/roots", { method: "POST", body: { link } });
    inputEl.value = "";
    toast("已添加文档源，正在展开目录…", "ok");
    await refreshRoots();
    // 自动展开新添加的源并拉取目录
    const root = state.roots.find((item) => item.id === data.rootId);
    if (root && root.kind !== "doc") {
      state.expanded.add(root.token);
      renderTree();
      const rootNode = {
        token: root.token,
        kind: root.kind === "wiki_space" ? "space" : root.kind === "folder" ? "folder" : root.kind === "doc" ? "doc" : "wiki",
        title: root.title,
        hasChild: root.kind !== "doc",
        objType: root.kind === "doc" ? "docx" : undefined,
        mdPath: null,
      };
      await refreshChildren(rootNode, true);
    }
  } catch (error) {
    toast(`添加失败：${error.message}`, "error", 8000);
  }
}

function treeRow(node, depth) {
  // 除 sheet/bitable 等资源节点外，有下级即可展开（wiki 里的文档也可能有下级文档）
  const canExpand = !!node.hasChild && node.kind !== "other";
  const row = el("div", {
    class: `tree-row ${node.token === state.selectedToken ? "selected" : ""}`,
    "data-token": node.token,
  });

  const expander = el("button", {
    class: `expander ${canExpand ? "" : "hidden-slot"} ${state.expanded.has(node.token) ? "open" : ""}`,
    title: canExpand ? "展开/收起" : "",
    onclick: canExpand ? () => toggleNode(node, container, expander) : undefined,
  });

  const isDoc = node.kind === "doc";
  const title = el("span", {
    class: `node-title ${isDoc ? "is-doc" : canExpand ? "is-branch" : ""} ${node.syncError ? "has-error" : ""}`,
    title: node.syncError ? `${node.title}\n${node.syncError}` : (node.remoteUrl ? `${node.title}\n${node.remoteUrl}` : node.title),
    onclick: isDoc ? () => selectDoc(node) : canExpand ? () => toggleNode(node, container, expander) : undefined,
  }, node.title);

  // 树内只保留一个操作：文档源根节点的删除图标
  const actions = el("span", { class: "node-actions" });
  if (node.rootId && !isDoc) {
    actions.append(el("button", {
      class: "btn-link tree-delete",
      title: "移除文档源（本地已同步的 markdown 文件会保留）",
      onclick: () => removeRoot(node),
    }, "🗑"));
  }

  row.append(
    expander,
    el("span", { class: "node-icon" }, iconFor(node)),
    title,
    actions,
  );

  const container = el("div", { class: "tree-node", "data-token": node.token }, row);
  if (state.expanded.has(node.token)) {
    const children = state.childrenCache.get(node.token);
    if (children) {
      container.append(renderChildrenList(node, children, depth));
    } else {
      void refreshChildren(node, false, container, depth);
    }
  }
  return container;
}

function renderChildrenList(parent, children, depth) {
  const list = el("div", { class: "tree-children" });
  if (children.length === 0) {
    list.append(el("div", { class: "tree-loading" }, "（空）"));
    return list;
  }
  for (const child of children) {
    list.append(treeRow(child, depth + 1));
  }
  return list;
}

async function toggleNode(node, container, expander) {
  if (!node.hasChild || node.kind === "other") return;
  if (state.expanded.has(node.token)) {
    state.expanded.delete(node.token);
    renderTree();
    return;
  }
  state.expanded.add(node.token);
  const cached = state.childrenCache.get(node.token);
  if (cached) {
    renderTree();
    return;
  }
  await refreshChildren(node, true);
}

async function refreshChildren(node, remote, container, depth = 0) {
  try {
    let children;
    if (remote) {
      const data = await api("/api/tree/refresh", { method: "POST", body: { token: node.token } });
      children = data.children;
    } else {
      const data = await api(`/api/tree?token=${encodeURIComponent(node.token)}`);
      children = data.children;
    }
    state.childrenCache.set(node.token, children);
    renderTree();
  } catch (error) {
    toast(`加载目录失败：${error.message}`, "error");
    if (state.expanded.has(node.token) && !state.childrenCache.has(node.token)) {
      state.expanded.delete(node.token);
      renderTree();
    }
  }
}

function renderTree() {
  const tree = document.getElementById("tree");
  tree.replaceChildren();
  if (state.search.query) {
    renderSearchResults(tree);
    return;
  }
  if (state.roots.length === 0) {
    return; // 尚无文档源：左目录留空
  }
  for (const root of state.roots) {
    const rootNode = {
      token: root.token,
      kind: root.kind === "wiki_space" ? "space" : root.kind === "folder" ? "folder" : root.kind === "doc" ? "doc" : "wiki",
      title: root.title,
      hasChild: root.kind !== "doc",
      objType: root.kind === "doc" ? "docx" : undefined,
      mdPath: null,
      rootId: root.id,
    };
    tree.append(treeRow(rootNode, 0));
  }
}

// ---------- 文档标题搜索（搜索框在「文档源」标题下） ----------

const docSearchInput = document.getElementById("docSearchInput");
const docSearchClear = document.getElementById("docSearchClear");
let searchTimer = null;

docSearchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runDocSearch, 200); // 防抖：连续输入只发最后一次请求
});
docSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    docSearchInput.value = "";
    clearDocSearch();
  } else if (event.key === "Enter" && state.search.hits?.length) {
    event.preventDefault();
    void openSearchHit(state.search.hits[0]);
  }
});
docSearchClear.addEventListener("click", () => {
  docSearchInput.value = "";
  clearDocSearch();
  docSearchInput.focus();
});

function clearDocSearch() {
  state.search = { query: "", hits: null, loading: false, error: null };
  docSearchClear.classList.add("hidden");
  renderTree();
}

async function runDocSearch() {
  const query = docSearchInput.value.trim();
  if (!query) {
    clearDocSearch();
    return;
  }
  state.search = { query, hits: null, loading: true, error: null };
  docSearchClear.classList.remove("hidden");
  renderTree();
  try {
    const data = await api(`/api/tree/search?q=${encodeURIComponent(query)}`);
    if (docSearchInput.value.trim() !== query) return; // 输入已变化：丢弃过期结果
    state.search = { query, hits: data.hits ?? [], loading: false, error: null };
  } catch (error) {
    if (docSearchInput.value.trim() !== query) return;
    state.search = { query, hits: [], loading: false, error: error.message };
  }
  renderTree();
}

/** 搜索态下把 #tree 渲染成结果列表（清空搜索后 renderTree 恢复目录树） */
function renderSearchResults(tree) {
  const search = state.search;
  if (search.loading) {
    tree.append(el("div", { class: "tree-empty" }, "搜索中…"));
    return;
  }
  if (search.error) {
    tree.append(el("div", { class: "tree-empty" }, `搜索失败：${search.error}`));
    return;
  }
  if (!search.hits || search.hits.length === 0) {
    tree.append(el("div", { class: "tree-empty" }, "没有匹配的文档"));
    return;
  }
  tree.append(el("div", { class: "search-count" }, `${search.hits.length} 篇匹配文档`));
  for (const hit of search.hits) {
    const breadcrumb = (hit.path ?? []).slice(0, -1).join(" / ");
    tree.append(el("div", {
      class: "tree-row search-row",
      title: breadcrumb ? `${hit.title}\n${breadcrumb}` : hit.title,
      onclick: () => void openSearchHit(hit),
    },
      el("span", { class: "node-icon" }, iconFor({ kind: "doc", objType: hit.objType })),
      el("div", { class: "search-row-main" },
        el("div", { class: "search-row-title" }, hit.title),
        breadcrumb ? el("div", { class: "search-row-path" }, breadcrumb) : null,
      ),
      hit.synced ? null : el("span", { class: "search-unsynced", title: "尚未同步，点击时自动拉取" }, "未同步"),
    ));
  }
}

/** 打开搜索结果：沿 token 链展开祖先（对齐 openDocFromHash），再选中该文档 */
async function openSearchHit(hit) {
  const segments = (hit.chain?.length ? hit.chain : [hit.token]).filter((t) => /^[A-Za-z0-9_-]+$/.test(t));
  try {
    for (const seg of segments.slice(0, -1)) {
      state.expanded.add(seg);
      if (!state.childrenCache.has(seg)) {
        const data = await api(`/api/tree?token=${encodeURIComponent(seg)}`);
        state.childrenCache.set(seg, data.children ?? []);
      }
    }
    const data = await api(`/api/tree?token=${encodeURIComponent(hit.token)}`);
    if (data.parent?.kind !== "doc") {
      throw new Error("该节点已不是文档（可能已被移动或删除）");
    }
    docSearchInput.value = "";
    clearDocSearch();
    await selectDoc(data.parent);
  } catch (error) {
    toast(`打开文档失败：${error.message}`, "error", 6000);
  }
}

// ---------- 拉取 / 同步动作 ----------

async function pullDoc(node, force) {
  try {
    const data = await api("/api/sync/node", { method: "POST", body: { token: node.token, force: force === true } });
    const result = data.result;
    if (result.skipped) {
      toast(`「${node.title}」内容无变化`, "ok", 2000);
    } else {
      toast(`已同步：${result.mdPath}`, "ok", 2000);
    }
    // 该文档正在右侧展示时，刷新内容
    if (state.viewerPath && result.mdPath && state.viewerPath === result.mdPath) {
      await loadViewerContent(node, result.mdPath);
    }
    await Promise.all([refreshRoots(), refreshStatus()]);
  } catch (error) {
    // 本地有未推送的修改：确认后才强制用云端覆盖（MaomiAgent 草稿保护语义）
    if (!force && String(error.message).includes("未推送的修改")) {
      const overwrite = await confirmModal({
        message: `本地修改未推送，用云端版本覆盖「${node.title}」？`,
        confirmText: "覆盖",
        danger: true,
      });
      if (overwrite) {
        return pullDoc(node, true);
      }
      return;
    }
    toast(`拉取失败：${error.message}`, "error", 8000);
    await refreshRoots();
  }
}

/** 按钮进入/退出加载态（长操作期间转圈防误以为卡死） */
function buttonLoading(button, loading, loadingText = "处理中…") {
  if (!button) return;
  if (loading) {
    button.dataset.originalHtml = button.innerHTML;
    button.classList.add("loading");
    button.disabled = true;
    button.innerHTML = `<span class="spin-icon">⟳</span> ${loadingText}`;
  } else {
    button.classList.remove("loading");
    button.disabled = false;
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

async function pushDoc(node, button) {
  const confirmed = await confirmModal({
    message: `推送「${node.title}」到飞书？`,
    confirmText: "推送",
  });
  if (!confirmed) return;
  buttonLoading(button, true, "推送中…");
  try {
    const result = await api("/api/push/doc", { method: "POST", body: { token: node.token } });
    toast(`已推送飞书：${result.blockCount} 处改动（版本 ${result.revisionId ?? "—"}）`, "ok");
    await Promise.all([refreshRoots(), refreshStatus()]);
    if (state.viewerPath && state.viewerNode?.token === node.token) {
      await loadViewerContent(state.viewerNode, state.viewerPath); // 推送后重载正文（后端已自动重拉）
    }
  } catch (error) {
    toast(`推送失败：${error.message}`, "error", 10000);
  } finally {
    buttonLoading(button, false);
  }
}

document.getElementById("btnSyncAll").addEventListener("click", async () => {
  try {
    const data = await api("/api/sync/all", { method: "POST", body: {} });
    watchJob(data.jobId, "同步全部文档源");
  } catch (error) {
    toast(`同步失败：${error.message}`, "error", 8000);
  }
});

// ---------- 任务浮窗（SSE） ----------

function watchJob(jobId, label) {
  closeJobSource();
  state.currentJobId = jobId;
  const panel = document.getElementById("jobPanel");
  panel.classList.remove("hidden");
  document.getElementById("jobLabel").textContent = `${label}（任务 ${jobId.slice(0, 8)}）`;
  document.getElementById("jobLog").textContent = "";
  updateJobPanel({ status: "running", total: 0, done: 0, changed: 0, skipped: 0, failed: 0 });

  const source = new EventSource(`/api/jobs/${jobId}/events`);
  state.jobSource = source;

  const onDone = (snapshot) => {
    updateJobPanel(snapshot);
    source.close();
    state.jobSource = null;
    const summary = `完成：更新 ${snapshot.changed} · 跳过 ${snapshot.skipped} · 失败 ${snapshot.failed}`;
    toast(`${label} ${summary}`, snapshot.failed > 0 ? "error" : "ok", 6000);
    Promise.all([refreshRoots(), refreshStatus()]).catch(() => {});
    setTimeout(() => {
      if (state.currentJobId === jobId && snapshot.failed === 0) {
        panel.classList.add("hidden");
        state.currentJobId = null;
      }
    }, 6000);
  };

  source.addEventListener("snapshot", (event) => updateJobPanel(JSON.parse(event.data)));
  source.addEventListener("progress", (event) => updateJobPanel(JSON.parse(event.data)));
  source.addEventListener("log", (event) => {
    const data = JSON.parse(event.data);
    appendJobLog(data.message);
  });
  source.addEventListener("error", (event) => {
    if (event.data) {
      const data = JSON.parse(event.data);
      appendJobLog(`✗ ${data.message}`, true);
    }
  });
  source.addEventListener("done", (event) => onDone(JSON.parse(event.data)));
  source.onerror = () => {
    // 连接关闭（服务重启等）：回退为轮询
    source.close();
    if (state.currentJobId === jobId) {
      pollJob(jobId, onDone);
    }
  };
}

function pollJob(jobId, onDone) {
  const timer = setInterval(async () => {
    try {
      const snapshot = await api(`/api/jobs/${jobId}`);
      updateJobPanel(snapshot);
      if (snapshot.status !== "running") {
        clearInterval(timer);
        onDone(snapshot);
      }
    } catch {
      clearInterval(timer);
    }
  }, 1500);
}

function updateJobPanel(snapshot) {
  const percent = snapshot.total > 0 ? Math.round((snapshot.done / snapshot.total) * 100) : snapshot.status === "running" ? 8 : 100;
  const bar = document.getElementById("jobBar");
  bar.style.width = `${Math.min(100, percent)}%`;
  bar.classList.toggle("done", snapshot.status !== "running");
  document.getElementById("jobStats").replaceChildren(
    el("span", {}, `进度 ${snapshot.done}/${snapshot.total || "?"}`),
    el("span", { class: "ok" }, `更新 ${snapshot.changed}`),
    el("span", { class: "skip" }, `跳过 ${snapshot.skipped}`),
    el("span", { class: "fail" }, `失败 ${snapshot.failed}`),
    snapshot.status === "done" ? el("span", { class: "ok" }, "✓ 完成") : el("span", {}, "进行中…"),
  );
}

function appendJobLog(message, isError = false) {
  const log = document.getElementById("jobLog");
  const line = document.createElement("div");
  if (isError) line.className = "err-line";
  line.textContent = message;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

document.getElementById("jobClose").addEventListener("click", () => {
  document.getElementById("jobPanel").classList.add("hidden");
  state.currentJobId = null;
  closeJobSource();
});

function closeJobSource() {
  if (state.jobSource) {
    state.jobSource.close();
    state.jobSource = null;
  }
}

// ---------- 添加文档源 / 发现知识库 ----------

document.getElementById("addRootForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("addRootInput");
  await submitAddRoot(input.value.trim(), input);
});

// ---------- 发现知识库（弹窗） ----------

function closeDiscoverModal() {
  document.getElementById("discoverModal").classList.add("hidden");
}

async function openDiscoverModal() {
  const modal = document.getElementById("discoverModal");
  const listEl = document.getElementById("discoverModalList");
  const button = document.getElementById("btnDiscover");
  modal.classList.remove("hidden");
  listEl.replaceChildren(el("div", { class: "discover-loading" }, "正在获取应用可见的知识库…"));
  button.disabled = true;
  try {
    const [data] = await Promise.all([api("/api/feishu/wiki-spaces"), refreshRoots()]);
    if (data.spaces.length === 0) {
      listEl.replaceChildren(el("div", { class: "hint" }, "没有可见知识库：请确认应用已发布且被添加为知识库成员。"));
      return;
    }
    // 已在文档源列表中的知识库不再显示「添加」
    const addedTokens = new Set(
      state.roots.filter((root) => root.kind === "wiki_space").map((root) => root.token),
    );
    listEl.replaceChildren(el("div", { class: "discover-grid" }));
    const grid = listEl.firstChild;
    for (const space of data.spaces) {
      grid.append(spaceCard(space, addedTokens.has(space.spaceId)));
    }
  } catch (error) {
    listEl.replaceChildren(el("div", { class: "hint" }, `获取知识库失败：${error.message}`));
  } finally {
    button.disabled = false;
  }
}

document.getElementById("btnDiscover").addEventListener("click", () => {
  void openDiscoverModal();
});

/** 知识库卡片：开放平台拿不到空间封面图，用 spaceId 哈希出的固定渐变色铺底（对齐飞书默认彩色卡片） */
const SPACE_GRADIENTS = [
  ["#3370ff", "#7c9bff"],
  ["#7b61ff", "#a894ff"],
  ["#e8684a", "#f2a07b"],
  ["#2ea44f", "#63c585"],
  ["#e91e8c", "#9c27b0"],
  ["#00a3a3", "#4dc4c4"],
  ["#f0a020", "#f5c15c"],
  ["#3d5afe", "#8fa4ff"],
];

function spaceGradient(spaceId) {
  let hash = 0;
  for (const ch of String(spaceId)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const [from, to] = SPACE_GRADIENTS[hash % SPACE_GRADIENTS.length];
  return `linear-gradient(150deg, ${from}, ${to})`;
}

function spaceAddedTag() {
  return el("span", { class: "space-added" }, "✓ 已添加");
}

function spaceCard(space, alreadyAdded) {
  const card = el("div", {
    class: "space-card",
    style: `background:${spaceGradient(space.spaceId)}`,
    title: space.description ? `${space.name}\n${space.description}` : space.name,
  });
  card.append(
    el("div", { class: "space-card-text" },
      el("div", { class: "name" }, space.name),
      space.description ? el("div", { class: "desc" }, space.description) : null,
    ),
  );
  if (alreadyAdded) {
    card.append(spaceAddedTag());
  } else {
    card.append(el("button", {
      class: "btn btn-small btn-primary space-add",
      title: "把整个知识库作为文档源",
      onclick: async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
          await api("/api/roots", { method: "POST", body: { wikiSpaceId: space.spaceId, wikiSpaceName: space.name } });
          btn.replaceWith(spaceAddedTag());
          toast(`已添加知识库「${space.name}」`, "ok");
          await Promise.all([refreshRoots(), refreshStatus()]);
        } catch (error) {
          btn.disabled = false;
          toast(`添加失败：${error.message}`, "error", 8000);
        }
      },
    }, "添加"));
  }
  return card;
}

document.getElementById("discoverClose").addEventListener("click", closeDiscoverModal);

document.getElementById("discoverModal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeDiscoverModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDiscoverModal();
});

// ---------- 右侧文档内容 ----------


// ---------- 画板图自动裁边（飞书导出图四周大量空白 → 裁掉后内容居中放大） ----------

const trimmedBoardCache = new Map(); // 原图 URL → 裁剪后 dataURL（或 null 表示无需/无法裁剪）

function trimBoardImage(url) {
  if (trimmedBoardCache.has(url)) {
    return Promise.resolve(trimmedBoardCache.get(url));
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let result = null;
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        // 像素太多时隔行采样（包围盒精度足够，留边距兜底）
        const step = w * h > 12_000_000 ? 2 : 1;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            if (data[i] < 244 || data[i + 1] < 244 || data[i + 2] < 244) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        const pad = 16;
        if (maxX >= 0) {
          minX = Math.max(0, minX - pad);
          minY = Math.max(0, minY - pad);
          maxX = Math.min(w - 1, maxX + pad);
          maxY = Math.min(h - 1, maxY + pad);
          const cw = maxX - minX + 1;
          const ch = maxY - minY + 1;
          if (cw < w * 0.98 || ch < h * 0.98) { // 只有确实裁得掉才替换
            const crop = document.createElement("canvas");
            crop.width = cw;
            crop.height = ch;
            crop.getContext("2d").drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
            result = crop.toDataURL("image/png");
          }
        }
      } catch { /* 裁剪失败用原图 */ }
      trimmedBoardCache.set(url, result);
      resolve(result);
    };
    img.onerror = () => {
      trimmedBoardCache.set(url, null);
      resolve(null);
    };
    img.src = url;
  });
}

/** 点击目录中的文档：未同步自动拉取，然后右侧显示内容；有下级文档时自动拉取并展开 */
async function selectDoc(node) {
  state.selectedToken = node.token;
  if (location.hash !== `#/doc/${node.token}`) {
    history.pushState(null, "", `#/doc/${node.token}`);
  }
  renderTree();

  if (node.hasChild && node.kind !== "other") {
    state.expanded.add(node.token);
    if (!state.childrenCache.has(node.token)) {
      void refreshChildren(node, true);
    } else {
      renderTree();
    }
  }

  if (!node.mdPath) {
    state.viewerNode = node;
    showViewerLoading(node.title);
    try {
      const data = await api("/api/sync/node", { method: "POST", body: { token: node.token } });
      const result = data.result;
      node.mdPath = result.mdPath;
      node.syncedAt = new Date().toISOString();
      await loadViewerContent(node, result.mdPath);
      await Promise.all([refreshRoots(), refreshStatus()]);
    } catch (error) {
      showViewerError(node.title, error.message);
      renderTree();
    }
    return;
  }
  await loadViewerContent(node, node.mdPath);
}

function showViewerLoading(title) {
  document.getElementById("docViewerEmpty").classList.add("hidden");
  document.getElementById("docViewer").classList.remove("hidden");
  document.getElementById("viewerTitle").textContent = title;
  document.getElementById("viewerMeta").replaceChildren(el("span", {}, "正在从飞书拉取内容…"));
  document.getElementById("viewerActions").replaceChildren();
}

function showViewerError(title, message) {
  document.getElementById("docViewerEmpty").classList.add("hidden");
  document.getElementById("docViewer").classList.remove("hidden");
  document.getElementById("viewerTitle").textContent = title;
  document.getElementById("viewerMeta").replaceChildren();
  document.getElementById("viewerActions").replaceChildren();
  document.getElementById("viewerFrame").src =
    `/api/doc/render?error=${encodeURIComponent(String(message))}`;
}

async function loadViewerContent(node, mdPath) {
  state.viewerPath = mdPath;
  state.viewerNode = node;
  // 收起编辑器（内联处理，避免与 exitEditMode 的重载互相递归）
  document.getElementById("viewerEditor").classList.add("hidden");
  document.getElementById("viewerFrame").classList.remove("hidden");
  document.getElementById("docViewerEmpty").classList.add("hidden");
  document.getElementById("docViewer").classList.remove("hidden");
  document.getElementById("viewerTitle").textContent = node.title;

  try {
    const data = await api(`/api/doc/content?path=${encodeURIComponent(mdPath)}`);
    state.viewerRaw = data.content; // 原始 markdown（含 frontmatter），编辑模式用
    document.getElementById("viewerTitle").textContent = data.title;

    document.getElementById("viewerMeta").replaceChildren(
      el("span", { class: "doc-location", title: data.absolutePath ?? data.path }, `位置：${data.absolutePath ?? data.path}`),
      data.syncedAt ? el("span", {}, `同步于 ${formatTime(data.syncedAt)} · 版本 ${data.revisionId ?? "—"}`) : null,
      data.remoteUrl ? el("a", { href: data.remoteUrl, target: "_blank", rel: "noreferrer" }, "在飞书中打开 ↗") : null,
    );

    // URL 多层路径：#/doc/<根token>/…/<父token>/<文档token>（每层都是 token，改标题不影响）
    if (node.token) {
      const tokens = (data.chain?.length ? data.chain : [node.token]).filter((t) => /^[A-Za-z0-9_-]+$/.test(t));
      const target = `#/doc/${tokens.join("/")}`;
      if (location.hash !== target) {
        history.replaceState(null, "", target);
      }
    }

    const actionButtons = [
      el("button", {
        class: "btn btn-small",
        title: "重新从飞书拉取最新内容（本地有未推送修改时会先确认）",
        onclick: () => pullDoc(node),
      }, "⟳ 重新同步"),
      el("button", {
        class: "btn btn-small",
        title: "编辑本地 markdown（保存后可推送回飞书）",
        onclick: () => enterEditMode(),
      }, "✎ 编辑"),
      el("button", {
        class: "btn btn-small",
        style: "color:var(--amber)",
        title: "把本地 markdown 推送回飞书（MaomiAgent 四级策略，带冲突保护）",
        onclick: (event) => pushDoc(node, event.currentTarget),
      }, "↑ 推送飞书"),
      el("button", { class: "btn btn-small", title: data.absolutePath ?? mdPath, onclick: () => copyText(data.absolutePath ?? mdPath, "已复制绝对路径") }, "⧉ 复制路径"),
    ];
    document.getElementById("viewerActions").replaceChildren(...actionButtons);

    const content = data.content.replace(/^---\n[\s\S]*?\n---\n/, "");
    const assets = data.assets ?? {};
    const boardScopeOk = state.status?.auth?.boardScopeGranted !== false; // 未知（旧状态）时不武断
    // 画板导出图四周空白大：未裁边的在父页面 canvas 裁边后回存服务端（<token>.trimmed.png）
    const boardTokensInDoc = [...content.matchAll(/<(?:whiteboard|board|diagram|mindnote)\b[^>]*\stoken="([^"]+)"/g)]
      .map((m) => m[1]);
    await Promise.all([...new Set(boardTokensInDoc)].map(async (token) => {
      const src = assets[token];
      if (!src || src.endsWith(".trimmed.png")) {
        return; // 无资产 / 已裁边
      }
      const dataUrl = await trimBoardImage(src);
      if (!dataUrl) {
        return;
      }
      try {
        await api("/api/assets/trim", {
          method: "POST",
          body: { path: src.replace(/^\/workspace\//, ""), dataUrl },
        });
      } catch { /* 回存失败保持原图 */ }
    }));

    // 服务端渲染整页，iframe 同源 src 加载（不再前端拼 srcdoc）
    document.getElementById("viewerFrame").src =
      `/api/doc/render?path=${encodeURIComponent(mdPath)}&_=${Date.now()}`;

    // 画板/图表有标签但没有本地资产：自动补拉一次（授权缺权限时提示先补权限）
    const missingBoards = /<(?:whiteboard|board|diagram|mindnote)\s+[^>]*\/>/i.test(content);
    if (missingBoards && state.autoHealedBoards !== node.token) {
      state.autoHealedBoards = node.token;
      if (!boardScopeOk) {
        toast("画板未渲染：缺少画板权限（board:whiteboard:node:read）。请到飞书开放平台开通该权限并发布版本，再重新扫码授权", "error", 10000);
      } else {
        document.getElementById("viewerMeta").replaceChildren(el("span", {}, "检测到画板未下载，正在重新同步…"));
        await pullDoc(node);
      }
    }
  } catch (error) {
    showViewerError(node.title, error.message);
  }
}

// ---------- 编辑本地 markdown + 回写飞书（对齐 MaomiAgent：编辑草稿 → 保存 → 按 base 基线四级策略推送） ----------

function enterEditMode() {
  const node = state.viewerNode;
  if (!node || !state.viewerPath || state.viewerRaw === undefined) {
    toast("文档尚未加载完成", "error");
    return;
  }
  const editor = document.getElementById("viewerEditor");
  editor.value = state.viewerRaw;
  editor.classList.remove("hidden");
  document.getElementById("viewerFrame").classList.add("hidden");
  document.getElementById("viewerActions").replaceChildren(
    el("button", { class: "btn btn-small", onclick: () => exitEditMode() }, "取消"),
    el("button", {
      class: "btn btn-small btn-primary",
      onclick: () => saveEditor(false),
    }, "保存到本地"),
    el("button", {
      class: "btn btn-small btn-primary",
      style: "background:var(--amber);border-color:var(--amber)",
      title: "保存本地后按 MaomiAgent 四级策略推送飞书（白板增量 → 无损重推 → docs_ai 覆写 → 纯 markdown 重建）",
      onclick: (event) => saveEditor(true, event.currentTarget),
    }, "↥ 保存并推送飞书"),
  );
  editor.focus();
}

/** 退出编辑模式并强制重新加载内容（任何路径都不留空白） */
function exitEditMode() {
  const editor = document.getElementById("viewerEditor");
  editor.classList.add("hidden");
  document.getElementById("viewerFrame").classList.remove("hidden");
  document.getElementById("docViewer").classList.remove("hidden");
  document.getElementById("docViewerEmpty").classList.add("hidden");
  if (state.viewerNode && state.viewerPath) {
    void loadViewerContent(state.viewerNode, state.viewerPath);
  }
}

async function saveEditor(push, button) {
  const node = state.viewerNode;
  const editor = document.getElementById("viewerEditor");
  const content = editor.value;
  try {
    // 先保存本地：无论如何修改都不丢（带 base 防呆，编辑期间被同步更新过则拒绝覆盖）
    buttonLoading(button, true, push ? "保存并推送中…" : "保存中…");
    await api("/api/doc/content", { method: "POST", body: { path: state.viewerPath, content, base: state.viewerRaw } });
    if (!push) {
      toast("已保存到本地 markdown", "ok");
      buttonLoading(button, false);
      exitEditMode();
      return;
    }
    buttonLoading(button, false);
    const ok = await confirmModal({
      message: `推送「${node.title}」到飞书？`,
      confirmText: "推送",
    });
    if (!ok) {
      exitEditMode();
      return;
    }
    buttonLoading(button, true, "推送中…");
    const result = await api("/api/push/doc", { method: "POST", body: { token: node.token } });
    toast(`已推送飞书：${result.blockCount ?? "—"} 处改动`, "ok", 4000);
    exitEditMode();
    await Promise.all([refreshRoots(), refreshStatus()]);
  } catch (error) {
    toast(`${push ? "推送失败" : "保存失败"}：${error.message}`, "error", 10000);
  } finally {
    buttonLoading(button, false);
  }
}

// ---------- 一键复制权限 ----------

document.getElementById("btnCopyScopes").addEventListener("click", () => {
  const scopes = [...document.querySelectorAll("#scopeList code")]
    .map((code) => code.dataset.scope)
    .filter(Boolean);
  // 开放平台批量导入格式：fsmore 全部走用户身份，只需 user 通道
  const payload = { scopes: { user: scopes } };
  copyText(JSON.stringify(payload, null, 2), "已复制 JSON 权限结构，到开放平台批量导入");
});

// 单个权限点击即复制
document.getElementById("scopeList").addEventListener("click", (event) => {
  const code = event.target.closest("code[data-scope]");
  if (code) {
    copyText(code.dataset.scope, `已复制 ${code.dataset.scope}`);
  }
});

// ---------- MCP 视图 ----------

const SNIPPET_BUILDERS = {
  generic: (endpoint) => JSON.stringify({ mcpServers: { fsmore: { url: endpoint } } }, null, 2),
  claude: (endpoint) => `# 终端执行（Claude Code / Claude Desktop 均可）\nclaude mcp add --transport http fsmore ${endpoint}\n\n# 或手动编辑 claude_desktop_config.json：\n${JSON.stringify({ mcpServers: { fsmore: { url: endpoint } } }, null, 2)}`,
  codex: (endpoint) => `# ~/.codex/config.toml\n[mcp_servers.fsmore]\nurl = "${endpoint}"`,
  zcode: (endpoint) => `# ZCode MCP 配置（JSON）\n${JSON.stringify({ mcpServers: { fsmore: { url: endpoint } } }, null, 2)}\n\n# 或 CLI：\n# zcode mcp add --transport http fsmore ${endpoint}`,
};

async function refreshMcp() {
  try {
    const info = await api("/api/mcp/info");
    document.getElementById("mcpEndpoint").textContent = info.endpoint;
    document.getElementById("workspacePath").textContent = state.status?.workspaceDir ?? "";

    const body = document.getElementById("mcpToolsBody");
    body.replaceChildren();
    for (const tool of info.tools) {
      body.append(el("tr", {},
        el("td", { class: "mono" }, tool.name),
        el("td", {}, tool.description),
      ));
    }
    renderSnippet(info.endpoint);
  } catch (error) {
    toast(`加载 MCP 信息失败：${error.message}`, "error");
  }
}

function renderSnippet(endpoint) {
  const builder = SNIPPET_BUILDERS[state.snippetTab] || SNIPPET_BUILDERS.generic;
  document.getElementById("snippetBox").textContent = builder(endpoint || "http://127.0.0.1:7788/mcp");
}

document.getElementById("snippetTabs").addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  state.snippetTab = tab.dataset.snippet;
  for (const item of document.querySelectorAll("#snippetTabs .tab")) {
    item.classList.toggle("active", item === tab);
  }
  renderSnippet(document.getElementById("mcpEndpoint").textContent);
});

document.getElementById("btnCopyEndpoint").addEventListener("click", () => {
  copyText(document.getElementById("mcpEndpoint").textContent, "端点已复制");
});
document.getElementById("btnCopyWorkspace").addEventListener("click", () => {
  copyText(document.getElementById("workspacePath").textContent, "工作区路径已复制");
});
document.getElementById("btnCopySnippet").addEventListener("click", () => {
  copyText(document.getElementById("snippetBox").textContent, "配置已复制");
});

// ---------- 设置视图 ----------

let oauthPollTimer = null;

async function refreshSettings() {
  try {
    const config = await api("/api/config");
    const status = state.status ?? await api("/api/status");
    await refreshStatus();
    const latest = state.status ?? status;

    // 回填真实凭证（App ID 明文；密钥以圆点显示，可点击「显示密钥」查看）
    document.getElementById("cfgAppId").value = config.appId || "";
    document.getElementById("cfgAppSecret").value = config.appSecret || "";
    document.getElementById("cfgConcurrency").value = config.syncConcurrency;

    renderAuthBanner(latest);
    renderAuthStep(latest);

    const redirectUri = latest.auth?.redirectUri ?? `http://127.0.0.1:${latest.port}/api/oauth/callback`;
    document.getElementById("redirectUri").textContent = redirectUri;

    const runtime = document.getElementById("runtimeInfo");
    const auth = latest.auth ?? {};
    runtime.replaceChildren(
      kv("应用凭证", !latest.configured ? "未配置" : `已配置（${latest.appId}）`),
      kv("授权通道", auth.userAuthorized ? `用户身份（${auth.userName || "已授权"}）` : "应用身份（tenant）"),
      kv("访问令牌过期", latest.tokenExpiresAt ? formatTime(latest.tokenExpiresAt) : "—"),
      kv("刷新令牌过期", auth.refreshTokenExpiresAt ? formatTime(auth.refreshTokenExpiresAt) : "—"),
      kv("自动续期", auth.autoRefresh?.lastError
        ? `异常：${auth.autoRefresh.lastError}`
        : auth.autoRefresh?.lastRefreshAt
          ? `正常（最近 ${formatTime(auth.autoRefresh.lastRefreshAt)}）`
          : auth.userAuthorized ? "待首次刷新" : "—"),
      kv("数据目录", latest.dataDir),
      kv("工作区目录", latest.workspaceDir),
      kv("服务端口", String(latest.port)),
      kv("文档源 / 节点 / 已同步", `${latest.counts.roots} / ${latest.counts.nodes} / ${latest.counts.synced}`),
    );
    renderCacheInfo();
  } catch (error) {
    toast(`加载配置失败：${error.message}`, "error");
  }
}

/** 设置页「缓存管理」卡片：统计 .maomi 缓存大小（随 refreshSettings 刷新） */
async function renderCacheInfo() {
  const box = document.getElementById("cacheInfo");
  const button = document.getElementById("btnClearCache");
  button.disabled = true;
  try {
    const stats = await api("/api/cache/stats");
    box.replaceChildren(
      kv("缓存目录", stats.path),
      kv("缓存大小", stats.exists ? `${formatBytes(stats.bytes)}（${stats.files} 个文件）` : "暂无缓存"),
    );
    button.disabled = !stats.exists || stats.bytes === 0;
  } catch (error) {
    box.replaceChildren(kv("缓存大小", `统计失败：${error.message}`));
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

document.getElementById("btnClearCache").addEventListener("click", async () => {
  const stats = await api("/api/cache/stats").catch(() => null);
  const sizeText = stats?.exists ? formatBytes(stats.bytes) : "";
  const ok = await confirmModal({
    message: `清空本地缓存${sizeText ? `（${sizeText}）` : ""}？\n所有文档将回到未同步状态，重新同步即可从飞书恢复；未推送的本地修改与回写基线将被删除，且不可恢复。`,
    confirmText: "清空缓存",
    danger: true,
  });
  if (!ok) return;
  const button = document.getElementById("btnClearCache");
  button.disabled = true;
  try {
    const result = await api("/api/cache/clear", { method: "POST", body: {} });
    toast(`已清空缓存${result.clearedNodes ? `，${result.clearedNodes} 个文档回到未同步状态` : ""}`, "ok");
    state.childrenCache.clear(); // 树上同步状态来自节点缓存，失效后重新拉取
    renderTree();
    await Promise.all([refreshSettings(), refreshStatus()]);
  } catch (error) {
    toast(`清空失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
});

function renderAuthBanner(status) {
  const banner = document.getElementById("authBanner");
  const dot = document.getElementById("authBannerDot");
  const title = document.getElementById("authBannerTitle");
  const desc = document.getElementById("authBannerDesc");
  const meta = document.getElementById("authBannerMeta");
  const auth = status.auth ?? {};

  desc.replaceChildren();
  meta.replaceChildren();
  banner.classList.remove("gray", "amber");
  if (!status.configured) {
    banner.classList.add("gray");
    title.textContent = "未配置凭证";
    return;
  }
  if (auth.userAuthorized) {
    title.textContent = `已连接飞书${auth.userName ? ` · ${auth.userName}` : ""}`;
    return;
  }
  banner.classList.add("amber");
  title.textContent = "未扫码授权";
}

function renderAuthStep(status) {
  const button = document.getElementById("btnOAuth");
  const line = document.getElementById("authStateLine");
  const auth = status.auth ?? {};

  button.disabled = !status.configured;
  button.classList.toggle("pulse", !!status.configured && !auth.userAuthorized && !oauthPollTimer);

  if (auth.userAuthorized) {
    line.replaceChildren(
      el("span", { class: "dot dot-green" }),
      el("span", {}, `已授权${auth.userName ? `：${auth.userName}` : ""}，可以直接去同步文档了`),
      el("button", {
        class: "btn-link",
        style: "color:var(--red)",
        onclick: async () => {
          if (!(await confirmModal({ message: "断开飞书授权？", confirmText: "断开", danger: true }))) return;
          try {
            await api("/api/oauth/disconnect", { method: "POST", body: {} });
            toast("已断开授权", "ok");
            await refreshSettings();
          } catch (error) {
            toast(`操作失败：${error.message}`, "error");
          }
        },
      }, "断开授权"),
    );
    if (auth.boardScopeGranted === false) {
      line.append(el("div", { style: "width:100%;color:var(--amber);margin-top:6px" },
        "⚠ 缺少画板权限（board:whiteboard:node:read）：文档内画板无法显示。请到飞书开放平台开通并发布新版本后重新扫码。"));
    }
    return;
  }

  line.replaceChildren(
    el("span", { class: "dot dot-gray" }),
    el("span", {}, status.configured ? "未授权：填写并保存凭证后，点击上方按钮开始扫码" : "需要先完成步骤 2 保存凭证"),
  );
}

document.getElementById("btnOAuth").addEventListener("click", async () => {
  try {
    const data = await api("/api/oauth/url");
    const popup = window.open(data.url, "fsmore-oauth", "width=680,height=780,top=80,left=200");
    if (!popup) {
      // 弹窗被拦截：复制授权链接兜底
      await copyText(data.url, "弹窗被浏览器拦截，已复制授权链接，请手动在新标签页打开");
      return;
    }
    toast("已打开飞书授权页，请用飞书 App 扫码确认", "ok", 5000);
    startOAuthPolling();
  } catch (error) {
    toast(`发起授权失败：${error.message}`, "error", 8000);
  }
});

function startOAuthPolling() {
  clearInterval(oauthPollTimer);
  const line = document.getElementById("authStateLine");
  line.replaceChildren(
    el("span", { class: "dot dot-amber" }),
    el("span", {}, "等待扫码确认…（完成后本页会自动更新，窗口未弹出时请检查浏览器拦截）"),
  );

  const started = Date.now();
  oauthPollTimer = setInterval(async () => {
    if (Date.now() - started > 3 * 60 * 1000) {
      clearInterval(oauthPollTimer);
      oauthPollTimer = null;
      refreshSettings();
      return;
    }
    try {
      await refreshStatus();
      if (state.status?.auth?.userAuthorized) {
        clearInterval(oauthPollTimer);
        oauthPollTimer = null;
        toast("飞书授权成功！现在可以回到文档树同步文档了", "ok", 6000);
        await refreshSettings();
      }
    } catch {
      // 服务暂不可达时继续轮询
    }
  }, 2000);
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.type !== "fsmore-oauth") return;
  clearInterval(oauthPollTimer);
  oauthPollTimer = null;
  if (data.ok) {
    toast("飞书授权成功！", "ok");
  } else {
    toast("授权未完成，可重新点击扫码授权", "error");
  }
  refreshSettings();
});

document.getElementById("btnCopyRedirect").addEventListener("click", () => {
  copyText(document.getElementById("redirectUri").textContent, "回调地址已复制，请粘贴到飞书「安全设置 → 重定向 URL」");
});

function kv(key, value) {
  return el("div", { class: "kv" }, el("span", { class: "k" }, key), el("span", { class: "v" }, value));
}

document.getElementById("configForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveConfig(false);
});

document.getElementById("btnTestConn").addEventListener("click", () => saveConfig(true));

document.getElementById("btnToggleSecret").addEventListener("click", () => {
  const input = document.getElementById("cfgAppSecret");
  const button = document.getElementById("btnToggleSecret");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "隐藏密钥" : "显示密钥";
});

async function saveConfig(alsoTest) {
  const appId = document.getElementById("cfgAppId").value.trim();
  const appSecret = document.getElementById("cfgAppSecret").value.trim();
  const concurrency = Number(document.getElementById("cfgConcurrency").value) || 3;
  // 输入框里是真实凭证（后端会拒收空值与掩码串，不会误覆盖）
  const body = { appId, appSecret, syncConcurrency: concurrency };

  const result = document.getElementById("connResult");
  try {
    const saved = await api("/api/config", { method: "POST", body });
    // 以后端实际保存的值为准回填，避免任何前后端不一致
    document.getElementById("cfgAppId").value = saved.appId || "";
    document.getElementById("cfgAppSecret").value = saved.appSecret || "";
    if (alsoTest) {
      result.className = "conn-result";
      result.textContent = "正在验证凭证…";
      try {
        const test = await api("/api/config/test", { method: "POST", body: {} });
        result.className = "conn-result ok";
        result.textContent = `✓ 凭证有效，tenant_access_token 已获取（过期时间 ${formatTime(test.expiresAt)}）。可继续步骤 3、4 完成扫码授权。`;
      } catch (error) {
        result.className = "conn-result err";
        result.textContent = `✗ 凭证校验失败：${error.message}`;
      }
    } else {
      result.className = "conn-result ok";
      result.textContent = "✓ 凭证已保存。若尚未放行回调地址，先完成步骤 3；然后点击步骤 4 扫码授权。";
    }
    await Promise.all([refreshStatus(), refreshSettings()]);
  } catch (error) {
    result.className = "conn-result err";
    result.textContent = `✗ 保存失败：${error.message}`;
  }
}

// ---------- 启动 ----------

/** 从地址栏解析 token 多层路径：#/doc/<根token>/…/<文档token> → token 数组（顺序即层级） */
function docTokenSegments() {
  const raw = location.hash.replace(/^#\/?/, "");
  const queryStart = raw.indexOf("?");
  if (queryStart >= 0) {
    const token = new URLSearchParams(raw.slice(queryStart + 1)).get("t");
    if (token && /^[A-Za-z0-9]+$/.test(token)) {
      return [token];
    }
  }
  return raw.slice(0, queryStart >= 0 ? queryStart : undefined)
    .split("/")
    .filter((part) => part && part !== "doc" && /^[A-Za-z0-9_-]+$/.test(part));
}

/** 从 URL 挂载文档：刷新、直接输入地址、前进/后退。按层级自动展开左侧树，失败保留地址并重试。 */
async function openDocFromHash() {
  const segments = docTokenSegments();
  const token = segments[segments.length - 1];
  if (!token || token === state.selectedToken) {
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // 沿 URL 层级展开祖先节点（刷新后不用手动一层层点开）
      for (const seg of segments.slice(0, -1)) {
        state.expanded.add(seg);
        if (!state.childrenCache.has(seg)) {
          const data = await api(`/api/tree?token=${encodeURIComponent(seg)}`);
          state.childrenCache.set(seg, data.children ?? []);
        }
      }
      if (segments.length > 1) {
        renderTree();
      }
      const data = await api(`/api/tree?token=${encodeURIComponent(token)}`);
      const node = data.parent;
      if (!node || node.kind !== "doc") {
        history.replaceState(null, "", location.pathname);
        return;
      }
      await selectDoc(node);
      return;
    } catch (error) {
      if (String(error.message).includes("索引中不存在节点")) {
        // 文档源已被移除：清地址回到空态
        history.replaceState(null, "", location.pathname);
        toast("地址指向的文档不在索引中（文档源可能已移除）", "error", 5000);
        return;
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 700 * attempt)); // 服务重启等瞬态故障，重试
        continue;
      }
      toast(`按地址恢复文档失败：${error.message}（地址已保留，可稍后刷新重试）`, "error", 8000);
    }
  }
}

window.addEventListener("popstate", () => {
  void openDocFromHash();
});

(async function init() {
  await refreshStatus();
  await refreshRoots();
  if (state.status && !state.status.configured) {
    switchView("settings");
    toast("欢迎使用 fsmore：请先在「设置」页配置飞书应用凭证", "ok", 6000);
  } else {
    switchView("docs");
    await openDocFromHash();
  }
})();
