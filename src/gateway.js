'use strict';

/**
 * 飞书 SSO 网关
 *
 * 挡在已有业务系统（如 policy-kb）前面：未登录的流量一律拦下走飞书免登，
 * 登录后才反向代理到真实后端。业务系统不需要改一行代码。
 *
 * 启动：
 *   UPSTREAM=http://127.0.0.1:3211 GATEWAY_PORT=3300 node src/gateway.js
 *   MOCK_LOGIN=true ...  本机演示用，跳过飞书直接登录
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const feishu = require('./feishu');
const session = require('./session');

const {
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET: APP_SECRET,
  FEISHU_REDIRECT_URI,
  FEISHU_SCOPE,
  SESSION_SECRET,
  UPSTREAM = 'http://127.0.0.1:3211',
  GATEWAY_PORT = '3300',
} = process.env;

const SESSION_TTL = Number(process.env.SESSION_TTL || 604800);
const COOKIE_NAME = 'fsapp_session';
const STATE_COOKIE = 'fsapp_oauth_state';

if (!APP_ID || !APP_SECRET || !FEISHU_REDIRECT_URI || !SESSION_SECRET) {
  console.error('[fatal] 缺少必填环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_URI / SESSION_SECRET');
  process.exit(1);
}

const app = express();
app.set('trust proxy', true);

app.use((req, _res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = session.open(req.cookies[COOKIE_NAME], SESSION_SECRET);
  next();
});

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAge];
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function issueSession(res, { tokenData, profile }) {
  setCookie(
    res,
    COOKIE_NAME,
    session.seal(
      {
        sub: profile.open_id,
        union_id: profile.union_id,
        name: profile.name,
        avatar: profile.avatar_url,
        email: profile.email,
        tenant_key: profile.tenant_key,
        user_access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        scope: tokenData.scope,
      },
      SESSION_SECRET,
      SESSION_TTL
    ),
    SESSION_TTL
  );
}

// ---------------------------------------------------------------- 登录路由

if (process.env.MOCK_LOGIN === 'true') {
  console.warn('[warn] MOCK_LOGIN 已开启：登录流程被绕过，任何人都能进。切勿用于生产环境。');
  app.get('/auth/login', (_req, res) => {
    issueSession(res, {
      tokenData: { access_token: 'mock', refresh_token: 'mock', scope: 'mock' },
      profile: {
        open_id: 'ou_ba0a6a1e0d5b2c3f4a5b6c7d8e9f0a1b',
        union_id: 'on_8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b',
        name: '张伟（本地模拟）',
        avatar_url: '',
        email: 'zhangwei@example.com',
        tenant_key: 'local_mock',
      },
    });
    res.redirect(302, '/');
  });
} else {
  app.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, STATE_COOKIE, state, 600);
    setCookie(res, 'fsapp_return_to', String(req.query.next || '/'), 600);
    res.redirect(
      302,
      feishu.buildAuthorizeUrl({
        appId: APP_ID,
        redirectUri: FEISHU_REDIRECT_URI,
        state,
        scope: FEISHU_SCOPE || undefined,
      })
    );
  });
}

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`飞书授权失败：${error} ${error_description || ''}`);
  if (!code) return res.status(400).send('回调缺少 code 参数');
  if (!state || state !== req.cookies[STATE_COOKIE]) {
    return res.status(400).send('state 校验失败，请重新发起登录');
  }
  clearCookie(res, STATE_COOKIE);

  try {
    const tokenData = await feishu.exchangeCode({
      appId: APP_ID,
      appSecret: APP_SECRET,
      code,
      redirectUri: FEISHU_REDIRECT_URI,
    });
    const profile = await feishu.getUserInfo(tokenData.access_token);
    issueSession(res, { tokenData, profile });
    res.redirect(302, req.cookies.fsapp_return_to || '/');
  } catch (err) {
    console.error('[callback] 免登失败', err);
    res.status(500).send(`免登失败：${err.message}`);
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ authenticated: false, loginUrl: '/auth/login' });
  const { user_access_token, refresh_token, exp, ...safe } = req.user;
  res.json({ authenticated: true, ...safe });
});

app.all('/auth/logout', (_req, res) => {
  clearCookie(res, COOKIE_NAME);
  res.redirect(302, '/');
});

// ---------------------------------------------------------------- 鉴权守卫

app.use((req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.user) return next();

  // 接口请求返回 401，页面请求跳登录，避免前端拿到一段登录页 HTML 却当成 JSON 解析
  const wantsJson =
    req.path.startsWith('/api/') ||
    (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'unauthorized', loginUrl: '/auth/login' });

  res.redirect(302, '/auth/login?next=' + encodeURIComponent(req.originalUrl));
});

// ---------------------------------------------------------------- 反向代理

app.use(
  createProxyMiddleware({
    target: UPSTREAM,
    changeOrigin: true,
    ws: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // 把飞书身份透传给后端，业务代码想用的时候直接读这几个 header
        if (req.user) {
          proxyReq.setHeader('X-Feishu-Open-Id', req.user.sub);
          proxyReq.setHeader('X-Feishu-User-Name', encodeURIComponent(req.user.name || ''));
          proxyReq.setHeader('X-Feishu-Tenant-Key', req.user.tenant_key || '');
        }
      },
      error: (err, _req, res) => {
        console.error('[proxy] 上游请求失败', err.message);
        res
          .status(502)
          .send(
            `连不上后端服务 ${UPSTREAM}。<br>确认业务系统已经启动，或改 UPSTREAM 环境变量指向正确地址。<br><br><code>${err.message}</code>`
          );
      },
    },
  })
);

app.listen(Number(GATEWAY_PORT), '0.0.0.0', () => {
  console.log(`飞书 SSO 网关已启动：http://0.0.0.0:${GATEWAY_PORT}`);
  console.log(`反向代理到：${UPSTREAM}`);
  console.log(`回调地址（需配到飞书后台）：${FEISHU_REDIRECT_URI}`);
});
