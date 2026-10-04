import { marked } from "marked";

/**
 * 文档查看器服务端渲染：markdown（MaomiAgent 原生标签）→ 完整 HTML 页面。
 * 由 GET /api/doc/render 输出，iframe 以同源 src 加载（不再用 srcdoc 拼接，
 * 避免真实 Chrome 超大 srcdoc 白屏一类问题）。
 */

export const VIEWER_CSS = `
  body { font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: #1f2329;
         max-width: 820px; margin: 0 auto; padding: 28px 32px 64px; line-height: 1.75; font-size: 14.5px; }
  h1, h2, h3, h4 { margin: 1.4em 0 0.5em; line-height: 1.4; }
  h1:first-child { margin-top: 0; }
  h1 { font-size: 1.7em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; }
  pre { background: #f6f8fa; border-radius: 8px; padding: 14px; overflow-x: auto; line-height: 1.6; }
  code { font-family: Consolas, Menlo, monospace; font-size: 0.9em; }
  :not(pre) > code { background: #f2f3f5; border-radius: 4px; padding: 2px 6px; }
  blockquote { margin: 0.6em 0; padding: 4px 14px; border-left: 4px solid #3370ff; background: #f6f9ff; color: #3b4656; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #e4e7ec; padding: 7px 12px; }
  th { background: #fafbfc; }
  img { max-width: 100%; border-radius: 8px; cursor: zoom-in; }
  /* 画板导出图：居中放大显示（已裁边），点击全屏查看 */
  img.board-img { display: block; margin: 14px auto; max-height: min(70vh, 680px); object-fit: contain;
    background: #fff; border: 1px solid #e4e7ec; padding: 6px; }
  /* highlight.js github 主题 */
  .hljs { color: #24292e; }
  .hljs-comment, .hljs-quote { color: #6a737d; }
  .hljs-keyword, .hljs-selector-tag, .hljs-meta { color: #d73a49; }
  .hljs-string, .hljs-attr, .hljs-template-string { color: #032f62; }
  .hljs-number, .hljs-literal { color: #005cc5; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: #6f42c1; }
  .hljs-title.class_, .hljs-type, .hljs-built_in { color: #e36209; }
  .hljs-name, .hljs-tag { color: #22863a; }
  .hljs-variable, .hljs-params { color: #e36209; }
  .hljs-doctag, .hljs-formula { color: #d73a49; }
  .board-missing { margin: 10px 0; padding: 12px 16px; background: #fdf5e6; border: 1px solid #f2d9a4;
    border-radius: 8px; color: #8a6116; font-size: 13px; line-height: 1.7; }
  whiteboard, board, diagram, mindnote { display: block; margin: 8px 0; color: #8f959e; font-size: 13px; }
  grid, grid-column, view { display: block; }
  image { display: none; }
  file { display: block; margin: 6px 0; color: #3370ff; }
  file::before { content: "📄 "; }
  file::after { content: " " attr(name); color: #646a73; }
  sheet, bitable { display: block; margin: 8px 0; padding: 10px 14px;
    background: #fff7e6; border-radius: 8px; color: #8f959e; font-size: 13px; }
  sheet::before { content: "📈 电子表格 token:" attr(token); }
  bitable::before { content: "📊 多维表格 token:" attr(token); }
  chat-card, link-preview, jira-issue, add-ons, isv, okr,
  source-synced, reference-synced, ai-template { display: block; margin: 6px 0; color: #8f959e; font-size: 13px; }
  hr { border: none; border-top: 1px solid #e4e7ec; margin: 1.6em 0; }
  a { color: #3370ff; }
`;

export const VIEWER_JS = `
(function () {
  function openLightbox(src) {
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(15,23,34,.82);z-index:9999;"
      + "display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:24px;";
    var big = document.createElement("img");
    big.src = src;
    big.style.cssText = "max-width:96vw;max-height:92vh;object-fit:contain;border-radius:8px;"
      + "background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.45);transition:transform .08s ease-out;";
    overlay.appendChild(big);
    var scale = 1;
    var apply = function () { scale = Math.min(10, Math.max(0.2, scale)); big.style.transform = "scale(" + scale + ")"; };
    overlay.addEventListener("wheel", function (e) { e.preventDefault(); scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15; apply(); }, { passive: false });
    big.addEventListener("dblclick", function (e) { e.stopPropagation(); scale = 1; apply(); });
    var dl = document.createElement("a");
    dl.textContent = "\\u2b07 \\u4e0b\\u8f7d\\u56fe\\u7247";
    dl.href = src;
    dl.download = src.indexOf("data:") === 0 ? "board.png" : (src.split("/").pop() || "image");
    dl.style.cssText = "position:absolute;bottom:28px;left:50%;transform:translateX(-50%);"
      + "background:#fff;color:#1f2329;border-radius:8px;padding:9px 22px;font-size:14px;"
      + "cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.35);text-decoration:none;";
    dl.addEventListener("click", function (e) { e.stopPropagation(); });
    var close = function () { overlay.remove(); document.removeEventListener("keydown", onKey); };
    var onKey = function (ev) {
      if (ev.key === "Escape") close();
      if (ev.key === "+" || ev.key === "=") { scale *= 1.15; apply(); }
      if (ev.key === "-") { scale /= 1.15; apply(); }
    };
    overlay.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.appendChild(dl);
  }
  document.addEventListener("click", function (e) {
    var img = e.target && e.target.closest ? e.target.closest("img.zoomable") : null;
    if (img) { e.preventDefault(); openLightbox(img.src); }
  });
  function highlight() { if (window.hljs && window.hljs.highlightAll) window.hljs.highlightAll(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", highlight);
  else highlight();
})();
`;

