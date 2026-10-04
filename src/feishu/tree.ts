import type { FeishuOpenApiClient } from "./client.js";
import { FEISHU_API_BASE } from "./base.js";

/**
 * 文档源识别与树拉取（参考 MaomiAgent feishu-doc-tree-remote-source 移植，
 * 扩展：飞书云空间 drive 文件夹树、wiki 空间顶层节点、链接解析）。
 */

export type RootKind = "wiki_space" | "wiki_node" | "folder" | "doc";

export type RecognizedRoot = {
  kind: RootKind;
  /** 树节点 token：wiki 节点用 node_token，文件夹用 folder token，文档用 document_id */
  token: string;
  /** 内容 document_id（wiki 节点为 obj_token；文档为自身） */
  docId?: string;
  objType?: string;
  spaceId?: string;
  title: string;
  /** 从用户粘贴的链接中提取的域名，用于拼回去源 URL */
  domain?: string;
};

export type RemoteNode = {
  token: string;
  kind: "wiki" | "folder" | "doc" | "other";
  title: string;
  objType?: string;
  hasChild: boolean;
  docId?: string;
  remoteUrl?: string;
};

type WikiNodePayload = {
  token?: string;
  node_token?: string;
  obj_token?: string;
  obj_type?: string;
  title?: string;
  has_child?: boolean;
  space_id?: string;
};

type WikiListNodesResponse = {
  items?: WikiNodePayload[];
  has_more?: boolean;
  page_token?: string;
};

type WikiSpacesResponse = {
  items?: Array<{ space_id?: string; name?: string; description?: string }>;
  has_more?: boolean;
  page_token?: string;
};

type DriveFilesResponse = {
  files?: Array<{ token?: string; name?: string; type?: string; url?: string }>;
  has_more?: boolean;
  next_page_token?: string;
};

type WikiGetNodeResponse = { node?: WikiNodePayload };

type FeishuDocumentResponse = {
  document?: { document_id?: string; title?: string; revision_id?: string | number };
};

const DOCX_OBJ_TYPES = new Set(["doc", "docx"]);
const OTHER_OBJ_TYPES = new Set(["sheet", "bitable", "mindnote", "file", "slides", "board", "mindnote"]);
const WIKI_FALLBACK_ERRORS = ["230027", "not found", "not_found", "bad request", "field validation", "wrong kind", "wrong-kind"];

export function openApiUrl(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const query = search.toString();
  return `${FEISHU_API_BASE}${normalizedPath}${query ? `?${query}` : ""}`;
}

