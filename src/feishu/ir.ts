/**
 * 飞书文档中间表示（IR）。
 * 照抄 MaomiAgent desktop-feishu-doc-ir（含白板可逆恢复结构）。
 */

export type FeishuDocIRBlockType =
  | "page" | "text" | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6" | "heading7" | "heading8" | "heading9"
  | "bullet" | "ordered" | "code" | "quote" | "todo"
  | "callout" | "divider" | "quote-container" | "grid" | "grid-column" | "table" | "table-cell" | "view"
  | "image" | "file" | "iframe" | "whiteboard" | "mindnote" | "diagram"
  | "sheet" | "bitable" | "board" | "chat-card" | "link-preview" | "jira-issue" | "add-ons" | "isv" | "okr"
  | "source-synced" | "reference-synced" | "ai-template" | "undefined";

export type FeishuDocIRTextRunKind =
  | "text" | "mention_user" | "mention_doc" | "equation" | "unknown";

export type FeishuDocIRTextRun = {
  kind: FeishuDocIRTextRunKind;
  /** 展示文本（MaomiAgent 验证版：仅纯文本，样式不入 markdown 以保证可回写） */
  text: string;
  /** 文档提及的链接 */
  url?: string;
  attrs: Record<string, unknown>;
  raw: unknown;
};

export type FeishuDocIRReversibleState = "mermaid" | "unsupported" | "error";

export type FeishuDocIRReversibleAsset = {
  format: "mermaid";
  source: string;
  sourceChecksum: string;
  ordinal: number;
  origin: "whiteboard_code_export" | "docs_ai_markdown";
  state: FeishuDocIRReversibleState;
  lastResolvedAt: string;
  lastError?: string;
};

export type FeishuDocIRAsset = {
  token: string;
  kind: "image" | "file" | "whiteboard" | "mindnote" | "diagram" | "unknown";
  mime: string;
  /** 相对工作区的本地路径（下载成功后填写），POSIX 分隔符 */
  localPath: string;
  status: "missing" | "cached" | "error";
  bytes?: number;
  width?: number;
  height?: number;
  name?: string;
  error?: string;
  reversible?: FeishuDocIRReversibleAsset;
};

export type FeishuDocIRBlock = {
  id: string;
  type: FeishuDocIRBlockType;
  parentId: string | null;
  children: string[];
  /** 可编辑块（page/undefined 之外均可），供无损重推的工作副本编译使用 */
  editable: boolean;
  text: FeishuDocIRTextRun[];
  resource: { token: string; kind: FeishuDocIRAsset["kind"] } | null;
  attrs: Record<string, unknown>;
  raw: unknown;
};

export type FeishuDocIR = {
  schemaVersion: 1;
  document: {
    id: string;
    title: string;
    revisionId: string;
    rootBlockId: string;
    pulledAt: string;
    source: {
      nodeToken?: string;
      documentIdType: "document_id" | "wiki_node_token";
    };
  };
  blocks: Record<string, FeishuDocIRBlock>;
  assets: Record<string, FeishuDocIRAsset>;
  integrity: {
    contentHash: string;
    rawHash: string;
  };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
