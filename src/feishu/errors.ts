import { FeishuOpenApiError } from "./client.js";

/**
 * 把飞书 API 错误翻译成用户可操作的建议（中文提示）。
 */
export function describeFeishuError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!(error instanceof FeishuOpenApiError)) {
    return base;
  }

  const code = error.code;
  const hints: Record<number, string> = {
    99991661: "App ID 不存在或凭证无效，请检查「设置」中的 App ID / App Secret。",
    99991663: "App Secret 错误或凭证无效，请检查「设置」中的 App ID / App Secret。",
    99991668: "应用未开通此 API 的调用权限，请在飞书开放平台「开发配置 → 权限管理」中开通并发布版本。",
    99991672: "应用没有所需的 API 权限（scope），请在「权限管理」中开通对应只读权限并发布新版本。",
    1770002: "知识库节点不存在，或应用未被添加为该知识库的成员（请把应用加为知识库协作者）。",
    1770032: "知识库节点不存在或无权访问，请把应用添加为知识库成员。",
    131006: "云空间文件/文件夹不存在，或应用无权访问（请把应用添加为该文件夹的协作者）。",
    230001: "文档元信息不存在，或应用无权访问该文档。",
    230002: "文档 Block 获取失败，请确认应用具备文档读取权限。",
  };

  const hint = (code != null ? hints[code] : undefined)
    ?? guessHintFromMessage(base);

  return hint ? `${base}\n建议：${hint}` : base;
}

/** 判断错误是否属于「用户授权失效」类（提示重新扫码） */
export function isUserAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("扫码授权") || message.includes("refresh_token 失效");
}

function guessHintFromMessage(message: string): string | undefined {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission") || normalized.includes("forbidden")) {
    return "应用无权访问该资源：请开通对应 API 权限，或把应用添加为文档/知识库/文件夹的协作者。";
  }
  if (normalized.includes("not found") || normalized.includes("notexist") || normalized.includes("not exist")) {
    return "资源不存在或应用无权访问（飞书对无权限的资源通常也返回不存在）：请确认链接正确，并把应用添加为协作者。";
  }
  if (normalized.includes("frequency") || normalized.includes("too many") || normalized.includes("rate")) {
    return "触发飞书接口限流，请稍后重试或降低同步并发。";
  }
  return undefined;
}
