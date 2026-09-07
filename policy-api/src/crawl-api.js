'use strict';

/**
 * crawl-api.js —— P3 采集确认链路（1:1 对齐原版 modules/policy-crawl 契约形态）
 *
 * 背景：原版 crawl 读取「飞书爬虫汇总表」（CulNbDPMkaiuiNs10u8cY6Uenbd）做比对/确认，
 *       该 Base 对自建应用凭证返回 403（未授权）。因此自建版把「采集汇总池」落到
 *       本地 db.json 的 crawlQueue（由 policy-crawler / seed 脚本 / 手动录入填充），
 *       接口语义与原版一致：
 *   GET  /api/crawl/crawled-pending          待确认清单 + stats{new,exists,needs_update}
 *   POST /api/crawl/confirm    {recordId}    确认 → 映射进目标专题表（真实 batchCreate；
 *                                             403 无写权限时自动降级进 syncOutbox 待同步）
 *   POST /api/crawl/ai-extract {recordId}    AI 元数据提取 + 与当前字段逐项比对
 *   POST /api/crawl/ai-apply   {recordId, updates}  采纳 AI 建议回写条目
 *   POST /api/crawl/compare    {keyword, region}    采集前查重（关键词+地区在存量库内匹配）
 */

const db = require('../../src/db');
const llm = require('../../src/llm');
const { requireUser } = require('./auth');
const { POLICY_SOURCES } = require('./policy-sources');
const { msToDateText } = require('../../src/bitable');
const { judge } = require('./quality-gate');

// ─── 目标表字段工具（与 buildWriteFields 的列类型判定同源）──────────────
const FIELDS_TTL_MS = 5 * 60 * 1000;
const _fieldsCache = new Map(); // tableId -> { at: number, fields: [] }

async function getFieldsCached(bitable, appToken, tableId) {
  const hit = _fieldsCache.get(tableId);
  if (hit && Date.now() - hit.at < FIELDS_TTL_MS) return hit.fields;
  const fields = await bitable.listFields(appToken, tableId);
  _fieldsCache.set(tableId, { at: Date.now(), fields });
  return fields;
}

function colKind(f) {
  const t = f.type;
  const u = String(f.ui_type || '');
  if (t === 5 || /date/i.test(u)) return 'date';
  if (t === 2 || /number/i.test(u)) return 'number';
  if (t === 15 || /^(url|link)/i.test(u)) return 'url';
  if (t === 3 || /singleselect/i.test(u)) return 'select';
  if (t === 4 || /multiselect/i.test(u)) return 'multiselect';
  if (t === 1 || /text/i.test(u)) return 'text';
  return 'text';
}
const colIsDate = (f) => colKind(f) === 'date';
const colIsNum = (f) => colKind(f) === 'number';
const colIsUrl = (f) => colKind(f) === 'url';
const colIsSelect = (f) => colKind(f) === 'select';

/** 单元格候选值 → 可展示文本（日期 ms 转 YYYY-MM-DD，链接对象取 link/text） */
function cellToPreview(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') {
    if (v > 10_000_000_000 && v < 4_000_000_000_000) return msToDateText(v);
    return String(v);
  }
  if (typeof v === 'object') {
    if (Array.isArray(v)) return v.map(cellToPreview).filter(Boolean).join(', ');
    return cellToPreview(v.text ?? v.name ?? v.link ?? v.url ?? v.value ?? '');
  }
  return String(v);
}

/**
 * 把用户提交的 updates（目标表中文列名 → 值）规范化为 batchCreate 可写值。
 * 返回 {} 表示无可写覆盖；返回 null 表示遇到非法类型（由调用方丢弃该列）。
 */
function normalizeUpdates(fields, updates) {
  const out = {};
  for (const [name, raw] of Object.entries(updates || {})) {
    const f = (fields || []).find((x) => x.name === name);
    if (!f) continue;
    if (raw === null || raw === undefined || raw === '') continue;
    const v = typeof raw === 'object' && raw !== null && 'value' in raw ? raw.value : raw;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (colIsDate(f)) {
      const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (!m) continue;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2050) continue;
      out[name] = d.getTime();
    } else if (colIsNum(f)) {
      const n = Number(String(v).replace(/[^\d.\-]/g, ''));
      if (!Number.isFinite(n) || n <= 0 || n > 2_000_000) continue;
      out[name] = n;
    } else if (colIsUrl(f)) {
      const link = String(v).trim();
      if (!/^https?:\/\//i.test(link)) continue;
      out[name] = { text: link, link };
    } else {
      out[name] = String(v).slice(0, 500);
    }
  }
  return out;
}

