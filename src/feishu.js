'use strict';

/**
 * 飞书开放平台「身份验证（SSO）」客户端
 * 文档：https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code
 *
 * 采用 v2 版换取令牌接口（authen/v2/oauth/token），相比 v1 少一步「先换 app_access_token」。
 */

const FEISHU_BASE = 'https://open.feishu.cn';
const FEISHU_AUTH_TIMEOUT_MS = Math.max(1000, Number(process.env.FEISHU_AUTH_TIMEOUT_MS || 12000));

async function fetchWithTimeout(url, options = {}, timeoutMs = FEISHU_AUTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 组装授权跳转地址：用户浏览器 302 到这里，飞书校验身份后带 code 回跳 redirect_uri */
function buildAuthorizeUrl({ appId, redirectUri, state, scope }) {
  const u = new URL('/open-apis/authen/v1/authorize', FEISHU_BASE);
  u.searchParams.set('app_id', appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  if (scope) u.searchParams.set('scope', scope);
  return u.toString();
}

async function postJson(pathname, body) {
  const url = new URL(pathname, FEISHU_BASE);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`飞书返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  if (json.code !== 0) {
    const err = new Error(`飞书接口报错 code=${json.code} msg=${json.msg || json.error?.msg || '未知'}`);
    err.code = json.code;
    err.feishuMsg = json.msg;
    err.logId = json.error?.log_id;
    throw err;
  }
  // v1 接口（如 tenant_access_token）数据在根层；v2 接口（token/user_info）在 data 下
  return json.data !== undefined ? json.data : json;
}

/**
 * 用一次性 code 换取 user_access_token
 * 注意：code 有效期 5 分钟，且只能用一次
 */
function exchangeCode({ appId, appSecret, code, redirectUri }) {
  return postJson('/open-apis/authen/v2/oauth/token', {
    grant_type: 'authorization_code',
    client_id: appId,
    client_secret: appSecret,
    code,
    redirect_uri: redirectUri,
  });
}

/** 用 refresh_token 续期（授权时 scope 需包含 offline_access 才会下发 refresh_token） */
function refreshToken({ appId, appSecret, refreshToken }) {
  return postJson('/open-apis/authen/v2/oauth/token', {
    grant_type: 'refresh_token',
    client_id: appId,
    client_secret: appSecret,
    refresh_token: refreshToken,
  });
}

/** 凭 user_access_token 取当前登录用户的身份信息 */
async function getUserInfo(userAccessToken) {
  const url = new URL('/open-apis/authen/v1/user_info', FEISHU_BASE);
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`获取用户信息失败 code=${json.code} msg=${json.msg || '未知'}`);
  }
  return json.data;
}

/** 换取 tenant_access_token：业务代码以「应用身份」调用飞书 OpenAPI 时使用 */
function getTenantAccessToken(appId, appSecret) {
  return postJson('/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: appId,
    app_secret: appSecret,
  });
}

module.exports = {
  FEISHU_BASE,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  getUserInfo,
  getTenantAccessToken,
};
