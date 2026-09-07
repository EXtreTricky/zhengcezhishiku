'use strict';

/**
 * policy-api —— 政策知识库「自建后端 + 自建前端」
 *
 * 职责：用飞书多维表格 OpenAPI 直连通道（../bitable.js）读取十类政策表，
 *      向自建总览首页（/）与采集审批工作台（/admin/）提供数据与行级写入。
 *
 * 运行：
 *   cd feishu-webapp
 *   node policy-api/src/server.js                # 默认 3000 端口
 *
 * 前端：policy-api/public/ 自持源码（index.html 总览 + app/ 资源 + admin/ 审批台），
 *       不再依赖任何平台编译产物。
 *
 * 已实现接口（浏览闭环 + 统一网关）：
 *   身份（P1 统一网关）：GET /auth/login|callback|logout、GET /api/me、GET /healthz
 *   GET  /api/policies?keyword&category&region&effectiveness&policyType
 *        &sortBy&sortOrder&page&pageSize          政策列表（筛选/排序/分页）
 *   GET  /api/policies/categories                 分类列表（string[]）
 *   GET  /api/policies/:id                        政策详情（认 tblxxx__recxxx）
 *   GET  /api/dashboard/stats                     首页统计（直连口径 source=bitable）
 *   GET  /api/settings/feishu/bitable-url         编辑源表跳转链接
 *   POST /api/bitable/refresh                     清空记录缓存
 *   GET  /api/versions/policy/:policyId   → []    版本（无本地库，空态）
 *   GET  /api/calendar/events            → []     日历（空态）
 */

const path = require('path');
const fs = require('fs');

// 加载 feishu-webapp/.env（含 FEISHU_APP_ID / FEISHU_APP_SECRET）
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const express = require('express');
const { BitableClient } = require('../../src/bitable');
const { POLICY_SOURCES } = require('./policy-sources');
const {
  mapRecord,
  formatDateCells,
  toListItem,
  toDetail,
  queryRecords,
} = require('./normalize');
const { attachAuth, requireUser } = require('./auth');
const { registerWriteRoutes } = require('./write-api');
const { registerCrawlRoutes } = require('./crawl-api');
const cron = require('./cron');
const db = require('../../src/db');

const app = express();

// 生产部署在 Nginx / 负载均衡之后时，必须信任代理：
// 否则 req.protocol 永远是 http，OAuth 回调地址与 Secure Cookie 判断都会错。
app.set('trust proxy', true);

app.use(express.json());

// P1 统一网关：挂载飞书 OAuth 登录（/auth/* + /api/me + /healthz）。
// 必须在下方 SPA fallback（/^\/(?!api\/).*/）之前注册，否则 /auth/* 会被单页路由吞掉。
attachAuth(app);

// ─── 数据层：多表聚合 + 缓存 ──────────────────────────────────────────────

class PolicyDataStore {
  constructor(client) {
    this.client = client;
    this.cache = null; // { data: BitableRecord[], expireAt }
    this.sourceErrors = new Map();
    this.TTL_MS = 5 * 60 * 1000;
  }

  clearCache() {
    this.cache = null;
    this.sourceErrors.clear();
  }

  async loadAll({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && this.cache.expireAt > now) return this.cache.data;

    const all = [];
    const errors = [];
    const BATCH = 3; // 并发上限 3，避免网关超时（与原版一致）
    for (let i = 0; i < POLICY_SOURCES.length; i += BATCH) {
      const batch = POLICY_SOURCES.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (src) => {
          const [records, fields] = await Promise.all([
            this.client.listAllRecords(src.appToken, src.tableId, { viewId: src.viewId }),
            this.client.listFields(src.appToken, src.tableId),
          ]);
          const prefix = `${src.tableId}__`;
          return records.map((r) => {
            const raw = formatDateCells(r.fields || {}, fields);
            const rec = mapRecord({ id: r.record_id, fields: raw, source: src });
            return {
              ...rec,
              id: rec.id.startsWith(prefix) ? rec.id : `${prefix}${rec.id}`,
              topicCategory: src.category,
              policyType: src.category,
            };
          });
        }),
      );
      results.forEach((res, idx) => {
        const src = batch[idx];
        if (res.status === 'fulfilled') {
          all.push(...res.value);
        } else {
          const msg = res.reason && res.reason.message ? res.reason.message : String(res.reason);
          errors.push({ category: src.category, tableId: src.tableId, message: msg });
        }
      });
    }

    this.sourceErrors = new Map(errors.map((e) => [e.tableId, e]));
    // 只在读到数据时写缓存，避免把空结果缓存住
    if (all.length > 0) this.cache = { data: all, expireAt: now + this.TTL_MS };
    return all;
  }

  async getAll() {
    return this.loadAll();
  }

  getLastSourceErrors() {
    return [...this.sourceErrors.values()];
  }
}

