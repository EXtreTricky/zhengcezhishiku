'use strict';

/**
 * write-api.js —— P2 写链路 & 工作流（1:1 复刻原版 policy-kb 契约，落本地应用态 db.json）
 *
 * 依赖契约：docs/write-contract.md（Explore 精读 policy-kb/server 所得）
 *
 * 覆盖：
 *   feedback  意见/纠错簿   GET/POST /api/feedback、PATCH /api/feedback/:id
 *   reviews   审核中心      GET/POST /api/reviews、/start、/approve|reject|return
 *   subscription 订阅偏好   GET/POST/PATCH/DELETE /api/subscriptions
 *   calendar  日历事件      GET /api/calendar/events（由政策生效/发布日期实时聚合，替换空态）
 *   bitable   待同步队列    POST /api/bitable/sync-out（Bitable 写权限就绪后补推本地待同步写操作）
 *
 * 设计说明：
 *   - 应用态（feedback/review/订阅/审核状态）落 data/db.json（src/db.js），与只读 Bitable 直连解耦；
 *   - 对 Bitable 源表「写回」的请求一律先尝试真实 OpenAPI，403 无写权限时自动降级进
 *     syncOutbox（本地待同步队列），权限开通后可调 POST /api/bitable/sync-out 一键补推；
 *   - 认证：写操作 requireUser（401 {authenticated:false, loginUrl}），读操作公开。
 */

const express = require('express');
const db = require('../../src/db');
const { requireUser } = require('./auth');
const { toListItem } = require('./normalize');

// ─── 工具 ─────────────────────────────────────────────────────────────

function isDateText(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function isDateLike(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}/.test(v);
}