// ─── 矩阵巡检任务（子进程跑 scripts/sweep-crawl.js，审批台一键触发 + 轮询）────────
const { execFile } = require('child_process');
const pathMod = require('path');
const SWEEP_SCRIPT = pathMod.join(__dirname, '..', '..', 'scripts', 'sweep-crawl.js');
const _matrixRuns = new Map(); // runId -> { id, state, log[], result, startedAt, endedAt }
const MATRIX_LOG_KEEP = 200;

/** 启动一次矩阵巡检子进程。调用方需保证同一时间只有一个 running（db.json 整文件写盘的竞争约束）。 */
function spawnMatrixRun({ limit = 15, region = '', category = '', all = false } = {}) {
  const runId = db.uid('mx');
  const entry = { id: runId, state: 'running', log: [], result: null, startedAt: db.nowIso(), endedAt: '' };
  const args = [SWEEP_SCRIPT, 'run'];
  if (all) args.push('--all');
  else {
    args.push('--limit', String(limit));
    if (region) args.push('--region', region);
    if (category) args.push('--category', category);
  }
  const push = (chunk) => {
    const lines = String(chunk || '')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l && !l.includes('__RESULT__'));
    entry.log.push(...lines);
    if (entry.log.length > MATRIX_LOG_KEEP) entry.log = entry.log.slice(-MATRIX_LOG_KEEP);
  };
  const child = execFile(
    process.execPath,
    args,
    { cwd: pathMod.join(__dirname, '..', '..'), timeout: 0, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      // 子进程整文件落盘后，丢弃本进程旧快照重读，避免下次 save 覆盖子进程写入
      try { db.reload(); } catch (_) {}
      entry.endedAt = db.nowIso();
      const marker = String(stdout || '').lastIndexOf('__RESULT__');
      if (marker !== -1) {
        try {
          entry.result = JSON.parse(String(stdout).slice(marker + '__RESULT__'.length));
          entry.state = 'done';
        } catch (_) {
          entry.result = { ok: false, error: '巡检结果 JSON 解析失败' };
          entry.state = 'error';
        }
      } else {
        entry.state = err ? 'error' : 'done';
        entry.result = { ok: !err, error: err ? err.message : '子进程未返回结果标记' };
      }
      _matrixRuns.set(runId, entry);
      if (stderr) console.error(`[matrix-run ${runId}] stderr: ${String(stderr).slice(0, 500)}`);
    },
  );
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  _matrixRuns.set(runId, entry);
  // 只保留最近 20 个历史任务（轮询窗口之外自然淘汰）
  if (_matrixRuns.size > 20) {
    for (const k of [..._matrixRuns.keys()].slice(0, _matrixRuns.size - 20)) _matrixRuns.delete(k);
  }
  console.log(`[matrix-run ${runId}] 启动: node scripts/sweep-crawl.js ${args.join(' ')}`);
  return runId;
}

// ─── 类别对齐：文本 → POLICY_SOURCES 10 类 ────────────────────────────
const CATEGORY_KEYWORDS = [
  ['最低工资', ['最低工资', '月最低']],
  ['平均工资', ['平均工资', '社平工资', '全口径']],
  ['公积金', ['公积金', '住房公积金', '缴存基数']],
  ['年金', ['年金']],
  ['大病医疗', ['大病医疗', '职工大病医保', '大病互助', '大病保险', '补充医保']],
  ['高温津贴', ['高温津贴', '防暑降温']],
  ['残疾职工', ['残疾职工', '残疾人就业', '残保金', '残疾人就业保障金', '按比例安排残疾人就业']],
  ['婚育相关', ['产假', '陪产假', '育儿假', '婚假', '生育津贴']],
  ['病假工资', ['病假', '医疗期工资']],
  ['薪酬月刊', ['薪酬月刊']],
];
function classifyCategory(text) {
  const t = String(text || '');
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    for (const kw of kws) if (t.includes(kw)) return cat;
  }
  return '';
}

function pickText(fields, nameRe) {
  if (!fields) return '';
  for (const [k, v] of Object.entries(fields)) {
    if (nameRe.test(k)) {
      const t = Array.isArray(v)
        ? v.map((x) => (typeof x === 'object' ? x.text || x.name || x.link || '' : x)).join(' ')
        : typeof v === 'object' && v !== null
        ? v.text || v.name || v.link || ''
        : String(v);
      if (t && t.trim()) return String(t).trim();
    }
  }
  return '';
}

