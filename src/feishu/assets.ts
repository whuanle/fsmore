import fs from "node:fs";
import path from "node:path";
import type { FeishuOpenApiClient } from "./client.js";
import { openApiUrl } from "./tree.js";

/**
 * 飞书资源下载（图片/附件/白板图片导出），本地落盘。
 * 参考 MaomiAgent 的 drive/v1/medias/download 与 board whiteboard download_as_image。
 */

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
};

export type AssetKindForDownload = "image" | "file" | "whiteboard" | "mindnote" | "diagram" | "unknown";

export type DownloadedAsset = {
  token: string;
  fileName: string;
  /** 相对 destDir 的文件名 */
  localPath: string;
  mime: string;
  bytes: number;
};

function extFromContentType(contentType: string): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_CONTENT_TYPE[base] ?? (base.startsWith("image/") ? base.slice("image/".length) || "bin" : "bin");
}

function safeFileStem(token: string): string {
  return token.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "asset";
}

/**
 * 下载一个素材到 destDir。
 * - image / file → GET /drive/v1/medias/{token}/download
 * - whiteboard / mindnote / diagram → GET /board/v1/whiteboards/{token}/download_as_image
 */
export async function downloadAsset(input: {
  client: FeishuOpenApiClient;
  accessToken: string;
  token: string;
  kind: AssetKindForDownload;
  destDir: string;
}): Promise<DownloadedAsset> {
  const useWhiteboardApi = input.kind === "whiteboard" || input.kind === "mindnote" || input.kind === "diagram";
  const url = useWhiteboardApi
    ? openApiUrl(`/board/v1/whiteboards/${encodeURIComponent(input.token)}/download_as_image`)
    : openApiUrl(`/drive/v1/medias/${encodeURIComponent(input.token)}/download`);

  const { bytes, contentType } = await input.client.downloadBinary(url, input.accessToken);
  const ext = extFromContentType(contentType);
  const fileName = `${safeFileStem(input.token)}.${ext}`;
  const absolutePath = path.join(input.destDir, fileName);

  fs.mkdirSync(input.destDir, { recursive: true });
  fs.writeFileSync(path.join(input.destDir, fileName), bytes);

  return {
    token: input.token,
    fileName,
    localPath: fileName,
    mime: contentType.split(";")[0]?.trim() ?? "",
    bytes: bytes.length,
  };
}
