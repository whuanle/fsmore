import { FEISHU_API_BASE } from "./base.js";

const FEISHU_TENANT_ACCESS_TOKEN_URL = `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`;
const FEISHU_OAUTH_TOKEN_URL = `${FEISHU_API_BASE}/authen/v2/oauth/token`;
const FEISHU_USER_INFO_URL = `${FEISHU_API_BASE}/authen/v1/user_info`;

export class FeishuOpenApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly responseText?: string;

  constructor(input: { message: string; status: number; code?: number; responseText?: string }) {
    super(input.message);
    this.name = "FeishuOpenApiError";
    this.status = input.status;
    this.code = input.code;
    this.responseText = input.responseText;
  }
}

type FeishuEnvelope<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type FeishuTenantAccessTokenData = {
  tenant_access_token?: string;
  expire?: number;
};

type FeishuOAuthTokenData = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  scope?: string;
};

type FeishuUserInfoData = {
  name?: string;
  en_name?: string;
  open_id?: string;
  user?: { name?: string; en_name?: string; open_id?: string };
};

export type FeishuTenantAccessToken = {
  tenantAccessToken: string;
  expiresAt: string;
};

/** 扫码授权（user_access_token）凭证 */
export type FeishuUserTokens = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  scope?: string;
};

export type FeishuOpenApiClientOptions = {
  fetch?: typeof fetch;
  now?: () => Date;
};

/** 无法识别为 JSON 的响应（如二进制素材）时抛出 */
export class FeishuUnexpectedContentTypeError extends Error {
  readonly contentType: string;
  constructor(contentType: string) {
    super(`Feishu API returned non-JSON response (content-type: ${contentType})`);
    this.name = "FeishuUnexpectedContentTypeError";
    this.contentType = contentType;
  }
}