/** 人工/机器复核报告：复刻原版 IMachineReport 结构 */
function runMachineValidation(rec, all) {
  const passItems = [];
  const riskItems = [];
  const missingFields = [];
  const conflictItems = [];
  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

  const required = [
    ['title', '标题'],
    ['issuingAuthority', '发文机关'],
    ['releaseDate', '发布日期'],
    ['effectiveDate', '生效日期'],
    ['applicableRegion', '适用地区'],
  ];
  for (const [k, label] of required) {
    if (!str(rec[k])) missingFields.push(label);
  }
  if (str(rec.title)) passItems.push('标题完整可读');
  if (str(rec.documentNumber)) {
    if (/〔\d{4}〕/.test(rec.documentNumber)) passItems.push('文号格式规范');
    else riskItems.push({ field: 'documentNumber', level: 'warn', message: '文号格式可疑（建议含〔年份〕）' });
  } else {
    riskItems.push({ field: 'documentNumber', level: 'warn', message: '缺少文号，建议补充核对' });
  }
  // 日期逻辑
  if (isDateText(rec.releaseDate) && isDateText(rec.effectiveDate)) {
    if (rec.effectiveDate >= rec.releaseDate) passItems.push('生效日期不早于发布日期');
    else riskItems.push({ field: 'effectiveDate', level: 'high', message: '生效日期早于发布日期，异常' });
  }
  // 状态
  const statusText = str(rec.effectivenessStatus);
  if (/有效|现行/.test(statusText)) passItems.push(`效力状态：${statusText}`);
  else riskItems.push({ field: 'effectivenessStatus', level: 'warn', message: `效力状态待确认（${statusText || '未填写'}）` });
  // 正文可读性
  const contentLen = str(rec.content || rec.summary).length;
  if (contentLen >= 40) passItems.push(`正文 ${contentLen} 字，可读`);
  else riskItems.push({ field: 'content', level: contentLen === 0 ? 'high' : 'warn', message: contentLen === 0 ? '缺少正文内容' : `正文过短（${contentLen} 字）` });
  // 来源
  if (/^https?:\/\//i.test(str(rec.url))) passItems.push('来源链接有效');
  else missingFields.push('来源链接');
  // 重复文号（跨库冲突）
  if (str(rec.documentNumber)) {
    const dups = (all || []).filter(
      (x) => x.id !== rec.id && str(x.documentNumber) && str(x.documentNumber) === str(rec.documentNumber)
    );
    if (dups.length) {
      conflictItems.push(`文号与《${dups[0].title}》冲突（同库 ${dups.length} 条）`);
    } else {
      passItems.push('文号无重复');
    }
  }

  const confidence = Math.max(
    30,
    Math.min(99, 100 - missingFields.length * 10 - riskItems.filter((r) => r.level === 'high').length * 8)
  );
  return { passItems, riskItems, missingFields, conflictItems, confidenceScore: confidence };
}

function strOrEmpty(v) {
  return v === undefined || v === null ? '' : String(v);
}

// ─── 注册入口 ─────────────────────────────────────────────────────────

/**
 * @param {import('express').Express} app
 * @param {{ store: object }} ctx  store = PolicyDataStore（聚合 10 表，含 getAll/getLastSourceErrors/clearCache）
 */
function registerWriteRoutes(app, ctx) {
  const { store } = ctx;

  // ═══ feedback —— 详情页「纠错 / 提建议」════════════════════════════
  // GET /api/feedback?policyId&status&page&pageSize → IListResponse<IPolicyFeedback>
  app.get('/api/feedback', async (req, res, next) => {
    try {
      const q = req.query;
      let items = db.getDb().feedbacks;
      if (q.policyId) items = items.filter((f) => f.policyId === q.policyId);
      if (q.status) items = items.filter((f) => f.status === q.status);
      items = [...items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.json(db.paginate(items, q.page, q.pageSize));
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/feedback/:id', (req, res) => {
    const item = db.getDb().feedbacks.find((f) => f.id === req.params.id);
    if (!item) return res.status(404).json({ statusCode: 404, message: '反馈不存在', error: 'Not Found' });
    res.json(item);
  });

  // POST /api/feedback @NeedLogin  body { policyId, feedbackType?, content, pageRef? }
  app.post('/api/feedback', requireUser, async (req, res, next) => {
    try {
      const { policyId, feedbackType, content, pageRef } = req.body || {};
      if (!policyId || !strOrEmpty(content)) {
        return res.status(400).json({ statusCode: 400, message: 'policyId 与 content 必填', error: 'Bad Request' });
      }
      const all = await store.getAll();
      const target = all.find((r) => r.id === policyId || r.id.endsWith(policyId));
      if (!target) {
        return res.status(400).json({ statusCode: 400, message: '政策不存在', error: 'Bad Request' });
      }
      const item = {
        id: db.uid('fb'),
        policyId: target.id,
        feedbackType: strOrEmpty(feedbackType) || 'correction',
        content: String(content),
        status: 'pending',
        pageRef: strOrEmpty(pageRef),
        createdAt: db.nowIso(),
        createdBy: req.user.sub,
      };
      db.getDb().feedbacks.push(item);
      db.save();
      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/feedback/:id @NeedLogin  body { status?, reply? }（审核人回复，不强制状态机）
  app.patch('/api/feedback/:id', requireUser, (req, res) => {
    const item = db.getDb().feedbacks.find((f) => f.id === req.params.id);
    if (!item) return res.status(404).json({ statusCode: 404, message: '反馈不存在', error: 'Not Found' });
    const { status, reply } = req.body || {};
    if (status === undefined && reply === undefined) {
      return res.status(400).json({ statusCode: 400, message: '需提供 status 或 reply', error: 'Bad Request' });
    }
    if (status !== undefined) item.status = String(status);
    if (reply !== undefined) item.reply = String(reply);
    item.updatedAt = db.nowIso();
    item.reviewedBy = req.user.sub;
    db.save();
    res.json(item);
  });

  // ═══ reviews —— 审核中心 ════════════════════════════════════════════
  // GET /api/reviews?status&reviewType&policyId&page&pageSize
  //   → IListResponse<IPolicyReview & { policyTitle?, documentNumber? }>
  app.get('/api/reviews', async (req, res, next) => {
    try {
      const q = req.query;
      const all = await store.getAll();
      let items = db.getDb().reviews;
      if (q.status) items = items.filter((r) => r.status === q.status);
      if (q.reviewType) items = items.filter((r) => r.reviewType === q.reviewType);
      if (q.policyId) items = items.filter((r) => r.policyId === q.policyId);
      items = [...items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const pageResult = db.paginate(items, q.page, q.pageSize);
      pageResult.items = pageResult.items.map((r) => {
        const p = all.find((x) => x.id === r.policyId);
        return {
          ...r,
          policyTitle: p ? p.title : undefined,
          documentNumber: p ? p.documentNumber : undefined,
        };
      });
      res.json(pageResult);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/reviews/:id', async (req, res, next) => {
    try {
      const item = db.getDb().reviews.find((r) => r.id === req.params.id);
      if (!item) return res.status(404).json({ statusCode: 404, message: '审核单不存在', error: 'Not Found' });
      const all = await store.getAll();
      const p = all.find((x) => x.id === item.policyId);
      res.json({ ...item, policyTitle: p ? p.title : undefined, policyStatus: p ? p.effectivenessStatus : undefined });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/reviews @NeedLogin  body { policyId, versionId?, reviewType? }
  app.post('/api/reviews', requireUser, async (req, res, next) => {
    try {
      const { policyId, versionId, reviewType } = req.body || {};
      if (!policyId) {
        return res.status(400).json({ statusCode: 400, message: 'policyId 必填', error: 'Bad Request' });
      }
      const all = await store.getAll();
      const target = all.find((r) => r.id === policyId || r.id.endsWith(policyId));
      if (!target) {
        return res.status(400).json({ statusCode: 400, message: '政策不存在', error: 'Bad Request' });
      }
      const open = db.getDb().reviews.find(
        (r) => r.policyId === target.id && (r.status === 'pending' || r.status === 'reviewing')
      );
      if (open) {
        return res.status(409).json({ statusCode: 409, message: '该政策已存在审核中的审核单', error: 'Conflict' });
      }
      const machineReport = runMachineValidation(target, all);
      const item = {
        id: db.uid('rv'),
        policyId: target.id,
        versionId: versionId || null,
        reviewType: reviewType || 'first_review',
        status: 'pending',
        machineReport,
        createdAt: db.nowIso(),
        createdBy: req.user.sub,
      };
      db.getDb().reviews.push(item);
      db.save();
      res.status(201).json({ ...item, policyTitle: target.title, documentNumber: target.documentNumber });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/reviews/:id/start   pending → reviewing
  app.post('/api/reviews/:id/start', requireUser, (req, res) => {
    const item = db.getDb().reviews.find((r) => r.id === req.params.id);
    if (!item) return res.status(404).json({ statusCode: 404, message: '审核单不存在', error: 'Not Found' });
    if (item.status !== 'pending') {
      return res.status(409).json({ statusCode: 409, message: `当前状态 ${item.status} 无法开始审核`, error: 'Conflict' });
    }
    item.status = 'reviewing';
    item.startedAt = db.nowIso();
    item.reviewerId = req.user.sub;
    db.save();
    res.json(item);
  });

  // POST /api/reviews/:id/approve|reject|return  body { comment? }
  //   状态机：pending|reviewing → 终态；其余 409
  const ACTIONS = ['approve', 'reject', 'return'];
  const ACTION_STATUS = { approve: 'approved', reject: 'rejected', return: 'returned' };
  for (const action of ACTIONS) {
    app.post(`/api/reviews/:id/${action}`, requireUser, (req, res) => {
      const item = db.getDb().reviews.find((r) => r.id === req.params.id);
      if (!item) return res.status(404).json({ statusCode: 404, message: '审核单不存在', error: 'Not Found' });
      if (item.status !== 'pending' && item.status !== 'reviewing') {
        return res.status(409).json({ statusCode: 409, message: `当前状态 ${item.status} 无法执行 ${action}`, error: 'Conflict' });
      }
      const comment = (req.body && req.body.comment) || '';
      item.status = ACTION_STATUS[action];
      item.reviewResult = action;
      item.reviewerComment = String(comment);
      item.reviewedAt = db.nowIso();
      item.reviewerId = req.user.sub;
      db.save();
      res.json(item);
    });
  }

  // ═══ subscriptions —— 我的订阅（登录用户维度）══════════════════════
  app.get('/api/subscriptions', requireUser, (req, res) => {
    const mine = db
      .getDb()
      .subscriptions.filter((s) => s.userId === req.user.sub)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    res.json(mine);
  });

  app.post('/api/subscriptions', requireUser, (req, res) => {
    const { subType, subValue, subLabel, pushFrequency } = req.body || {};
    if (!subType || !subValue) {
      return res.status(400).json({ statusCode: 400, message: 'subType 与 subValue 必填', error: 'Bad Request' });
    }
    const all = db.getDb().subscriptions;
    const dup = all.find(
      (s) => s.userId === req.user.sub && s.subType === subType && s.subValue === subValue
    );
    if (dup) {
      return res.status(409).json({ statusCode: 409, message: '该订阅已存在', error: 'Conflict' });
    }
    const item = {
      id: db.uid('sub'),
      userId: req.user.sub,
      subType,
      subValue,
      subLabel: subLabel || '',
      pushFrequency: pushFrequency || 'daily',
      isActive: true,
      createdAt: db.nowIso(),
    };
    all.push(item);
    db.save();
    res.status(201).json(item);
  });

  app.patch('/api/subscriptions/:id', requireUser, (req, res) => {
    const item = db.getDb().subscriptions.find((s) => s.id === req.params.id);
    if (!item) return res.status(404).json({ statusCode: 404, message: '订阅不存在', error: 'Not Found' });
    if (item.userId !== req.user.sub) {
      return res.status(403).json({ statusCode: 403, message: '无权操作他人订阅', error: 'Forbidden' });
    }
    const { pushFrequency, isActive } = req.body || {};
    if (pushFrequency !== undefined) item.pushFrequency = String(pushFrequency);
    if (isActive !== undefined) item.isActive = Boolean(isActive);
    item.updatedAt = db.nowIso();
    db.save();
    res.json(item);
  });

  app.delete('/api/subscriptions/:id', requireUser, (req, res) => {
    const list = db.getDb().subscriptions;
    const idx = list.findIndex((s) => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ statusCode: 404, message: '订阅不存在', error: 'Not Found' });
    if (list[idx].userId !== req.user.sub) {
      return res.status(403).json({ statusCode: 403, message: '无权操作他人订阅', error: 'Forbidden' });
    }
    list.splice(idx, 1);
    db.save();
    res.json({ success: true });
  });

  // ═══ calendar —— 日历事件（真实数据，替换原空态）═══════════════════
  // GET /api/calendar/events?year&month&region&category → ICalendarEvent[]
  //   ICalendarEvent = { id: `${eventType}-${policyId}`, title: `发布：/生效：${policyTitle}`,
  //                      date: YYYY-MM-DD, eventType, policyId, policyTitle }
  app.get('/api/calendar/events', async (req, res, next) => {
    try {
      const q = req.query;
      const all = await store.getAll();
      const events = [];
      for (const r of all) {
        const reg = r.applicableRegion || r.province || '';
        const cat = r.topicCategory || '';
        if (q.region && reg !== q.region) continue;
        if (q.category && cat !== q.category) continue;
        const title = r.title || r.id;
        const pushEvent = (date, eventType) => {
          if (!isDateText(date)) return;
          if (q.year && !String(date).startsWith(String(q.year))) return;
          if (q.month) {
            const m = String(Number(q.month)).padStart(2, '0');
            if (!String(date).endsWith(`-${m}`)) return;
          }
          events.push({
            id: `${eventType}-${r.id}`,
            title: `${eventType === 'publish' ? '发布' : eventType === 'effective' ? '生效' : '失效'}：${title}`,
            date,
            eventType,
            policyId: r.id,
            policyTitle: title,
          });
        };
        // 只对「现行有效」的政策产生日历事件（语义对齐原版 status=published）
        if (!/有效|现行/.test(r.effectivenessStatus || '')) continue;
        pushEvent(r.releaseDate, 'publish');
        pushEvent(r.effectiveDate, 'effective');
      }
      events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      res.json(events.slice(0, 500));
    } catch (err) {
      next(err);
    }
  });

  // ═══ bitable —— 待同步队列补推（写权限开通后手动触发）════════════
  // GET  /api/bitable/sync-out  查看队列
  // POST /api/bitable/sync-out  尝试把 syncOutbox 中未同步写操作推到 Bitable
  app.get('/api/bitable/sync-out', requireUser, (_req, res) => {
    res.json({ count: db.getDb().syncOutbox.length, items: db.getDb().syncOutbox });
  });

  app.post('/api/bitable/sync-out', requireUser, async (req, res, next) => {
    try {
      const outbox = db.getDb().syncOutbox;
      const pending = outbox.filter((o) => !o.synced);
      const pushed = [];
      const failed = [];
      for (const op of pending) {
        try {
          if (op.kind === 'create') {
            const r = await ctx.bitable.batchCreate(op.appToken, op.tableId, [{ fields: op.fields }]);
            op.synced = true;
            op.syncedAt = db.nowIso();
            op.result = r;
            pushed.push(op.id);
          } else if (op.kind === 'update') {
            const r = await ctx.bitable.batchUpdate(op.appToken, op.tableId, [
              { record_id: op.recordId, fields: op.fields },
            ]);
            op.synced = true;
            op.syncedAt = db.nowIso();
            op.result = r;
            pushed.push(op.id);
          }
        } catch (err) {
          op.lastError = err.message;
          failed.push({ id: op.id, error: err.message });
        }
      }
      db.save();
      res.json({ pushed, failed, remaining: outbox.filter((o) => !o.synced).length });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerWriteRoutes, runMachineValidation };