/** MaomiAgent 原生 <table cells>/<table-cell> 标签 → 真 HTML 表格 */
export function renderNativeTables(markdown: string): string {
  return markdown.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (match, attrs: string, inner: string) => {
    if (!/\scells="/i.test(attrs)) {
      return match;
    }
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const cols = Number.parseInt(attr("column-size"), 10) || 0;
    const headerRow = attr("header-row") === "true";
    const cells = [...inner.matchAll(/<table-cell\b[^>]*>([\s\S]*?)<\/table-cell>/gi)].map((m) => (m[1] ?? "").trim());
    if (!cols || cells.length === 0) {
      return match;
    }
    const rows: string[][] = [];
    for (let i = 0; i < cells.length; i += cols) {
      rows.push(cells.slice(i, i + cols));
    }
    const cellHtml = (text: string, isHead: boolean) => {
      const innerHtml = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).join("<br>");
      return isHead ? `<th>${innerHtml}</th>` : `<td>${innerHtml}</td>`;
    };
    const bodyRows = headerRow ? rows.slice(1) : rows;
    const headRow = rows[0] ?? [];
    const thead = headerRow && headRow.length > 0
      ? `<thead><tr>${headRow.map((c) => cellHtml(c, true)).join("")}</tr></thead>`
      : "";
    const tbody = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => cellHtml(c, false)).join("")}</tr>`).join("")}</tbody>`;
    return `<table>${thead}${tbody}</table>`;
  });
}

/** 剥掉文档内容里可能携带的脚本类构造（同源 iframe 渲染，必须做） */
function stripDangerous(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

/** 画板/图片原生标签替换为本地资产 <img> */
function renderNativeAssets(markdown: string, assets: Record<string, string>, boardScopeOk: boolean): string {
  return markdown.replace(/<(image|whiteboard|board|diagram|mindnote)\s+([^>]*?)\/>/gi, (match, tag: string, attrs: string) => {
    const token = /token="([^"]*)"/.exec(attrs)?.[1];
    const isImage = tag.toLowerCase() === "image";
    const src = token ? assets[token] : null;
    if (src) {
      const cls = isImage ? "zoomable" : "zoomable board-img";
      const alt = isImage ? (token ?? "图片") : "画板";
      return `<img class="${cls}" src="${src}" alt="${alt}">`;
    }
    if (isImage) {
      return `<!-- 图片未下载: ${token ?? "?"} -->`;
    }
    if (!boardScopeOk) {
      return `<div class="board-missing">🖥 画板未渲染：缺少画板权限（board:whiteboard:node:read）。请到飞书开放平台「权限管理」开通该权限并发布新版本，然后在设置页重新扫码授权。</div>`;
    }
    return `<div class="board-missing">🖥 画板图片下载失败，点「重新同步」重试。</div>`;
  });
}

/** 完整查看器页面（iframe 同源 src 加载） */
export function renderDocPage(input: {
  rawMarkdown: string;
  assets: Record<string, string>;
  boardScopeOk: boolean;
}): string {
  const content = input.rawMarkdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const renderable = renderNativeAssets(content, input.assets, input.boardScopeOk);
  const body = stripDangerous(markedParse(renderNativeTables(renderable)));
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<link rel="stylesheet" href="/viewer-inner.css">`
    + `</head><body>${body}`
    + `<script src="/vendor/highlight.min.js"></script>`
    + `<script>${VIEWER_JS}</script>`
    + `</body></html>`;
}

function markedParse(md: string): string {
  return marked.parse(md, { gfm: true, breaks: false }) as string;
}

/** 查看器错误页（拉取失败等） */
export function renderErrorPage(message: string): string {
  const safe = String(message).replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/viewer-inner.css"></head>`
    + `<body><div style="margin:48px auto;max-width:560px;background:#fdeceb;color:#b3261e;border-radius:10px;padding:16px 20px;font-size:14px;line-height:1.8;white-space:pre-wrap">✗ ${safe}</div></body></html>`;
}