export class FeishuOpenApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: FeishuOpenApiClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getTenantAccessToken(input: { appId: string; appSecret: string }): Promise<FeishuTenantAccessToken> {
    const response = await this.fetchImpl(FEISHU_TENANT_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: input.appId,
        app_secret: input.appSecret,
      }),
    });

    const text = await response.text();
    let envelope: FeishuEnvelope<FeishuTenantAccessTokenData> & Partial<FeishuTenantAccessTokenData>;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`飞书 API 返回了非 JSON 响应：HTTP ${response.status}`);
    }

    const data = envelope.data ?? envelope;
    if (envelope.code != null && envelope.code !== 0) {
      throw new FeishuOpenApiError({
        message: `获取 tenant_access_token 失败（code ${envelope.code}）：${envelope.msg || "request failed"}`,
        status: response.status,
        code: envelope.code,
        responseText: text,
      });
    }
    if (!data.tenant_access_token || data.expire == null) {
      throw new Error("飞书 API 响应缺少 tenant_access_token 数据");
    }

    return {
      tenantAccessToken: data.tenant_access_token,
      expiresAt: new Date(this.now().getTime() + data.expire * 1000).toISOString(),
    };
  }

  /** 扫码授权回调 code 换取 user_access_token（OAuth v2 端点） */
  async exchangeOAuthCode(input: {
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<FeishuUserTokens> {
    const data = await this.postOAuthToken({
      grant_type: "authorization_code",
      client_id: input.appId,
      client_secret: input.appSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    });
    return this.toUserTokens(data, { requireRefreshToken: false });
  }

  /** 用 refresh_token 换取新的 user_access_token（v2 端点会轮换 refresh_token） */
  async refreshUserAccessToken(input: {
    appId: string;
    appSecret: string;
    refreshToken: string;
  }): Promise<FeishuUserTokens> {
    const data = await this.postOAuthToken({
      grant_type: "refresh_token",
      client_id: input.appId,
      client_secret: input.appSecret,
      refresh_token: input.refreshToken,
    });
    return this.toUserTokens(data, { requireRefreshToken: true });
  }

  /** 读取授权用户信息（尽力而为，用于界面展示） */
  async getUserInfo(accessToken: string): Promise<{ name?: string; openId?: string }> {
    const data = await this.getJson<FeishuUserInfoData>(FEISHU_USER_INFO_URL, accessToken);
    const user = data.user;
    return {
      name: user?.name ?? data.name ?? user?.en_name ?? data.en_name,
      openId: user?.open_id ?? data.open_id,
    };
  }

  async getJson<T>(url: string, accessToken: string): Promise<T> {
    return this.readEnvelope<T>(
      await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
  }

  async postJson<T>(url: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
    return this.readEnvelope<T>(
      await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async deleteJson<T>(url: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
    return this.readEnvelope<T>(
      await this.fetchImpl(url, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async putJson<T>(url: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
    return this.readEnvelope<T>(
      await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async patchJson<T>(url: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
    return this.readEnvelope<T>(
      await this.fetchImpl(url, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  /** 下载二进制素材（图片/文件/白板导出）。若飞书返回 JSON 错误则按普通 API 错误解析。 */
  async downloadBinary(url: string, accessToken: string): Promise<{ bytes: Buffer; contentType: string }> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || contentType.includes("application/json")) {
      const text = await response.text();
      let code: number | undefined;
      let msg = response.statusText;
      try {
        const parsed = JSON.parse(text) as FeishuEnvelope<unknown>;
        code = parsed.code;
        msg = parsed.msg || msg;
      } catch {
        // 非 JSON 错误体
      }
      throw new FeishuOpenApiError({
        message: `飞书素材下载失败 (code ${code ?? response.status})：${msg}`,
        status: response.status,
        code,
        responseText: text,
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, contentType };
  }

  private async postOAuthToken(body: Record<string, string>): Promise<FeishuOAuthTokenData> {
    const response = await this.fetchImpl(FEISHU_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let envelope: FeishuEnvelope<FeishuOAuthTokenData> & Partial<FeishuOAuthTokenData>;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`飞书 OAuth 端点返回了非 JSON 响应：HTTP ${response.status}`);
    }
    if (envelope.code != null && envelope.code !== 0) {
      throw new FeishuOpenApiError({
        message: `飞书 OAuth 失败（code ${envelope.code}）：${envelope.msg || "request failed"}`,
        status: response.status,
        code: envelope.code,
        responseText: text,
      });
    }
    const data = envelope.data ?? envelope;
    return data;
  }

  private toUserTokens(
    data: FeishuOAuthTokenData,
    options: { requireRefreshToken: boolean },
  ): FeishuUserTokens {
    const accessToken = data.access_token;
    const expiresIn = data.expires_in;
    const refreshToken = data.refresh_token ?? "";
    const refreshExpiresIn = data.refresh_expires_in;
    const missing = [
      !accessToken ? "access_token" : "",
      expiresIn == null ? "expires_in" : "",
      options.requireRefreshToken && !refreshToken ? "refresh_token" : "",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`飞书 OAuth 响应缺少字段：${missing.join(", ")}`);
    }

    const nowMs = this.now().getTime();
    return {
      accessToken: accessToken!,
      refreshToken,
      accessTokenExpiresAt: new Date(nowMs + expiresIn! * 1000).toISOString(),
      refreshTokenExpiresAt: refreshExpiresIn == null
        ? ""
        : new Date(nowMs + refreshExpiresIn * 1000).toISOString(),
      scope: data.scope,
    };
  }

  private async readEnvelope<T>(response: Response): Promise<T> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new FeishuUnexpectedContentTypeError(contentType || "unknown");
    }

    const text = await response.text();
    let envelope: FeishuEnvelope<T>;
    try {
      envelope = JSON.parse(text) as FeishuEnvelope<T>;
    } catch {
      throw new Error(`飞书 API 返回了非 JSON 响应：HTTP ${response.status}`);
    }

    const code = envelope.code ?? 0;
    if (code !== 0) {
      throw new FeishuOpenApiError({
        message: `飞书 API 错误 ${code}：${envelope.msg || "request failed"}`,
        status: response.status,
        code,
        responseText: text,
      });
    }
    if (envelope.data == null) {
      throw new Error("飞书 API 响应缺少 data");
    }

    return envelope.data;
  }
}

function isTenantTokenInvalidError(error: unknown): boolean {
  if (!(error instanceof FeishuOpenApiError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("tenant access token")
    && (message.includes("expired") || message.includes("invalid"))
  );
}

function isUserAccessTokenInvalidError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("refresh token")) {
    return false;
  }
  return message.includes("access token") && (message.includes("expired") || message.includes("invalid"));
}

function isRefreshTokenInvalidError(error: unknown): boolean {
  if (error instanceof FeishuOpenApiError && error.code != null && error.code === 20064) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("refresh token") && (
    message.includes("revoked") || message.includes("expired") || message.includes("invalid")
  );
}

/** user_access_token 存储适配器（fsmore 用 config.json 实现） */
export type UserTokenStorage = {
  get(): FeishuUserTokens | undefined;
  save(tokens: FeishuUserTokens): void;
  clear(): void;
};

/** 提前刷新余量：访问令牌距过期不足该时长时，自动续期任务会主动刷新 */
const USER_TOKEN_REFRESH_AHEAD_MS = 10 * 60 * 1000;
/** 自动续期检查间隔（由 index.ts 的定时器调用） */
export const USER_TOKEN_AUTO_REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * 双通道 token 管理：
 * - 已扫码授权 → user_access_token 通道（主通道：所有文档请求以用户角色发出，
 *   支持用时刷新 + 定时主动续期，refresh_token 轮换后立即持久化）
 * - 未授权 → tenant_access_token 通道（仅授权前的临时回退）
 */
export class FeishuTokenManager {
  private tenantToken?: FeishuTenantAccessToken;
  private inflightTenant?: Promise<string>;
  private inflightUser?: Promise<string>;
  private lastRefreshAt?: string;
  private lastRefreshError?: string;

  constructor(
    private readonly client: FeishuOpenApiClient,
    private readonly getCredentials: () => { appId: string; appSecret: string },
    private readonly userStore?: UserTokenStorage,
  ) {}

  /** 当前生效通道 */
  get channel(): "user" | "tenant" {
    return this.userStore?.get() ? "user" : "tenant";
  }

  get tenantExpiresAt(): string | undefined {
    return this.tenantToken?.expiresAt;
  }

  get userTokenExpiresAt(): string | undefined {
    return this.userStore?.get()?.accessTokenExpiresAt;
  }

  get refreshTokenExpiresAt(): string | undefined {
    return this.userStore?.get()?.refreshTokenExpiresAt;
  }

  /** 最近一次 user_access_token 刷新记录（供状态页展示） */
  get refreshInfo(): { lastRefreshAt?: string; lastError?: string } {
    return { lastRefreshAt: this.lastRefreshAt, lastError: this.lastRefreshError };
  }

  async getToken(): Promise<string> {
    return this.channel === "user" ? this.getUserAccessToken() : this.getTenantToken();
  }

  async getTenantToken(force = false): Promise<string> {
    if (!force && this.tenantToken && new Date(this.tenantToken.expiresAt).getTime() - 5 * 60 * 1000 > Date.now()) {
      return this.tenantToken.tenantAccessToken;
    }

    this.inflightTenant ??= (async () => {
      const { appId, appSecret } = this.getCredentials();
      if (!appId || !appSecret) {
        throw new Error("尚未配置飞书应用凭证（App ID / App Secret），请先在「设置」页填写");
      }
      try {
        const token = await this.client.getTenantAccessToken({ appId, appSecret });
        this.tenantToken = token;
        return token.tenantAccessToken;
      } finally {
        this.inflightTenant = undefined;
      }
    })();

    return this.inflightTenant;
  }

  async getUserAccessToken(force = false): Promise<string> {
    const stored = this.userStore?.get();
    if (!stored) {
      throw new Error("尚未完成飞书扫码授权，请到「设置」页完成扫码授权");
    }
    if (!force && new Date(stored.accessTokenExpiresAt).getTime() - 60 * 1000 > Date.now()) {
      return stored.accessToken;
    }

    this.inflightUser ??= (async () => {
      const current = this.userStore?.get();
      if (!current) {
        throw new Error("尚未完成飞书扫码授权，请到「设置」页完成扫码授权");
      }
      const { appId, appSecret } = this.getCredentials();
      try {
        const tokens = await this.client.refreshUserAccessToken({
          appId,
          appSecret,
          refreshToken: current.refreshToken,
        });
        this.userStore?.save(tokens);
        this.lastRefreshAt = new Date().toISOString();
        this.lastRefreshError = undefined;
        return tokens.accessToken;
      } catch (error) {
        this.lastRefreshError = error instanceof Error ? error.message : String(error);
        if (isRefreshTokenInvalidError(error)) {
          this.userStore?.clear();
          throw new Error("飞书授权已过期（refresh_token 失效），请到「设置」页重新扫码授权");
        }
        throw error;
      } finally {
        this.inflightUser = undefined;
      }
    })();

    return this.inflightUser;
  }

  /**
   * 定时自动续期心跳：已授权且访问令牌即将过期（<10 分钟）时主动刷新。
   * 由 index.ts 每 60 秒调用一次；refresh 失败仅记录，下个心跳自动重试。
   */
  async autoRefreshTick(): Promise<{ refreshed: boolean; error?: string }> {
    const stored = this.userStore?.get();
    if (!stored) {
      return { refreshed: false };
    }
    const remainingMs = new Date(stored.accessTokenExpiresAt).getTime() - Date.now();
    if (remainingMs > USER_TOKEN_REFRESH_AHEAD_MS) {
      return { refreshed: false };
    }
    try {
      await this.getUserAccessToken(true);
      return { refreshed: true };
    } catch (error) {
      // refresh_token 失效时 userStore 已被清空并转换为友好错误；此处只吞掉异常等待下个心跳
      return { refreshed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 包裹一次 API 调用：令牌过期/失效时自动刷新并重试一次 */
  async withToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const channel = this.channel;
    const token = await this.getToken();
    try {
      return await call(token);
    } catch (error) {
      if (channel === "user" && isUserAccessTokenInvalidError(error)) {
        return call(await this.getUserAccessToken(true));
      }
      if (channel === "tenant" && isTenantTokenInvalidError(error)) {
        return call(await this.getTenantToken(true));
      }
      throw error;
    }
  }
}
