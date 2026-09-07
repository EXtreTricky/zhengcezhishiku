'use strict';

/**
 * auth.js —— 飞书 OAuth 登录能力（从早期 src/server.js 抽取，供 policy-api 单进程复用）
 *
 * 设计：
 *  - 无状态会话：登录态用 AES-256-GCM 加密后塞进 HttpOnly Cookie（src/session.js）
 *  - user_access_token / refresh_token 一并入 session，业务代码可直接调飞书 OpenAPI
 *  - 挂载顺序：必须在 SPA fallback（除 /api 前缀外的路径全部回落单页）之前 attach，否则 /auth 路由被吞
 *
 * 暴露：
 *  attachAuth(app, { egress?, hello? })  —— 挂载 /auth/login|callback|logout + /api/me + /healthz
 *  requireUser                           —— 保护写接口：未登录 401 { authenticated:false, loginUrl }
 */

const crypto = require('crypto');

const feishu = require('../../src/feishu');
const session = require('../../src/session');

const {
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET: APP_SECRET,
  FEISHU_REDIRECT_URI,
  FEISHU_SCOPE,
  SESSION_SECRET,
} = process.env;

const SESSION_TTL = Number(process.env.SESSION_TTL || 604800);
const COOKIE_NAME = 'fsapp_session';
const STATE_COOKIE = 'fsapp_oauth_state';

for (const [k, v] of Object.entries({
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET: APP_SECRET,
  SESSION_SECRET,
})) {
  if (!v) {
    console.error(`[auth][fatal] 缺少必填环境变量 ${k}（policy-api 需要飞书能力），请检查 feishu-webapp/.env`);
    process.exit(1);
  }
}
if (SESSION_SECRET === 'please_change_me_to_a_random_32_byte_hex') {
  console.error('[auth][fatal] SESSION_SECRET 还是默认值，请执行 `openssl rand -hex 32` 生成一个');
  process.exit(1);
}

// 真实 OAuth 需要「公网可达的回调地址」+ 飞书后台登记。部署前通常为空：
// 此时可降级运行（只读/SPA//api/me 正常），本地登录验证用 MOCK_LOGIN=true，
// 完整真实登录在 P5 部署配置 FEISHU_REDIRECT_URI 后启用。
const oauthEnabled = Boolean(APP_ID && APP_SECRET && FEISHU_REDIRECT_URI);
if (!oauthEnabled && process.env.MOCK_LOGIN !== 'true') {
  console.warn(
    '[auth][warn] FEISHU_REDIRECT_URI 未配置：真实 OAuth 登录不可用。' +
      '本地调试可设 MOCK_LOGIN=true；生产部署请配置回调地址并在飞书后台登记。'
  );
}

const REFRESH_AFTER_SECONDS = 3600; // 1 小时后尝试用 refresh_token 续期

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

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Cookie 属性。
 * 生产用 SameSite=None + Secure：飞书网页应用常在内嵌 WebView / iframe 中打开，
 * 此时会话 Cookie 属于第三方 Cookie，Lax 会被浏览器丢弃导致「登录后立刻掉线」。
 * SameSite=None 必须搭配 Secure（否则浏览器直接拒绝），因此生产环境必须上 HTTPS。
 */
const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || (IS_PROD ? 'None' : 'Lax');
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === 'true' || IS_PROD || (COOKIE_SAMESITE === 'None' && !isDevLike());

function isDevLike() {
  // 本地 http 调试（NODE_ENV=development 且未显式要求 Secure）时不加 Secure，否则 Cookie 发不出去
  return process.env.NODE_ENV === 'development' && process.env.COOKIE_SECURE !== 'true';
}

