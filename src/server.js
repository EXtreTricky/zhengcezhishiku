'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const feishu = require('./feishu');
const session = require('./session');

const {
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET: APP_SECRET,
  FEISHU_REDIRECT_URI,
  FEISHU_SCOPE,
  SESSION_SECRET,
  PORT = '3000',
} = process.env;

const SESSION_TTL = Number(process.env.SESSION_TTL || 604800);
const COOKIE_NAME = 'fsapp_session';
const STATE_COOKIE = 'fsapp_oauth_state';

for (const [k, v] of Object.entries({
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET: APP_SECRET,
  FEISHU_REDIRECT_URI,
  SESSION_SECRET,
})) {
  if (!v) {
    console.error(`[fatal] 缺少必填环境变量 ${k}，请先复制 .env.example 为 .env 并填写`);
    process.exit(1);
  }
}
if (SESSION_SECRET === 'please_change_me_to_a_random_32_byte_hex') {
  console.error('[fatal] SESSION_SECRET 还是默认值，请执行 `openssl rand -hex 32` 生成一个');
  process.exit(1);
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '..', 'public'), { extensions: ['html'] }));

app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = session.open(req.cookies[COOKIE_NAME], SESSION_SECRET);
  // 把 res 透传下去，方便刷新 token 后重写 cookie
  req.res = res;
  next();
});

/**
 * user_access_token 有效期 2 小时。session 的 exp 是 cookie 过期时间（默认 7 天），
 * 无法区分"cookie 没过期但 token 已过期"的情况。
 * 因此用一个更保守的策略：session 创建超过 1 小时就尝试用 refresh_token 续期。
 * 授权时 FEISHU_SCOPE 必须包含 offline_access 才会下发 refresh_token。
 */
const REFRESH_AFTER_SECONDS = 3600; // 1 小时后尝试续期
app.use(async (req, _res, next) => {
  if (!req.user || !req.user.refresh_token) return next();
  const age = Math.floor(Date.now() / 1000) - (req.user.iat || 0);
  if (age < REFRESH_AFTER_SECONDS) return next();
  try {
    const newTokens = await feishu.refreshToken({
      appId: APP_ID,
      appSecret: APP_SECRET,
      refreshToken: req.user.refresh_token,
    });
    // 用新 token 更新 session，保留原有用户信息
    const updated = { ...req.user, ...newTokens };
    delete updated.iat;
    delete updated.exp;
    setCookie(
      req.res,
      COOKIE_NAME,
      session.seal(updated, SESSION_SECRET, SESSION_TTL),
      SESSION_TTL
    );
    req.user = updated;
    console.log(`[refresh] 已续期 user=${req.user.sub}`);
  } catch (err) {
    // 续期失败（refresh_token 可能已过期），不阻塞请求，下次访问会走重新登录
    console.warn('[refresh] 续期失败，下次访问需重新登录:', err.message);
  }
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
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAge,
  ];
  // 生产环境一律 Secure；本地 http 调试时放开
  if (process.env.NODE_ENV !== 'development') attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 登录状态写入加密 Cookie。token 一并保存，业务代码可直接用 user_access_token 调飞书 OpenAPI */
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

// ---------------------------------------------------------------- 路由

// 本地还没申请到飞书应用时，用 MOCK_LOGIN=true npm run dev 绕过飞书直接登录，
// 先看界面、先调业务接口。务必只在本机使用。
if (process.env.MOCK_LOGIN === 'true') {
  console.warn('[warn] MOCK_LOGIN 已开启：登录流程被绕过，任何人都会以模拟身份进入。切勿用于生产环境。');
  app.get('/auth/login', (_req, res) => {
    issueSession(res, {
      tokenData: {
        access_token: 'mock_user_access_token',
        refresh_token: 'mock_refresh_token',
        scope: 'mock',
      },
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
}

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, state, 600); // state 仅 10 分钟有效
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

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`飞书授权失败：${error} ${error_description || ''}`);
  }
  if (!code) {
    return res.status(400).send('回调缺少 code 参数');
  }
  // 校验 state，防 CSRF
  if (!state || state !== req.cookies[STATE_COOKIE]) {
    return res.status(400).send('state 校验失败，可能是跨站请求伪造或登录流程超时，请重新发起登录');
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
    return res.redirect(302, '/');
  } catch (err) {
    console.error('[callback] 免登失败', err);
    return res.status(500).send(`免登失败：${err.message}`);
  }
});

app.post('/auth/logout', (_req, res) => {
  clearCookie(res, COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/auth/logout', (_req, res) => {
  clearCookie(res, COOKIE_NAME);
  res.redirect(302, '/');
});

/** 前端用它判断当前登录态 */
app.get('/api/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false, loginUrl: '/auth/login' });
  }
  const { user_access_token, refresh_token, exp, iat, ...safe } = req.user;
  return res.json({ authenticated: true, ...safe });
});

/**
 * 出网自检：服务器主动访问公网，返回出口 IP。
 * 这是「自建网站应用」相对飞书内嵌 H5 的核心价值——你的后端想连谁就连谁，
 * 不受飞书域名白名单限制。
 */
app.get('/api/egress', async (_req, res) => {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    clearTimeout(timer);
    const { ip } = await r.json();
    res.json({ ok: true, egressIp: ip, rttMs: Date.now() - started });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});

/** 受保护的业务接口示例：把 req.user 换成你自己的业务逻辑 */
app.get('/api/hello', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ message: `你好，${req.user.name}`, openId: req.user.sub });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

if (require.main === module) {
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`飞书自建网站应用已启动：http://0.0.0.0:${PORT}`);
    console.log(`回调地址（需配到飞书后台）：${FEISHU_REDIRECT_URI}`);
  });
}

module.exports = app;
