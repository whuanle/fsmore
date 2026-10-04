import assert from "node:assert/strict";
import { test } from "node:test";

import { FeishuTokenManager, type FeishuOpenApiClient, type FeishuUserTokens } from "../src/feishu/client.js";

/** 可编程的假 OpenAPI 客户端：只实现 TokenManager 用到的三个方法 */
function fakeClient(handlers: {
  refresh?: (refreshToken: string) => FeishuUserTokens | Promise<FeishuUserTokens>;
  tenant?: () => { tenantAccessToken: string; expiresAt: string };
}) {
  return {
    async refreshUserAccessToken(input: { refreshToken: string }) {
      if (!handlers.refresh) {
        const error = new Error("飞书 OAuth 失败（code 20064）：refresh token has been revoked");
        throw error;
      }
      return handlers.refresh(input.refreshToken);
    },
    async getTenantAccessToken() {
      if (!handlers.tenant) {
        throw new Error("no tenant handler");
      }
      return handlers.tenant();
    },
    async exchangeOAuthCode() {
      throw new Error("not implemented in fake");
    },
  } as unknown as FeishuOpenApiClient;
}

function makeTokens(
  minutesUntilAccessExpiry: number,
  refreshToken = "rt_1",
  accessToken = "at_old",
): FeishuUserTokens {
  const now = Date.now();
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: new Date(now + minutesUntilAccessExpiry * 60 * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function memoryStore(initial?: FeishuUserTokens) {
  let value = initial;
  return {
    get: () => value,
    save: (tokens: FeishuUserTokens) => {
      value = tokens;
    },
    clear: () => {
      value = undefined;
    },
  };
}

const creds = { appId: "cli_x", appSecret: "sec" };

test("自动续期心跳：距过期 >10 分钟时不刷新", async () => {
  let refreshCount = 0;
  const store = memoryStore(makeTokens(30));
  const manager = new FeishuTokenManager(fakeClient({
    refresh: () => {
      refreshCount += 1;
      return makeTokens(120, "rt_2");
    },
  }), () => creds, store);

  const result = await manager.autoRefreshTick();
  assert.equal(result.refreshed, false);
  assert.equal(refreshCount, 0);
});

test("自动续期心跳：距过期 <10 分钟时主动刷新并持久化轮换的 refresh_token", async () => {
  let refreshCount = 0;
  const store = memoryStore(makeTokens(5));
  const manager = new FeishuTokenManager(fakeClient({
    refresh: () => {
      refreshCount += 1;
      return makeTokens(120, "rt_2");
    },
  }), () => creds, store);

  const result = await manager.autoRefreshTick();
  assert.equal(result.refreshed, true);
  assert.equal(refreshCount, 1);
  assert.equal(store.get()?.refreshToken, "rt_2");
  assert.ok(manager.refreshInfo.lastRefreshAt);
  assert.equal(manager.refreshInfo.lastError, undefined);

  // 刷新后再次心跳：新令牌 120 分钟，不应重复刷新
  await manager.autoRefreshTick();
  assert.equal(refreshCount, 1);
});

test("自动续期心跳：refresh_token 失效时清空授权并提示重新扫码", async () => {
  const store = memoryStore(makeTokens(5));
  const manager = new FeishuTokenManager(fakeClient({
    refresh: () => {
      throw new Error("飞书 OAuth 失败（code 20064）：refresh token has been revoked");
    },
  }), () => creds, store);

  const result = await manager.autoRefreshTick();
  assert.equal(result.refreshed, false);
  assert.ok(result.error?.includes("重新扫码") || result.error?.includes("refresh_token"));
  assert.equal(store.get(), undefined);
  assert.equal(manager.channel, "tenant");
});

test("自动续期心跳：瞬时失败不清空授权，记录 lastError 供下次重试", async () => {
  let shouldFail = true;
  const store = memoryStore(makeTokens(5));
  const manager = new FeishuTokenManager(fakeClient({
    refresh: () => {
      if (shouldFail) {
        throw new Error("network timeout");
      }
      return makeTokens(120, "rt_3");
    },
  }), () => creds, store);

  const failed = await manager.autoRefreshTick();
  assert.equal(failed.refreshed, false);
  assert.equal(manager.refreshInfo.lastError, "network timeout");
  assert.ok(store.get(), "瞬时失败不应清空授权");

  shouldFail = false;
  const ok = await manager.autoRefreshTick();
  assert.equal(ok.refreshed, true);
  assert.equal(store.get()?.refreshToken, "rt_3");
  assert.equal(manager.refreshInfo.lastError, undefined);
});

test("withToken：用户通道遇到令牌过期错误时自动刷新重试", async () => {
  const store = memoryStore(makeTokens(120, "rt_1"));
  let refreshCount = 0;
  const manager = new FeishuTokenManager(fakeClient({
    refresh: () => {
      refreshCount += 1;
      return makeTokens(240, "rt_2", "at_new");
    },
  }), () => creds, store);

  let calls = 0;
  const result = await manager.withToken(async (token) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(token, "at_old");
      const error = new Error("飞书 API 错误 99991663：access token expired");
      throw error;
    }
    // 第二次调用应携带刷新后的新令牌
    assert.equal(token, "at_new");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(refreshCount, 1);
});

test("未授权时 getToken 走 tenant 通道；授权后走用户通道", async () => {
  const store = memoryStore(undefined);
  let tenantCount = 0;
  const manager = new FeishuTokenManager(fakeClient({
    tenant: () => {
      tenantCount += 1;
      return { tenantAccessToken: "tt_1", expiresAt: new Date(Date.now() + 7200 * 1000).toISOString() };
    },
    refresh: () => makeTokens(120, "rt_x"),
  }), () => creds, store);

  assert.equal(manager.channel, "tenant");
  assert.equal(await manager.getToken(), "tt_1");
  assert.equal(tenantCount, 1);

  store.save(makeTokens(30, "rt_1"));
  assert.equal(manager.channel, "user");
  assert.equal(await manager.getToken(), "at_old");
  assert.equal(tenantCount, 1, "授权后不应再请求 tenant token");
});