const store = new PolicyDataStore(
  new BitableClient({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET }),
);

// ─── 小工具 ───────────────────────────────────────────────────────────────

function parseIntOr(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function topN(counts, n) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function notFoundJson(res, message = '政策不存在') {
  return res.status(404).json({ statusCode: 404, message, error: 'Not Found' });
}

// ─── 路由 ─────────────────────────────────────────────────────────────────

// 首页统计
app.get('/api/dashboard/stats', async (req, res, next) => {
  try {
    const all = await store.getAll();
    const published = all.filter((r) => (r.effectivenessStatus || '').includes('有效')).length;
    const byCategory = new Map();
    const byRegion = new Map();
    for (const r of all) {
      const cat = (r.topicCategory || '其他').trim() || '其他';
      const reg = (r.province || '全国').trim() || '全国';
      byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
      byRegion.set(reg, (byRegion.get(reg) || 0) + 1);
    }
    const recent = [...all]
      .sort((a, b) => {
        const da = a.effectiveDate || a.releaseDate || '';
        const db = b.effectiveDate || b.releaseDate || '';
        return db.localeCompare(da);
      })
      .slice(0, 5)
      .map(toListItem);
    const stats = {
      totalPolicies: all.length,
      publishedPolicies: published,
      // 待审核数来自本地审核单（pending/reviewing），替代原空态 0
      pendingReviews: db.getDb().reviews.filter((r) => r.status === 'pending' || r.status === 'reviewing').length,
      expiringSoon: 0,
      thisMonthNew: 0,
      thisMonthUpdated: 0,
      byCategory: topN(byCategory, 10),
      byRegion: topN(byRegion, 10),
      recentUpdates: recent,
      expiringPolicies: [],
      // needSync=false：直连 Bitable 提供浏览/日历数据，本地 db.js 承载审核/订阅/待同步，
      // 全部功能已可用，不再引导用户跳「管理配置」执行同步。
      needSync: false,
      source: 'bitable',
    };
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// 编辑源表跳转链接（复用真实租户 base host）
app.get('/api/settings/feishu/bitable-url', async (req, res, next) => {
  try {
    const src = POLICY_SOURCES[0];
    const url = `https://ccnev4gkxf4l.feishu.cn/base/${src.appToken}?table=${src.tableId}`;
    res.json({ url, appToken: src.appToken, tableId: src.tableId });
  } catch (err) {
    next(err);
  }
});

// 清缓存
app.post('/api/bitable/refresh', async (req, res, next) => {
  try {
    store.clearCache();
    res.json({ success: true, message: '缓存已清空' });
  } catch (err) {
    next(err);
  }
});

// 政策分类（去重排序）
app.get('/api/policies/categories', async (req, res, next) => {
  try {
    const all = await store.getAll();
    const set = new Set();
    for (const r of all) {
      if (r.topicCategory && r.topicCategory.trim()) set.add(r.topicCategory.trim());
    }
    res.json([...set].sort((a, b) => a.localeCompare(b, 'zh')));
  } catch (err) {
    next(err);
  }
});

// 政策列表
app.get('/api/policies', async (req, res, next) => {
  try {
    const q = req.query;
    const all = await store.getAll();
    const result = queryRecords(all, {
      page: parseIntOr(q.page, 1),
      pageSize: parseIntOr(q.pageSize, 20),
      keyword: q.keyword,
      category: q.category,
      region: q.region,
      effectiveness: q.effectiveness,
      policyType: q.policyType,
      sortBy: q.sortBy,
      sortOrder: q.sortOrder === 'asc' ? 'asc' : 'desc',
    });
    res.json({
      items: result.items.map(toListItem),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
    });
  } catch (err) {
    next(err);
  }
});

// 政策详情（认 tblxxx__recxxx；本地 uuid 分支无本地库不支持）
app.get('/api/policies/:id', async (req, res, next) => {
  try {
    const all = await store.getAll();
    const record = all.find((r) => r.id === req.params.id);
    if (!record) return notFoundJson(res);
    res.json(toDetail(record));
  } catch (err) {
    next(err);
  }
});

// 版本 —— 本地无版本库，保持空态（与原版「查无本地记录返回 []」语义一致）
app.get('/api/versions/policy/:policyId', (req, res) => res.json([]));

// ─── P2 写链路 & P3 采集（feedback/reviews/subscriptions/calendar/crawl）────
registerWriteRoutes(app, { store, bitable: store.client });
registerCrawlRoutes(app, { store, bitable: store.client });

// ─── 审批工作台（自建原生单页，挂 /admin/）──────────────────────────────
// 与 /api/crawl/* 同源，直接复用登录态与行级接口。
// 必须注册在下方自建前端 fallback（非 /api 路径全部回落首页）之前，否则 /admin 被吞。
const adminDir = path.join(__dirname, '..', 'public', 'admin');
if (fs.existsSync(path.join(adminDir, 'index.html'))) {
  app.use(
    '/admin',
    express.static(adminDir, {
      index: 'index.html',
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
      etag: true,
    })
  );
  console.log(`[policy-api] 审批工作台已托管: /admin/`);
} else {
  console.warn(`[policy-api] 未找到审批工作台静态目录 ${adminDir}，跳过 /admin 托管`);
}

// ─── 自建前端托管（政策库总览首页）─────────────────────────────────────
// policy-api/public/ 即前端根：/ = 总览首页，/app/* = 首页资源，/admin/ = 审批工作台。
// 页面全部自持源码、可随时改版；保留「非 /api 回落首页」以兼容历史收藏的深链。
const feDir = path.join(__dirname, '..', 'public');
const feIndexPath = path.join(feDir, 'index.html');
if (fs.existsSync(feIndexPath)) {
  const feHtml = fs.readFileSync(feIndexPath, 'utf8');
  app.use(
    express.static(feDir, {
      index: false,
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
      etag: true,
      lastModified: true,
    })
  );
  // 首页外壳不缓存（前端发新版后用户刷新即可拿到）
  const sendFe = (req, res) =>
    res.type('html').set('Cache-Control', 'no-cache, must-revalidate').send(feHtml);
  app.get('/', sendFe);
  app.get(/^\/(?!api\/).*/, sendFe);
  console.log(`[policy-api] 自建前端已托管: ${feDir}（总览首页 / + 审批台 /admin/）`);
} else {
  app.get('/', (req, res) => {
    res
      .type('html')
      .send(
        `<h3>policy-api 运行中</h3><p>API 端点正常；未找到自建首页 ${feIndexPath}。</p>`,
      );
  });
}

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[policy-api] 未捕获错误:', err && err.stack ? err.stack : err);
  const message = err && err.message ? err.message : 'Internal Server Error';
  res.status(500).json({ statusCode: 500, message, error: 'Internal Server Error' });
});

// ─── 启动 ─────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;

// 先启动端口，再异步预检（不阻塞启动）
app.listen(PORT, () => {
  console.log(`[policy-api] 监听 http://127.0.0.1:${PORT}`);
  console.log(`[policy-api] 表清单: ${POLICY_SOURCES.map((s) => s.category).join('/')}`);
  // 异步预检，不影响启动
  store.client.testConnection(POLICY_SOURCES[0].appToken, POLICY_SOURCES[0].tableId)
    .then((conn) => console.log(`[policy-api] 预检「${POLICY_SOURCES[0].category}」: ${conn.success ? `OK，${conn.recordCount} 条` : conn.message}`))
    .catch((err) => console.error(`[policy-api] 预检失败: ${err.message}`));

  // 启动每日定时爬取调度器
  cron.startScheduler(store.client, POLICY_SOURCES);
});

// ─── 定时爬取 API ──────────────────────────────────────────────────────────

// GET /api/cron/schedule → 获取当前调度状态
app.get('/api/cron/schedule', (req, res) => {
  res.json(cron.getStatus());
});

// PUT /api/cron/schedule → 更新调度时间 { hour, minute, intervalHours, enabled }
app.put('/api/cron/schedule', requireUser, (req, res) => {
  const result = cron.updateSchedule(req.body || {});
  res.json(result);
});

// POST /api/cron/run → 手动触发一次爬取（飞书汇总优先，fallback 本地 sweep）
app.post('/api/cron/run', requireUser, async (req, res, next) => {
  try {
    const result = await cron.runNow();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/cron/local-run → 强制触发一次本地矩阵滚动巡检（跳过飞书汇总）
app.post('/api/cron/local-run', requireUser, async (req, res, next) => {
  try {
    const result = await cron.runLocalNow();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