/** 从一条原始汇总记录（fields 中文列名）构造 crawl 项统一结构 */
function normalizeRaw(rawFields, recordId) {
  const title = pickText(rawFields, /标题|政策名|名称|题目|title/i) || '';
  const content = pickText(rawFields, /正文|内容|概述|全文|原文|摘要/i) || '';
  const url = pickText(rawFields, /来源链接|链接|url|网址/i) || '';
  const region = pickText(rawFields, /地区|省份|地域|区域/i) || '';
  const docNumber = pickText(rawFields, /文号|发文字号/i) || '';
  const org = pickText(rawFields, /发文机关|发布机关|发布单位|authority/i) || '';
  const releaseDate = pickText(rawFields, /发布日期|发文日期|发布时间|日期/i) || '';
  return { title, content, url, region, docNumber, org, releaseDate };
}

/** 判断条目在存量库里的匹配状态：new / exists / needs_update */
function matchStatus(item, all) {
  const doc = (item.documentNumber || '').trim();
  for (const p of all) {
    // 文号精确匹配（最高优先级）
    if (doc && p.documentNumber && String(p.documentNumber).trim() === doc) {
      return p.id === item.sourcePolicyId ? 'exists' : 'needs_update';
    }
  }
  // 标题 + 地区双重匹配（避免同地区不同政策误判）
  const itemRegion = (item.region || '').trim();
  for (const p of all) {
    if (!item.title || !p.title) continue;
    const pRegion = (p.province || p.applicableRegion || '').trim();
    // 地区不同直接跳过
    if (itemRegion && pRegion && !pRegion.includes(itemRegion) && !itemRegion.includes(pRegion)) continue;
    // 相似度阈值提高到 0.95（中文 bigram 共享度高，0.9 太松）
    if (llm.similarity(item.title, p.title) > 0.95) {
      return p.id === item.sourcePolicyId ? 'exists' : 'needs_update';
    }
  }
  return 'new';
}

/** 目标表字段写入映射：中文列名 → 值（日期转毫秒、数值转 number、超链接对象化） */
function dateTextToMs(v) {
  if (typeof v !== 'string') return v;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return v;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? v : d.getTime();
}
function buildWriteFields(targetFields, item) {
  const fields = {};
  const isDateCol = (f) => f.type === 5 || /date/i.test(f.ui_type || '');
  const isNumCol = (f) => f.type === 2 || /number/i.test(f.ui_type || '');
  const isUrlCol = (f) => f.type === 15 || /^(url|link)/i.test(f.ui_type || '');
  const isSelect = (f) => f.type === 3 || /singleselect/i.test(f.ui_type || '');
  const set = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    fields[name] = value;
  };
  for (const f of targetFields) {
    const n = f.name;
    const titleRe = /标题|政策名|名称|题目|^title$/i;
    const contentRe = /正文|内容|详情|概述|全文|原文/i;
    if (titleRe.test(n)) set(n, item.title);
    else if (contentRe.test(n)) set(n, item.content || item.summary);
    else if (/文号|发文字号/i.test(n)) set(n, item.documentNumber);
    else if (/发文机关|发布机关|发布单位|authority/i.test(n)) set(n, item.org);
    else if (/城市/i.test(n)) set(n, item.region);
    else if (/生效日期|施行日期|生效月/i.test(n)) set(n, isDateCol(f) ? dateTextToMs(item.effectiveDate || item.releaseDate) : item.effectiveDate || item.releaseDate);
    else if (/发布日期|发文日期|发布时间|日期/i.test(n)) set(n, isDateCol(f) ? dateTextToMs(item.releaseDate || item.effectiveDate) : item.releaseDate || item.effectiveDate);
    else if (/效力状态|状态|有效性/i.test(n)) set(n, '现行有效');
    else if (/来源链接|链接|^url$|数据来源/i.test(n)) set(n, isUrlCol(f) && item.url ? { text: item.title || item.url, link: item.url } : item.url);
  }
  // 数值列（剩余列名含金额/标准类关键词时）——如确认数据里带数值才写
  for (const f of targetFields) {
    if (fields[f.name] !== undefined) continue;
    if (isNumCol(f) && /金额|标准|上限|下限|比例|基数|免税|扣除|津贴|工资|天数/.test(f.name)) {
      const v = item.values && item.values[f.name];
      if (v !== undefined && v !== null && v !== '') {
        const num = Number(String(v).replace(/[^\d.-]/g, ''));
        if (Number.isFinite(num)) fields[f.name] = num;
      }
    }
  }
  // 地区（必须存在于各表：地区/省份列）
  for (const f of targetFields) {
    if (fields[f.name] !== undefined) continue;
    if (/地区|省份|地域|区域|province/i.test(f.name)) {
      set(f.name, isSelect(f) ? String(item.region || '') : item.region);
    }
  }
  // ---- 入库前三道闸（防脏数据写入多维表格） ----
  const DATE_MIN_MS = Date.UTC(2000, 0, 1);
  const DATE_MAX_MS = Date.UTC(2050, 0, 1);
  const MONEY_MAX = 2_000_000;

  for (const f of targetFields) {
    const v = fields[f.name];
    if (v === undefined || v === null || v === '') continue;

    // 日期闸：ms 值必须在 2000-2050 区间
    if (isDateCol(f) && typeof v === 'number') {
      if (v < DATE_MIN_MS || v > DATE_MAX_MS) {
        delete fields[f.name]; // 越界日期清除，不写入
      }
    }

    // 金额闸：数值必须在 0-200万 区间
    if (isNumCol(f) && typeof v === 'number') {
      if (v <= 0 || v > MONEY_MAX) {
        delete fields[f.name]; // 异常金额清除，不写入
      }
    }

    // 链接闸：URL 字段必须是 http(s) 开头
    if (isUrlCol(f) && typeof v === 'object' && v.link) {
      if (!/^https?:\/\//i.test(v.link)) {
        delete fields[f.name]; // 非法链接清除
      }
    }
  }

  return fields;
}