function cookieAttrs(maxAge) {
  const attrs = [
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAMESITE}`,
    'Max-Age=' + maxAge,
  ];
  if (COOKIE_SECURE) attrs.push('Secure');
  return attrs;
}

function setCookie(res, name, value, maxAge) {
  res.append('Set-Cookie', [`${name}=${encodeURIComponent(value)}`, ...cookieAttrs(maxAge)].join('; '));
}

function clearCookie(res, name) {
  res.append('Set-Cookie', [`${name}=`, ...cookieAttrs(0)].join('; '));
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

/**
 * 把身份能力挂到传入的 express app 上。
 * 中间件顺序：cookie/session 解析 → 过期续期 → /auth/* + /api/me（+ 可选 /api/egress、/api/hello）。
 */
function attachAuth(app) {
  // ① cookie 解析 + session 开启（最先执行）
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.user = session.open(req.cookies[COOKIE_NAME], SESSION_SECRET);
    req.res = res; // 供续期时重写 cookie
    next();
  });

  // ② user_access_token 过期续期（session cookie 7 天，token 2 小时，超 1 小时尝试续期）
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
      console.log(`[auth] 已续期 user=${req.user.sub}`);
    } catch (err) {
      // 续期失败（refresh_token 可能已过期），不阻塞请求，下次访问会走重新登录
      console.warn('[auth] 续期失败，下次访问需重新登录:', err.message);
    }
    next();
  });

  // ④ 登录入口
  // 生产环境硬拦截：MOCK_LOGIN 会绕过飞书身份验证，任何人都能进入，绝不允许上线
  if (IS_PROD && process.env.MOCK_LOGIN === 'true') {
    console.error('[auth][fatal] 生产环境（NODE_ENV=production）禁止开启 MOCK_LOGIN，已拒绝启动。');
    process.exit(1);
  }
  if (process.env.MOCK_LOGIN === 'true') {
    // 本地调试：绕过飞书直接登录（务必只在本机使用）
    console.warn('[auth][warn] MOCK_LOGIN 已开启：登录流程被绕过，任何人都会以模拟身份进入。切勿用于生产环境。');
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
  } else if (oauthEnabled) {
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
  } else {
    // 未配置回调且非 MOCK：明确 501，避免被 SPA fallback 吞成首页
    app.get('/auth/login', (_req, res) =>
      res.status(501).json({
        error: 'auth_not_configured',
        hint: '配置 FEISHU_REDIRECT_URI（并在飞书后台登记），或本地调试设 MOCK_LOGIN=true',
      })
    );
  }

  // ⑤ 授权回调：换 token → 取身份 → 写 session（仅真实 OAuth 可用时注册）
  if (oauthEnabled) {
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
        return res
          .status(400)
          .send('state 校验失败，可能是跨站请求伪造或登录流程超时，请重新发起登录');
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
        console.error('[auth][callback] 免登失败', err);
        return res.status(500).send(`免登失败：${err.message}`);
      }
    });
  } else if (process.env.MOCK_LOGIN !== 'true') {
    app.get('/auth/callback', (_req, res) =>
      res.status(501).json({ error: 'auth_not_configured', hint: 'FEISHU_REDIRECT_URI 未配置' })
    );
  }

  // ⑥ 登出
  app.post('/auth/logout', (_req, res) => {
    clearCookie(res, COOKIE_NAME);
    res.json({ ok: true });
  });
  app.get('/auth/logout', (_req, res) => {
    clearCookie(res, COOKIE_NAME);
    res.redirect(302, '/');
  });

  // ⑦ 登录态探测（前端用它判断是否需要跳登录；浏览只读接口不要求登录）
  app.get('/api/me', (req, res) => {
    if (!req.user) {
      // MOCK 模式：告知前端可自动登录（/auth/login 会绕过飞书写入模拟 cookie）
      if (process.env.MOCK_LOGIN === 'true') {
        return res.json({ authenticated: false, mock: true, loginUrl: '/auth/login' });
      }
      return res.status(401).json({ authenticated: false, loginUrl: '/auth/login' });
    }
    const { user_access_token, refresh_token, exp, iat, ...safe } = req.user;
    return res.json({ authenticated: true, ...safe });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  console.log('[auth] 飞书 OAuth 登录能力已挂载（/auth/login /auth/callback /api/me）');
}

/** 写接口保护中间件：未登录 → 401，前端收到后引导 /auth/login */
function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ authenticated: false, loginUrl: '/auth/login', error: 'unauthorized' });
  }
  return next();
}

module.exports = { attachAuth, requireUser };
