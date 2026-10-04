/**
 * 文本补丁推送（对齐 MaomiAgent feishu-doc-patch-planner/executor 的安全语义）：
 * 把草稿与基线 IR 做「文档顺序」对齐，只允许修改已有块的文本 → 逐块 PATCH
 * update_text_elements（官方 API）。任何结构变更（增删段落/换类型/原生块内容变化）一律阻断，
 * 表格/画板等原生块永不重发，远端原块原封不动。
 */

import { randomUUID } from "node:crypto";
import type { FeishuOpenApiClient } from "./client.js";
import { openApiUrl } from "./tree.js";
import type { FeishuDocIR, FeishuDocIRBlock } from "./ir.js";

const HEADING_PATTERN = /^(#{1,9})\s+(.*)$/;
const BULLET_PATTERN = /^(\s*)-\s+(?!\[)(.*)$/;
const ORDERED_PATTERN = /^(\s*)\d+\.\s+(.*)$/;
const TODO_PATTERN = /^(\s*)-\s+\[[ xX]?\]\s*(.*)$/;
const QUOTE_PATTERN = /^>\s?(.*)$/;
const NATIVE_TAG_PATTERN = /^<[a-zA-Z][^>]*>?/;
const NATIVE_TAG_NAME_PATTERN = /^<([a-zA-Z][a-zA-Z0-9-]*)/;

const EDITABLE_TEXT_TYPES = new Set([
  "text", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "heading7", "heading8", "heading9",
  "bullet", "ordered", "todo", "quote", "code",
]);

const NATIVE_CONTAINER_TYPES = new Set([
  "table", "bitable", "sheet", "board", "whiteboard", "diagram", "mindnote",
  "image", "file", "callout", "grid", "grid-column", "quote-container", "view", "iframe",
  "chat-card", "link-preview", "jira-issue", "add-ons", "isv", "okr",
  "source-synced", "reference-synced", "ai-template", "undefined",
]);

type DraftTextKind =
  | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6" | "heading7" | "heading8" | "heading9"
  | "text" | "bullet" | "ordered" | "todo" | "quote" | "code";

type DraftItem =
  | { kind: DraftTextKind; text: string }
  | { kind: "native"; tag: string; innerText: string; tableCells: string[] };

/** 草稿 markdown（含原生标签）→ 文档顺序条目序列 */
export function parseDraftItems(markdown: string): DraftItem[] {
  const items: DraftItem[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // 原生标签块（<tag ...>...</tag> 或自闭合）
    const nativeMatch = NATIVE_TAG_NAME_PATTERN.exec(line.trim());
    if (nativeMatch) {
      const tag = (nativeMatch[1] ?? "").toLowerCase();
      const flow = new RegExp(`</${tag}\\s*>\\s*$`, "i").test(line)
        || lines.slice(i, i + 400).some((l, offset) => offset > 0 && new RegExp(`</${tag}\\s*>`, "i").test(l));
      if (flow) {
        // 收集整个标签块直到闭合
        let block = line;
        let j = i;
        while (j < lines.length && !new RegExp(`</${tag}\\s*>`, "i").test(block)) {
          j += 1;
          block += `\n${lines[j] ?? ""}`;
        }
        const inner = block.replace(/^[^>]*>/, "").replace(new RegExp(`</${tag}\\s*>[\\s\\S]*$`, "i"), "");
        // 单元格：配对写法取内容；自闭合写法按出现次数计（空单元格）
        const cells = [...inner.matchAll(/<table-cell\b[^>]*>([\s\S]*?)<\/table-cell>/gi)]
          .map((m) => (m[1] ?? "").trim().replace(/\n+/g, " "));
        const selfClosingCells = [...inner.matchAll(/<table-cell\b[^>]*\/>/gi)];
        for (let k = 0; k < selfClosingCells.length; k += 1) {
          cells.push("");
        }
        items.push({ kind: "native", tag, innerText: inner.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), tableCells: cells });
        i = j + 1;
        continue;
      }
      // 自闭合
      items.push({ kind: "native", tag, innerText: "", tableCells: [] });
      i += 1;
      // 紧随 table 的自闭合 <table-cell ... /> 行：并入该 table 的 cells（基线里 cell 文本在 cell 子块）
      if (tag === "table") {
        const last = items[items.length - 1]!;
        if (last.kind === "native") {
          while (i < lines.length && /^<table-cell\b[^>]*\/>\s*$/i.test((lines[i] ?? "").trim())) {
            last.tableCells.push("");
            i += 1;
          }
        }
      }
      continue;
    }

    // 代码围栏
    const fence = /^(`{3,}|~{3,})/.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[j] ?? "")) {
        body.push(lines[j] ?? "");
        j += 1;
      }
      items.push({ kind: "code", text: body.join("\n").replace(/\s+$/, "") });
      i = j + 1;
      continue;
    }

    const text = line.trim();
    if (!text) {
      i += 1;
      continue;
    }
    const heading = HEADING_PATTERN.exec(text);
    if (heading?.[2] !== undefined) {
      items.push({ kind: `heading${heading[1]!.length}` as DraftTextKind, text: heading[2].trim() });
      i += 1;
      continue;
    }
    const todo = TODO_PATTERN.exec(line);
    if (todo?.[2] !== undefined) {
      items.push({ kind: "todo", text: todo[2].trim() });
      i += 1;
      continue;
    }
    const bullet = BULLET_PATTERN.exec(line);
    if (bullet?.[2] !== undefined) {
      items.push({ kind: "bullet", text: bullet[2].trim() });
      i += 1;
      continue;
    }
    const ordered = ORDERED_PATTERN.exec(line);
    if (ordered?.[2] !== undefined) {
      items.push({ kind: "ordered", text: ordered[2].trim() });
      i += 1;
      continue;
    }
    const quote = QUOTE_PATTERN.exec(text);
    if (quote?.[1] !== undefined) {
      items.push({ kind: "quote", text: quote[1].trim() });
      i += 1;
      continue;
    }
    items.push({ kind: "text", text });
    i += 1;
  }
  return items;
}

type BaseItem =
  | { kind: FeishuDocIRBlock["type"]; text: string; blockId: string; parentId: string; rootDirect: boolean }
  | { kind: "native"; blockType: FeishuDocIRBlock["type"]; blockId: string; parentId: string; innerText: string; tableCellIds: string[]; rootDirect: boolean };

/** 基线 IR → 文档顺序条目序列（原生块子树折叠为单个条目；文本块深度遍历） */
export function collectBaseItems(ir: FeishuDocIR): BaseItem[] {
  const items: BaseItem[] = [];
  const visit = (blockId: string, parentId: string, rootDirect: boolean): void => {
    const block = ir.blocks[blockId];
    if (!block) {
      return;
    }
    if (NATIVE_CONTAINER_TYPES.has(block.type)) {
      const cells = block.type === "table"
        ? block.children.map((childId) => ir.blocks[childId]).filter(Boolean)
        : [];
      items.push({
        kind: "native",
        blockType: block.type,
        blockId: block.id,
        parentId,
        innerText: blockTextDeep(ir, block),
        tableCellIds: cells.map((c) => c!.id),
        rootDirect,
      });
      return; // 原生子树不再下钻
    }
    if (EDITABLE_TEXT_TYPES.has(block.type)) {
      items.push({ kind: block.type, text: block.text.map((run) => run.text).join(""), blockId: block.id, parentId, rootDirect });
    }
    for (const childId of block.children) {
      visit(childId, block.id, false); // 只有 root 直接子块是 rootDirect
    }
  };
  for (const childId of ir.blocks[ir.document.rootBlockId]?.children ?? []) {
    visit(childId, ir.document.rootBlockId, true);
  }
  return items;
}

function blockTextDeep(ir: FeishuDocIR, block: FeishuDocIRBlock): string {
  const own = block.text.map((run) => run.text).join("");
  const childText = block.children
    .map((childId) => ir.blocks[childId])
    .filter(Boolean)
    .map((child) => blockTextDeep(ir, child!))
    .filter(Boolean)
    .join(" ");
  return [own, childText].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export type TextPatchPlan =
  | {
      status: "ready";
      /** 文本 PATCH 操作（只改已有块，不动结构） */
      operations: Array<{ blockId: string; text: string }>;
      /** 新增纯文本段落：插在锚点块之后（官方 insert API）；afterBlockId 为空 = 插最前 */
      inserts: Array<{ afterBlockId: string; text: string }>;
      /** 待删除的纯文本块（官方 batch_delete，按父块分组定位 index） */
      deletes: Array<{ blockId: string; parentId: string }>;
      baseRevisionId: string;
    }
  | { status: "blocked"; message: string };

/**
 * 规划文本补丁（锚点对齐）：草稿与基线条目做最长公共子序列匹配，锚点（内容一致的条目）之间：
 * - 草稿多出的纯文本段 → insert（插在前一个锚点后）；基线多出的纯文本块 → delete
 * - 锚点内文本变化 → update_text；表格锚点内可改单元格文本
 * - 锚点间出现的原生块差异 / 类型变化 / 数据块内容修改 → blocked（防损坏）
 */
export function planTextPatch(input: { baseIr: FeishuDocIR; draftMarkdown: string }): TextPatchPlan {
  const baseItems = collectBaseItems(input.baseIr);
  const draftItems = parseDraftItems(input.draftMarkdown.replace(/^---\n[\s\S]*?\n---\n/, ""));
  const hasNative = baseItems.some((item) => item.kind === "native");
  const operations: Array<{ blockId: string; text: string }> = [];
  const inserts: Array<{ afterBlockId: string; text: string }> = [];
  const deletes: Array<{ blockId: string; parentId: string }> = [];

  // 无原生块：结构变更交由整文重建路径处理，这里返回不可用标记
  if (!hasNative) {
    return { status: "blocked", message: "__no_native__" };
  }

  // LCS 匹配锚点（类型+内容一致才算锚点；表格按 cell 数匹配，文本差异在锚点内 diff）
  const itemKey = (item: typeof baseItems[number] | typeof draftItems[number]): string => {
    if (item.kind === "native") {
      const d = item as typeof draftItems[number] & { kind: "native" };
      const b = item as Extract<typeof baseItems[number], { kind: "native" }>;
      if ((d.tag ?? b.blockType) === "table") {
        return `native:table:${(d.tableCells ?? b.tableCellIds ?? []).length}`;
      }
      return `native:${d.tag ?? b.blockType}:${(d.innerText ?? b.innerText ?? "")}`;
    }
    return `${item.kind}:${item.text}`;
  };
  const baseKeys = baseItems.map(itemKey);
  const draftKeys = draftItems.map(itemKey);
  const lcs: number[][] = Array.from({ length: baseItems.length + 1 }, () => new Array(draftItems.length + 1).fill(0));
  for (let i = baseItems.length - 1; i >= 0; i -= 1) {
    for (let j = draftItems.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = baseKeys[i] === draftKeys[j] ? (lcs[i + 1]![j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }

  type Segment = { baseStart: number; baseEnd: number; draftStart: number; draftEnd: number };
  const segments: Segment[] = [];
  let bi = 0;
  let dj = 0;
  while (bi < baseItems.length && dj < draftItems.length) {
    if (baseKeys[bi] === draftKeys[dj]) {
      segments.push({ baseStart: bi, baseEnd: bi + 1, draftStart: dj, draftEnd: dj + 1 });
      bi += 1;
      dj += 1;
      continue;
    }
    // 找下一个锚点
    let ni = -1;
    let nj = -1;
    for (let i = bi; i < baseItems.length && ni < 0; i += 1) {
      const j = draftKeys.indexOf(baseKeys[i]!, dj);
      if (j >= 0) {
        ni = i;
        nj = j;
      }
    }
    if (ni < 0) {
      break;
    }
    segments.push({ baseStart: bi, baseEnd: ni, draftStart: dj, draftEnd: nj });
    bi = ni;
    dj = nj;
  }
  if (bi < baseItems.length || dj < draftItems.length) {
    segments.push({ baseStart: bi, baseEnd: baseItems.length, draftStart: dj, draftEnd: draftItems.length });
  }

  /** 插入锚点：最近一个 root 直接子块（新段落挂 root 时按它定位 index） */
  let lastRootAnchorId: string | null = null;
  for (const segment of segments) {
    const baseSlice = baseItems.slice(segment.baseStart, segment.baseEnd);
    const draftSlice = draftItems.slice(segment.draftStart, segment.draftEnd);

    // 锚点段（1:1 且 key 相同）：内容一致，只处理其内部（表格单元格）
    const isAnchor = baseSlice.length === 1 && draftSlice.length === 1
      && baseKeys[segment.baseStart] === draftKeys[segment.draftStart];
    if (isAnchor) {
      const base = baseSlice[0]!;
      const draft = draftSlice[0]!;
      if (base.rootDirect) {
        lastRootAnchorId = base.blockId;
      }
      if (base.kind === "native" && draft.kind === "native") {
        if (base.blockType === "table" && draft.tag === "table") {
          if (base.tableCellIds.length !== draft.tableCells.length) {
            return { status: "blocked", message: "表格的行列结构有修改，请到飞书中操作（推送会损坏表格）。" };
          }
          for (let c = 0; c < base.tableCellIds.length; c += 1) {
            const cellId = base.tableCellIds[c]!;
            const cellBlock = input.baseIr.blocks[cellId];
            const textChildId = cellBlock?.children
              .map((childId) => input.baseIr.blocks[childId])
              .find((child) => child && child.type === "text")?.id;
            const targetId = textChildId ?? cellId;
            const baseText = (input.baseIr.blocks[targetId]?.text ?? [])
              .map((run) => run.text).join("").replace(/\s+/g, " ").trim();
            const draftText = (draft.tableCells[c] ?? "").trim();
            if (draftText !== baseText) {
              operations.push({ blockId: targetId, text: draftText });
            }
          }
        }
      }
      continue;
    }

    // 差异段：只允许纯文本条目（原生块增删一律阻断）
    if (baseSlice.some((item) => item.kind === "native") || draftSlice.some((item) => item.kind === "native")) {
      return {
        status: "blocked",
        message: "改动涉及新增/删除表格、画板等原生块，请到飞书中操作（推送无法安全还原这类结构变化）。",
      };
    }

    // 两指针贪心 diff：一致 → 配对；草稿多出的项 → insert；基线多出的项 → delete；文本不同 → update
    let bi = 0;
    let dj = 0;
    while (bi < baseSlice.length || dj < draftSlice.length) {
      const base = baseSlice[bi] as Extract<BaseItem, { text: string }> | undefined;
      const draft = draftSlice[dj] as Extract<typeof draftItems[number], { text: string }> | undefined;
      if (base && draft && base.kind === draft.kind && base.text === draft.text) {
        if (base.rootDirect) {
          lastRootAnchorId = base.blockId;
        }
        bi += 1;
        dj += 1;
        continue;
      }
      const nextDraft = draftSlice[dj + 1] as typeof draft | undefined;
      const nextBase = baseSlice[bi + 1] as typeof base | undefined;
      // 草稿当前项多余（草稿的下一项与基线当前项一致）→ insert
      if (base && draft && nextDraft && nextDraft.kind === base.kind && nextDraft.text === base.text) {
        inserts.push({ afterBlockId: lastRootAnchorId ?? "", text: draft.text });
        dj += 1;
        continue;
      }
      // 基线当前项多余（基线的下一项与草稿当前项一致）→ delete
      if (base && draft && nextBase && nextBase.kind === draft.kind && nextBase.text === draft.text) {
        deletes.push({ blockId: base.blockId, parentId: base.parentId });
        bi += 1;
        continue;
      }
      // 无法跳过 → 按配对处理（文本修改 / 类型变化阻断 / 单边剩余）
      if (base && draft) {
        if (base.kind !== draft.kind) {
          return { status: "blocked", message: `段落类型变化（${draft.kind} vs ${base.kind}），含原生块的文档只支持修改文字。` };
        }
        if (draft.text !== base.text) {
          operations.push({ blockId: base.blockId, text: draft.text });
        }
        if (base.rootDirect) {
          lastRootAnchorId = base.blockId;
        }
        bi += 1;
        dj += 1;
        continue;
      }
      if (base && !draft) {
        deletes.push({ blockId: base.blockId, parentId: base.parentId });
        bi += 1;
        continue;
      }
      if (!base && draft) {
        inserts.push({ afterBlockId: lastRootAnchorId ?? "", text: draft.text });
        dj += 1;
        continue;
      }
    }
  }

  return {
    status: "ready",
    operations,
    inserts,
    deletes,
    baseRevisionId: String(input.baseIr.document.revisionId ?? ""),
  };
}

/** 执行文本补丁：delete → insert → 逐块 PATCH（对齐 MaomiAgent patchApi.updateText + 结构操作） */
export async function executeTextPatch(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: {
    docId: string;
    baseRevisionId: string;
    operations: Array<{ blockId: string; text: string }>;
    inserts: Array<{ afterBlockId: string; text: string }>;
    deletes: Array<{ blockId: string; parentId: string }>;
  },
): Promise<void> {
  // 删除纯文本块（按父块分组，组内倒序删避免索引位移）
  if (input.deletes.length > 0) {
    const byParent = new Map<string, string[]>();
    for (const item of input.deletes) {
      const parentId = item.parentId || input.docId;
      const list = byParent.get(parentId) ?? [];
      list.push(item.blockId);
      byParent.set(parentId, list);
    }
    for (const [parentId, blockIds] of byParent) {
      const children = await listChildBlocks(client, accessToken, input.docId, parentId);
      const indices = blockIds
        .map((blockId) => children.indexOf(blockId))
        .filter((index) => index >= 0)
        .sort((a, b) => b - a);
      for (const index of indices) {
        const url = openApiUrl(
          `/docx/v1/documents/${encodeURIComponent(input.docId)}/blocks/${encodeURIComponent(parentId)}/children/batch_delete`,
          { document_revision_id: -1, client_token: randomUUID() },
        );
        await client.deleteJson(url, accessToken, { start_index: index, end_index: index + 1 });
      }
    }
  }

  // 新增纯文本段（官方「创建嵌套块」/descendant：挂 root、index 定位——该端点实测支持 index）
  // afterBlockId 为空 = 插在文档最前（此前会被静默跳过，导致「推送成功」却什么都没写）
  let frontInsertCount = 0;
  for (const insert of input.inserts) {
    const newBlockId = randomUUID().replace(/-/g, "").slice(0, 28);
    // 计算 root children 中锚点块的位置（新段插在锚点之后；无锚点插最前，连续多条按顺序递增）
    const rootChildren = await listChildBlocks(client, accessToken, input.docId, input.docId);
    const anchorIndex = insert.afterBlockId ? rootChildren.indexOf(insert.afterBlockId) : -1;
    const insertIndex = insert.afterBlockId
      ? (anchorIndex >= 0 ? anchorIndex + 1 : -1)
      : frontInsertCount;
    const url = openApiUrl(
      `/docx/v1/documents/${encodeURIComponent(input.docId)}/blocks/${encodeURIComponent(input.docId)}/descendant`,
      { document_revision_id: -1, client_token: randomUUID() },
    );
    await client.postJson(url, accessToken, {
      children_id: [newBlockId],
      descendants: [{
        block_id: newBlockId,
        block_type: 2,
        parent_id: input.docId,
        text: { elements: [{ text_run: { content: insert.text } }] },
      }],
      index: insertIndex,
    });
    if (!insert.afterBlockId) {
      frontInsertCount += 1;
    }
  }

  // 文本 PATCH
  for (const operation of input.operations) {
    const url = openApiUrl(
      `/docx/v1/documents/${encodeURIComponent(input.docId)}/blocks/${encodeURIComponent(operation.blockId)}`,
      {
        document_revision_id: -1,
        client_token: randomUUID(),
      },
    );
    await client.patchJson(url, accessToken, {
      update_text_elements: {
        elements: [{ text_run: { content: operation.text } }],
      },
    });
  }
}

async function listChildBlocks(client: FeishuOpenApiClient, accessToken: string, docId: string, blockId: string): Promise<string[]> {
  const data = await client.getJson<{ items?: Array<{ block_id?: string }> }>(
    openApiUrl(`/docx/v1/documents/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(blockId)}/children`, { page_size: 500 }),
    accessToken,
  );
  return (data.items ?? []).map((item) => item.block_id ?? "").filter(Boolean);
}
