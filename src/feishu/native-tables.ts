/**
 * 原生表格标签 → markdown 表格（推送与查看渲染共用）。
 * 实测（2026-10-04 飞书 docs_ai）：原生 <table>/<table-cell> 标签会被移除并平铺内容
 * （degrade 4010/5002），markdown 表格则完整转成飞书表格块——推送前必须转换。
 */

export function nativeTablesToMarkdown(markdown: string): string {
  return markdown.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (match, attrs: string, inner: string) => {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "";
    const cols = Number.parseInt(attr("column-size"), 10) || 0;
    const headerRow = attr("header-row") === "true" || attr("property-header-row") === "true";
    const cells = [...inner.matchAll(/<table-cell\b[^>]*>([\s\S]*?)<\/table-cell>/gi)].map((m) => (m[1] ?? "").trim());
    if (!cols || cells.length === 0) {
      return match;
    }
    const rows: string[][] = [];
    for (let i = 0; i < cells.length; i += cols) {
      rows.push(cells.slice(i, i + cols));
    }
    const width = Math.max(cols, ...rows.map((r) => r.length));
    const cellText = (text: string) => text.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim() || " ";
    const pad = (row: string[]) => {
      const filled = [...row];
      while (filled.length < width) filled.push(" ");
      return filled;
    };
    const lines: string[] = [];
    if (headerRow && rows.length > 0) {
      lines.push(`| ${pad(rows[0] ?? []).map(cellText).join(" | ")} |`);
      lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
      rows.slice(1).forEach((r) => lines.push(`| ${pad(r).map(cellText).join(" | ")} |`));
    } else {
      rows.forEach((r) => lines.push(`| ${pad(r).map(cellText).join(" | ")} |`));
      if (lines.length > 0) {
        lines.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
      }
    }
    return lines.length > 1 ? lines.join("\n") : match;
  });
}