/**
 * @param {import('express').Express} app
 * @param {{ store: object, bitable: object }} ctx
 */
function registerCrawlRoutes(app, ctx) {
  const { store, bitable } = ctx;

  const crawlList = () => db.getDb().crawlQueue;

  // GET /api/crawl/crawled-pending → 待确认清单 + stats{new,exists,needs_update}
  // 响应形状 1:1 对齐原版 shared/api.interface.ts 的 ICrawlResult：
  // 前端 BitableDisplayPage 依赖 comparisonResult / bitableRecordId / province / city /
  // summary / officialUrl / policyDomain / amount / effectiveDate 等字段渲染与按钮 gating。
  app.get('/api/crawl/crawled-pending', async (req, res, next) => {
    try {
      const all = await store.getAll();
      const stats = { new: 0, exists: 0, needs_update: 0, suspect: 0 };
      const items = crawlList()
        .filter((c) => !['confirmed', 'pending_sync', 'ignored'].includes(c.status))
        .map((c) => {
          const st = matchStatus(c, all);
          stats[st] += 1;
          // quality：新记录已带标记；存量（无标记）实时补算一次，不落库
          let quality = c.quality;
          let qualityReasons = c.qualityReasons || [];
          if (!quality) {
            const g = judge({
              title: c.title,
              url: c.url || '',
              category: c.category,
              summary: c.summary || '',
              content: c.content || '',
              valuesSuggest: c.valuesSuggest || [],
            });
            quality = g.level;
            qualityReasons = g.reasons;
          }
          if (quality === 'suspect') stats.suspect += 1;
          const region = c.region || '';
          const officialUrl = c.url || (/^https?:\/\//.test(c.documentNumber || '') ? c.documentNumber : '');
          return {
            province: region,
            city: '',
            title: c.title || '',
            summary: c.summary || c.content || '',
            publishDate: c.releaseDate || '',
            officialUrl,
            source: c.org || c.source || 'manual',
            policyDomain: c.category || classifyCategory(`${c.title}${c.content}`) || '',
            comparisonResult: st,
            bitableRecordId: c.id,
            matchedTitle: c.similarPolicy ? c.similarPolicy.title || '' : '',
            sourcePriority: c.org ? '官网正式文件' : '转载来源',
            sourcePriorityRank: c.org ? 1 : 4,
            amount: c.amount || '',
            highStandard: c.highStandard || '',
            effectiveDate: c.effectiveDate || '',
            expirationDate: c.expirationDate || '',
            includeSocialInsurance: c.includeSocialInsurance || '',
            includeHousingFund: c.includeHousingFund || '',
            sourceUrl1: officialUrl,
            sourceUrl2: '',
            sourceUrl3: '',
            exclusions: '',
            reviewNote: c.note || '',
            validity: '现行有效',
            quality,
            qualityReasons,
          };
        });
      res.json({ items, total: items.length, stats });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/crawl/tables → 10 张专题表结构（列名+类型），供审批台渲染表头预览
  app.get('/api/crawl/tables', requireUser, async (req, res, next) => {
    try {
      const tables = await Promise.all(
        POLICY_SOURCES.map(async (s) => {
          let fields = [];
          try {
            fields = (await getFieldsCached(bitable, s.appToken, s.tableId)).map((f) => ({
              name: f.name,
              type: f.type,
              kind: colKind(f),
            }));
          } catch (err) {
            fields = [];
          }
          return { category: s.category, label: s.label, tableId: s.tableId, appToken: s.appToken, viewId: s.viewId, fields };
        }),
      );
      res.json({ tables });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/crawl/matrix-status → 矩阵巡检任务队列概览（审批台「一键巡检」区渲染）
  app.get('/api/crawl/matrix-status', requireUser, (req, res) => {
    const tasks = db.getDb().crawlTasks || [];
    const done = tasks.filter((t) => t.status === 'done').length;
    const errs = tasks.filter((t) => t.status === 'error');
    const queue = db.getDb().crawlQueue || [];
    const running = [..._matrixRuns.values()].filter((r) => r.state === 'running');
    res.json({
      total: tasks.length,
      done,
      error: errs.length,
      remaining: tasks.length - done,
      recentErrors: errs.slice(-5).map((t) => ({ id: t.id, error: t.error, lastRun: t.lastRun })),
      queue: {
        pending: queue.filter((c) => c.status !== 'confirmed' && c.status !== 'pending_sync').length,
        total: queue.length,
      },
      outboxPending: (db.getDb().syncOutbox || []).filter((o) => !o.synced).length,
      llmEnabled: llm.llmEnabled(),
      running: running.map((r) => r.id),
    });
  });

  // POST /api/crawl/matrix-run {limit?, region?, category?, all?} → 触发一批矩阵巡检（异步子进程）
  app.post('/api/crawl/matrix-run', requireUser, (req, res) => {
    const running = [..._matrixRuns.values()].find((r) => r.state === 'running');
    if (running) {
      return res.status(409).json({ statusCode: 409, message: `已有巡检任务 ${running.id} 运行中，请等待完成后再触发`, error: 'Conflict' });
    }
    const { limit, region, category, all } = req.body || {};
    let lmt = parseInt(limit, 10);
    lmt = Number.isFinite(lmt) && lmt > 0 ? Math.min(lmt, 99999) : 15;
    const runId = spawnMatrixRun({
      limit: lmt,
      region: String(region || '').trim(),
      category: String(category || '').trim(),
      all: !!all,
    });
    res.json({ success: true, runId, message: '矩阵巡检已启动（独立子进程，完成后自动并入待确认池）' });
  });

  // GET /api/crawl/matrix-run/:id → 轮询巡检任务状态/日志/结果
  app.get('/api/crawl/matrix-run/:id', requireUser, (req, res) => {
    const run = _matrixRuns.get(req.params.id);
    if (!run) return res.status(404).json({ statusCode: 404, message: '巡检任务不存在或已过期', error: 'Not Found' });
    res.json({
      id: run.id,
      state: run.state,
      log: run.log.slice(-120),
      result: run.result,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });
  });

  // POST /api/crawl/table-preview {recordId} → 目标表「整行预览」：每列当前将写入值 +
  // AI/规则建议值 + 依据，1:1 对齐多维表格列。历史条目无 valuesSuggest 时现场生成并持久化。
  app.post('/api/crawl/table-preview', requireUser, async (req, res, next) => {
    try {
      const { recordId } = req.body || {};
      const item = crawlList().find((c) => c.id === recordId);
      if (!item) return res.status(404).json({ statusCode: 404, message: '采集条目不存在', error: 'Not Found' });
      const category =
        (item.category && POLICY_SOURCES.some((s) => s.category === item.category) ? item.category : '') ||
        classifyCategory(`${item.title || ''}${item.content || ''}${item.region || ''}`) ||
        item.category;
      const src = POLICY_SOURCES.find((s) => s.category === category);
      if (!src) {
        return res.status(400).json({ statusCode: 400, message: `无法判定目标专题表（10 类：${POLICY_SOURCES.map((s) => s.category).join('/')}）`, error: 'Bad Request' });
      }
      const targetFields = await getFieldsCached(bitable, src.appToken, src.tableId);

      // 历史条目（无 valuesSuggest）→ 现场生成候选并持久化
      if (!Array.isArray(item.valuesSuggest) || !item.valuesSuggest.length) {
        const cols = [
          ...(src.valueFields || []).map((n) => ({ name: n, kind: 'number' })),
          ...(src.dateFields || []).map((n) => ({ name: n, kind: 'date' })),
        ];
        if (cols.length) {
          const suggs = await llm.suggestTableValues(`${item.title || ''}\n${(item.content || '').slice(0, 2500)}`, cols);
          if (suggs.length) {
            item.valuesSuggest = suggs;
            const vmap = {};
            for (const s of suggs) {
              if (!s || s.value === '' || s.value === undefined) continue;
              let ok = true;
              let finalVal = s.value;
              if (s.colType === 'date') ok = /^20\d{2}-\d{2}-\d{2}$/.test(String(s.value));
              else if (s.colType === 'number' && s.unit === '%') {
                const n = parseFloat(String(s.value).replace(/[^\d.]/g, ''));
                ok = Number.isFinite(n) && n >= 0 && n <= 100;
                if (ok) finalVal = n;
              } else if (s.colType === 'number') {
                const n = parseFloat(String(s.value).replace(/[^\d.]/g, ''));
                ok = Number.isFinite(n) && n >= 0 && n <= 2000000;
                if (ok) finalVal = n;
              }
              if (ok && vmap[s.col] === undefined) vmap[s.col] = finalVal;
            }
            item.values = vmap;
            db.save();
          }
        }
      }

      // 建议列名 → 目标表列 模糊对齐（列名含别名场景）
      const aligned = new Map();
      for (const s of item.valuesSuggest || []) {
        const hit =
          targetFields.find((f) => f.name === s.col) ||
          targetFields.find((f) => s.col && (s.col.includes(f.name) || (f.name.length >= 2 && f.name.includes(s.col))));
        if (hit && !aligned.has(hit.name)) aligned.set(hit.name, s);
      }

      const baseFields = buildWriteFields(targetFields, item);
      const rows = targetFields
        .filter((f) => f && f.name && !/^(记录ID|record|创建时间|更新时间)/i.test(f.name))
        .map((f) => {
          const kind = colKind(f);
          const current = cellToPreview(baseFields[f.name]);
          const sug = aligned.get(f.name);
          let suggest = '';
          let engine = '';
          let confidence = 0;
          let evidence = '';
          if (sug && sug.value !== undefined && String(sug.value) !== '') {
            suggest = kind === 'date' ? String(sug.value) : `${sug.value}${sug.unit ? ' ' + sug.unit : ''}`;
            if (suggest === current) suggest = '';
            engine = sug.engine || '';
            confidence = sug.confidence || 0;
            evidence = (sug.evidence || '').slice(0, 120);
          }
          return {
            col: f.name,
            kind,
            current,
            suggest,
            engine,
            confidence,
            evidence,
            editable: kind !== 'multiselect' && kind !== 'url',
          };
        });
      const writeFields = buildWriteFields(targetFields, item);
      res.json({
        category,
        label: src.label,
        tableId: src.tableId,
        appToken: src.appToken,
        viewId: src.viewId,
        rows,
        willWriteCount: Object.keys(writeFields).length,
        hasSuggest: rows.some((r) => r.suggest),
        llmEnabled: llm.llmEnabled(),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/crawl/ai-extract {recordId} → AI 元数据提取 + 逐项比对
  app.post('/api/crawl/ai-extract', requireUser, async (req, res, next) => {
    try {
      const { recordId } = req.body || {};
      const item = crawlList().find((c) => c.id === recordId);
      if (!item) return res.status(404).json({ statusCode: 404, message: '采集条目不存在', error: 'Not Found' });
      // 基础：本地正则启发式提取（离线兜底）
      let ex = llm.aiExtractFromText(`${item.title || ''}\n${item.content || ''}`);
      // 进阶：LLM 配置后改由真大模型做语义级提取（正则抓不到的文号/机关/生效日期/
      // 金额/省份，AI 可据正文语义补全；关键数值仍以 diff 形式呈现给人确认，不自动写入）
      if (llm.llmEnabled()) {
        const ai = await llm.aiExtractCrawl(`${item.title || ''}\n${(item.content || '').slice(0, 2500)}`).catch(() => null);
        if (ai && typeof ai === 'object') {
          ex = {
            title: ai.title && String(ai.title).length <= 80 ? String(ai.title) : ex.title,
            documentNumber: /〔\d{4}〕/.test(String(ai.documentNumber || '')) ? String(ai.documentNumber).trim() : ex.documentNumber,
            org: String(ai.org || '').slice(0, 40) || ex.org,
            releaseDate: /^20\d{2}-\d{2}-\d{2}/.test(String(ai.releaseDate || '')) ? String(ai.releaseDate).slice(0, 10) : ex.releaseDate,
            category: ex.category || ai.category || '',
            summary: String(ai.summary || '').slice(0, 150) || ex.summary,
            amount: String(ai.amount || '').trim() || '',
            effectiveDate: /^20\d{2}-\d{2}-\d{2}/.test(String(ai.effectiveDate || '')) ? String(ai.effectiveDate).slice(0, 10) : '',
            province: String(ai.province || '').trim(),
            confidence: ex.confidence,
          };
        }
      }
      const aiCategory = classifyCategory(`${ex.title}${ex.category}${item.content || ''}`) || (ex.category && classifyCategory(ex.category)) || '';
      const diff = (key, label, current, aiValue) => {
        const cur = String(current || '').trim();
        const ai = String(aiValue || '').trim();
        let status = 'match';
        if (!ai && cur) status = 'ai_missing';
        else if (ai && !cur) status = 'current_missing';
        else if (cur !== ai) status = 'diff';
        return { key, label, current: cur, aiValue: ai, status };
      };
      const fields = [
        diff('title', '标题', item.title, ex.title),
        diff('documentNumber', '文号', item.documentNumber, ex.documentNumber),
        diff('org', '发文机关', item.org, ex.org),
        diff('releaseDate', '发布日期', item.releaseDate, ex.releaseDate),
        diff('effectiveDate', '生效日期', item.effectiveDate, ex.effectiveDate || item.effectiveDate),
        diff('amount', '金额标准', item.amount, ex.amount || item.amount),
        diff('province', '适用省份', item.region || '', ex.province || item.region || ''),
        diff('category', '政策类别', item.category, aiCategory || ex.category),
        diff('summary', '摘要', item.summary, ex.summary),
      ];
      res.json({
        recordId: item.id,
        sourceText: `${item.title || ''}${item.content ? '\n' + item.content.slice(0, 2000) : ''}`,
        categories: [aiCategory || ex.category].filter(Boolean),
        fields,
        confidence: ex.confidence,
        engine: llm.llmEnabled() ? 'remote-llm' : 'local-rules',
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/crawl/ai-apply {recordId, updates} → 采纳 AI 建议写回条目
  app.post('/api/crawl/ai-apply', requireUser, (req, res) => {
    const { recordId, updates } = req.body || {};
    const item = crawlList().find((c) => c.id === recordId);
    if (!item) return res.status(404).json({ statusCode: 404, message: '采集条目不存在', error: 'Not Found' });
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ statusCode: 400, message: 'updates 必填', error: 'Bad Request' });
    }
    const FIELD_MAP = {
      title: 'title',
      documentNumber: 'documentNumber',
      org: 'org',
      releaseDate: 'releaseDate',
      effectiveDate: 'effectiveDate',
      amount: 'amount',
      province: 'region',
      category: 'category',
      summary: 'summary',
      region: 'region',
    };
    for (const [k, v] of Object.entries(updates)) {
      const target = FIELD_MAP[k] || k;
      item[target] = v;
    }
    item.updatedAt = db.nowIso();
    item.aiAdopted = true;
    db.save();
    res.json({ success: true, message: 'AI 建议已采纳，条目已更新', item });
  });

  // POST /api/crawl/confirm {recordId} → 确认入库：映射进目标专题表
  app.post('/api/crawl/confirm', requireUser, async (req, res, next) => {
    try {
      const { recordId } = req.body || {};
      const item = crawlList().find((c) => c.id === recordId);
      if (!item) return res.status(404).json({ statusCode: 404, message: '采集条目不存在', error: 'Not Found' });
      const category =
        (item.category && POLICY_SOURCES.some((s) => s.category === item.category) ? item.category : '') ||
        classifyCategory(`${item.title}${item.content}${item.region}`);
      const src = POLICY_SOURCES.find((s) => s.category === category);
      if (!src) {
        return res.status(400).json({
          statusCode: 400,
          message: `无法判定该条目属于哪个专题表（10 类：${POLICY_SOURCES.map((s) => s.category).join('/')}）`,
          error: 'Bad Request',
        });
      }
      const targetFields = await bitable.listFields(src.appToken, src.tableId);
      const fields = buildWriteFields(targetFields, item);
      // 用户改过的单元格（updates: {目标表列名: 值}）规范化后覆盖默认映射，实现「整行写入」
      const overrides = normalizeUpdates(targetFields, (req.body || {}).updates);
      Object.assign(fields, overrides);
      if (!Object.keys(fields).length) {
        return res.status(400).json({ statusCode: 400, message: '未能映射出任何可写字段', error: 'Bad Request' });
      }
      try {
        const result = await bitable.batchCreate(src.appToken, src.tableId, [{ fields }]);
        item.status = 'confirmed';
        item.targetCategory = category;
        item.targetTableId = src.tableId;
        item.confirmedAt = db.nowIso();
        item.confirmedBy = req.user.sub;
        item.writeResult = result;
        db.save();
        res.json({
          success: true,
          category,
          targetTableId: src.tableId,
          message: `已写入「${category}」专题表（${result.created} 条）`,
          created: result.created,
        });
      } catch (err) {
        // 无写权限（403 等）→ 降级进本地待同步队列，权限开通后 POST /api/bitable/sync-out 补推
        const isPermission = /403|Forbidden|无权限|91403/.test(err.message);
        const outboxItem = {
          id: db.uid('sync'),
          kind: 'create',
          appToken: src.appToken,
          tableId: src.tableId,
          fields,
          sourceItemId: item.id,
          category,
          synced: false,
          createdAt: db.nowIso(),
          lastError: err.message,
        };
        db.getDb().syncOutbox.push(outboxItem);
        item.status = 'pending_sync';
        item.targetCategory = category;
        item.targetTableId = src.tableId;
        item.outboxId = outboxItem.id;
        item.lastError = err.message;
        db.save();
        res.status(201).json({
          success: true,
          category,
          targetTableId: src.tableId,
          pendingSync: true,
          outboxId: outboxItem.id,
          message: isPermission
            ? `已加入本地待同步队列（当前凭证对「${category}」表无写权限）。开通表格写权限后调 POST /api/bitable/sync-out 即可真实写入。`
            : `写入失败，已暂存本地待同步队列：${err.message}`,
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /api/crawl/ignore {recordId} → 标记忽略（移出待办列表，不写库；误标后可在 db.json 改回 pending）
  app.post('/api/crawl/ignore', requireUser, (req, res) => {
    const { recordId } = req.body || {};
    const item = crawlList().find((c) => c.id === recordId);
    if (!item) return res.status(404).json({ statusCode: 404, message: '采集条目不存在', error: 'Not Found' });
    item.status = 'ignored';
    item.ignoredAt = db.nowIso();
    item.ignoredBy = req.user.sub;
    db.save();
    res.json({ success: true, message: '已忽略该条目（移出待办列表）', recordId });
  });

  // POST /api/crawl/compare {keyword, region} → 真爬虫在线采集：搜索发现 → 抓原文 →
  // 10类白名单过滤 → 写入待确认池（url去重）→ 与正式库比对返回 ICrawlResult 结构
  app.post('/api/crawl/compare', async (req, res, next) => {
    try {
      const { keyword, region } = req.body || {};
      if (!keyword || !region) {
        return res.status(400).json({ statusCode: 400, message: 'keyword 与 region 必填', error: 'Bad Request' });
      }
      // 以独立子进程执行真实采集：搜索引擎对本进程（长驻服务器）的连续请求会
      // 降级返回垃圾结果，对一次性新进程正常（实测：本进程 0 条 vs 子进程 5 条）
      const { execFile } = require('child_process');
      const scriptPath = require('path').join(__dirname, '..', '..', 'scripts', 'crawl-once.js');
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [scriptPath, String(keyword), String(region)],
          { cwd: require('path').join(__dirname, '..', '..'), timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
          (err, out) => (err && !out ? reject(err) : resolve({ stdout: out || '' })),
        );
      });
      const marker = stdout.lastIndexOf('__RESULT__');
      if (marker === -1) throw new Error('采集进程未返回结果');
      const parsed = JSON.parse(stdout.slice(marker + '__RESULT__'.length));
      const crawled = parsed.items || [];

      // 写入待确认池（按 url 去重），页面「第二步·核对并确认入库」可见
      const list = crawlList();
      let added = 0;
      for (const item of crawled) {
        if (!list.some((c) => c.url && c.url === item.url)) {
          list.push(item);
          added += 1;
        }
      }
      if (added > 0) db.save();

      // 与正式库比对，按 ICrawlResult 结构返回（前端实时比对结果表格）
      const all = await store.getAll();

      // 可选 AI 语义查重：LLM 配置后，用语义级判断覆盖纯文本阈值匹配（文号缺失、
      // 标题措辞不同但实为同一政策时，规则阈值 0.95 会漏判，交给模型语义判定）
      let aiVerdicts = null;
      if (llm.llmEnabled() && all.length && crawled.length) {
        aiVerdicts = await llm.aiDedupCandidates(crawled, all).catch(() => null);
      }
      const aiByTitle = new Map((aiVerdicts || []).map((v) => [v.title, v]));

      const items = crawled.map((c) => {
        let st = matchStatus(c, all);
        const aiV = aiByTitle.get(c.title || '');
        if (aiV) st = aiV.status;
        return {
          province: c.region || '',
          city: '',
          title: c.title || '',
          summary: c.summary || c.content || '',
          publishDate: c.releaseDate || '',
          officialUrl: c.url || '',
          source: c.org || c.source || 'online-crawler',
          policyDomain: c.category || '',
          comparisonResult: st,
          bitableRecordId: c.id,
          matchedTitle: aiV ? aiV.matchedTitle || '' : '',
          aiReason: aiV ? aiV.reason || '' : '',
          sourcePriority: c.org ? '官网正式文件' : '转载来源',
          sourcePriorityRank: c.org ? 1 : 4,
          amount: c.amount || '',
          effectiveDate: c.effectiveDate || '',
        };
      });
      const stats = { new: 0, exists: 0, needs_update: 0 };
      for (const it of items) stats[it.comparisonResult] += 1;
      res.json({ items, total: items.length, stats, addedToQueue: added, aiEnabled: !!aiVerdicts });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerCrawlRoutes, classifyCategory, buildWriteFields, matchStatus };