/** 解析用户粘贴的飞书链接或裸 token */
export function parseFeishuLink(input: string): { token: string; kindGuess?: "wiki" | "doc" | "folder"; domain?: string } {
  const raw = input.trim();
  const withDomain = /^(https?:\/\/[^/]+)\/(?:wiki|docx|docs|folder)\/([A-Za-z0-9]+)/.exec(raw);
  if (withDomain) {
    const [, domain, token] = withDomain;
    const section = /\/(wiki|docx|docs|folder)\//.exec(raw)?.[1];
    return {
      token: token ?? raw,
      kindGuess: section === "wiki" ? "wiki" : section === "folder" ? "folder" : "doc",
      domain: domain?.replace(/^https?:\/\//, ""),
    };
  }

  const bare = /^[A-Za-z0-9]+$/.test(raw) ? raw : "";
  if (!bare) {
    throw new Error(`无法识别的链接或 token：${input}`);
  }
  if (bare.startsWith("wik") || bare.startsWith("WIK")) {
    return { token: bare, kindGuess: "wiki" };
  }
  if (bare.startsWith("fld") || bare.startsWith("FLD")) {
    return { token: bare, kindGuess: "folder" };
  }
  return { token: bare, kindGuess: "doc" };
}

/** 识别一个根：wiki 节点 → 云空间文件夹 → 普通文档 */
export async function recognizeRoot(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: string,
): Promise<RecognizedRoot> {
  const { token, domain } = parseFeishuLink(input);

  try {
    const response = await client.getJson<WikiGetNodeResponse>(
      openApiUrl("/wiki/v2/spaces/get_node", { token }),
      accessToken,
    );
    const node = response.node ?? {};
    const nodeToken = node.node_token || node.token || token;
    return {
      kind: "wiki_node",
      token: nodeToken,
      docId: node.obj_token || undefined,
      objType: node.obj_type,
      spaceId: node.space_id,
      title: node.title || token,
      domain,
    };
  } catch (wikiError) {
    if (!shouldFallbackToDocument(wikiError)) {
      throw wikiError;
    }
  }

  // 云空间文件夹：直接尝试列文件（能列出即认为存在）
  try {
    const response = await client.getJson<DriveFilesResponse>(
      openApiUrl("/drive/v1/files", { folder_token: token, page_size: 1 }),
      accessToken,
    );
    if (response.files !== undefined || response.has_more !== undefined) {
      return { kind: "folder", token, title: token, domain };
    }
  } catch {
    // 继续按文档处理
  }

  const response = await client.getJson<FeishuDocumentResponse>(
    openApiUrl(`/docx/v1/documents/${encodeURIComponent(token)}`),
    accessToken,
  );
  const document = response.document ?? {};
  return {
    kind: "doc",
    token,
    docId: document.document_id || token,
    objType: "docx",
    title: document.title || token,
    domain,
  };
}

/** 列出 wiki 空间（应用可见的知识库）。开放平台接口不提供空间封面图，前端按 spaceId 生成固定渐变色卡片。 */
export async function listWikiSpaces(
  client: FeishuOpenApiClient,
  accessToken: string,
): Promise<Array<{ spaceId: string; name: string; description: string }>> {
  const result: Array<{ spaceId: string; name: string; description: string }> = [];
  let pageToken: string | undefined;
  do {
    const response = await client.getJson<WikiSpacesResponse>(
      openApiUrl("/wiki/v2/spaces", { page_size: 50, page_token: pageToken }),
      accessToken,
    );
    for (const item of response.items ?? []) {
      if (item.space_id) {
        result.push({
          spaceId: item.space_id,
          name: item.name || item.space_id,
          description: item.description || "",
        });
      }
    }
    pageToken = response.has_more ? response.page_token : undefined;
  } while (pageToken);
  return result;
}

/**
 * 列出某个树节点的子节点。
 * - spaceId + 无 parentToken → wiki 空间顶层节点
 * - wiki 节点 → 子节点列表
 * - 云空间文件夹 → 文件列表
 */
export async function listChildren(
  client: FeishuOpenApiClient,
  accessToken: string,
  input: { kind: RootKind; token: string; spaceId?: string; domain?: string },
): Promise<RemoteNode[]> {
  if (input.kind === "doc") {
    return [];
  }

  if (input.kind === "folder") {
    return listDriveFolderChildren(client, accessToken, input.token, input.domain);
  }

  const nodes: RemoteNode[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.getJson<WikiListNodesResponse>(
      openApiUrl(`/wiki/v2/spaces/${encodeURIComponent(input.spaceId ?? "")}/nodes`, {
        parent_node_token: input.kind === "wiki_node" ? input.token : undefined,
        page_size: 50,
        page_token: pageToken,
      }),
      accessToken,
    );
    for (const item of response.items ?? []) {
      const node = wikiItemToNode(item, input.domain);
      if (node.token) {
        nodes.push(node);
      }
    }
    pageToken = response.has_more ? response.page_token : undefined;
  } while (pageToken);

  return nodes;
}

async function listDriveFolderChildren(
  client: FeishuOpenApiClient,
  accessToken: string,
  folderToken: string,
  domain?: string,
): Promise<RemoteNode[]> {
  const nodes: RemoteNode[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.getJson<DriveFilesResponse>(
      openApiUrl("/drive/v1/files", {
        folder_token: folderToken,
        order_by: "CreatedTime",
        direction: "ASC",
        page_size: 200,
        page_token: pageToken,
      }),
      accessToken,
    );
    for (const file of response.files ?? []) {
      if (!file.token) {
        continue;
      }
      const type = file.type || "";
      if (type === "folder") {
        nodes.push({
          token: file.token,
          kind: "folder",
          title: file.name || file.token,
          objType: "folder",
          hasChild: true,
          remoteUrl: buildRemoteUrl(domain, "folder", file.token),
        });
      } else if (DOCX_OBJ_TYPES.has(type)) {
        nodes.push({
          token: file.token,
          kind: "doc",
          title: file.name || file.token,
          objType: "docx",
          hasChild: false,
          docId: file.token,
          remoteUrl: buildRemoteUrl(domain, "docx", file.token),
        });
      } else if (OTHER_OBJ_TYPES.has(type)) {
        nodes.push({
          token: file.token,
          kind: "other",
          title: file.name || file.token,
          objType: type,
          hasChild: false,
          remoteUrl: file.url || buildRemoteUrl(domain, type, file.token),
        });
      }
      // 未知类型忽略
    }
    pageToken = response.has_more ? response.next_page_token : undefined;
  } while (pageToken);

  return nodes;
}

function wikiItemToNode(item: WikiNodePayload, domain?: string): RemoteNode {
  const token = item.node_token || item.token || "";
  const objType = item.obj_type || "";
  const isDoc = DOCX_OBJ_TYPES.has(objType);
  const isOther = OTHER_OBJ_TYPES.has(objType);

  return {
    token,
    kind: isDoc ? "doc" : isOther ? "other" : "wiki",
    title: item.title || token,
    objType: objType || undefined,
    hasChild: item.has_child === true,
    docId: isDoc ? item.obj_token : undefined,
    remoteUrl: token ? buildRemoteUrl(domain, "wiki", token) : undefined,
  };
}

export function buildRemoteUrl(domain: string | undefined, section: string, token: string): string {
  const host = domain || "feishu.cn";
  return `https://${host}/${section}/${token}`;
}

function shouldFallbackToDocument(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return WIKI_FALLBACK_ERRORS.some((marker) => message.includes(marker));
}
