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
const {
  REGIONS, CATEGORY_KEYWORDS: MATRIX_CATEGORY_KEYWORDS, PROVINCES, REGION_BATCHES,
  batchById, regionsForBatch,
} = require('./crawl-regions');
const { normalizeCrawlMode, normalizePublishedDate, shanghaiDate, summarizeTasks, taskState } = require('./crawl-mode');
const { classifyBitableFailure } = require('./bitable-failure');
const { evaluateSourceHealth, buildCompensationPlan, recoverExpiredCompensations } = require('./source-health');
const { canonicalizeUrl } = require('./url-utils');

// ─── 目标表字段工具（与 buildWriteFields 的列类型判定同源）──────────────
const FIELDS_TTL_MS = 5 * 60 * 1000;
const _fieldsCache = new Map(); // tableId -> { at: number, fields: [] }

async function getFieldsCached(bitable, appToken, tableId) {
  const hit = _fieldsCache.get(tableId);
  if (hit && Date.now() - hit.at < FIELDS_TTL_MS) return hit.fields;
  try {
    const fields = await bitable.listFields(appToken, tableId);
    _fieldsCache.set(tableId, { at: Date.now(), fields });
    return fields;
  } catch (err) {
    // 飞书瞬时网络故障时优先使用最近一次成功字段缓存，避免整条预览不可用。
    if (hit && Array.isArray(hit.fields) && hit.fields.length) {
      console.warn(`[crawl-api] listFields failed for ${tableId}; using stale cache: ${err.message || err}`);
      return hit.fields;
    }
    err.code = err.code || 'TABLE_FIELDS_UNAVAILABLE';
    throw err;
  }
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
const SOURCE_PROBE_SCRIPT = pathMod.join(__dirname, '..', '..', 'scripts', 'source-probe.js');
const { getSweepLockStatus, requestSweepStop, inspectSweepProcess } = require('./sweep-lock');
const _matrixRuns = new Map(); // runId -> { id, state, log[], result, startedAt, endedAt }
const MATRIX_LOG_KEEP = 200;
const MATRIX_RUN_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.MATRIX_RUN_TIMEOUT_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000);

function terminateProcessTree(childOrPid) {
  const pid = Number(typeof childOrPid === 'object' ? childOrPid?.pid : childOrPid);
  if (!pid) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const { execFile: execFileKill } = require('child_process');
      execFileKill('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide:true }, () => resolve(true));
      return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    const hard = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch (_) {} resolve(true); }, 2500);
    hard.unref?.();
    setTimeout(() => {
      if (!require('./sweep-lock').pidAlive(pid)) { clearTimeout(hard); resolve(true); }
    }, 300).unref?.();
  });
}

/** 启动一次矩阵巡检子进程。调用方需保证同一时间只有一个 running（db.json 整文件写盘的竞争约束）。 */
function spawnMatrixRun({ limit = 15, region = '', regions = [], batch = 'all', category = '', all = false, deep = false, owner = '', compensationMode = '', lookbackDays = 0, mode = 'daily' } = {}) {
  const runId = db.uid('mx');
  const entry = { id: runId, state: 'running', batch, mode:normalizeCrawlMode(mode), regions, region, category, log: [], result: null, startedAt: db.nowIso(), endedAt: '', userStopped:false };
  const args = [SWEEP_SCRIPT, 'run'];
  if (all) args.push('--all');
  else {
    args.push('--limit', String(limit));
    if (region) args.push('--region', region);
    else if (regions.length) args.push('--regions', regions.join(','));
    if (category) args.push('--category', category);
    if (compensationMode) args.push('--compensation-mode', String(compensationMode));
    if (lookbackDays) args.push('--lookback-days', String(lookbackDays));
  }
  args.push('--mode', normalizeCrawlMode(mode));
  const push = (chunk) => {
    const lines = String(chunk || '')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l && !l.includes('__RESULT__'));
    entry.log.push(...lines);
    if (entry.log.length > MATRIX_LOG_KEEP) entry.log = entry.log.slice(-MATRIX_LOG_KEEP);
  };
  const childEnv = { ...process.env };
  // 手动全量巡检优先跑“轻量基线”：官方枚举 + 基础搜索，不为每个 0 命中格子再调用 AI。
  // 真正异常省会进入 compensation/recheck，再用 deep 模式补抓，整体更快也更不容易卡住。
  childEnv.SWEEP_OWNER = owner || (deep ? 'manual-deep' : 'manual');
  if (all || Number(limit) > 30) childEnv.SWEEP_AI_FALLBACK = 'false';
  if (deep) {
    childEnv.CRAWL_SEARCH_DEPTH = 'deep';
    childEnv.SWEEP_AI_FALLBACK = 'true';
  }
  const child = execFile(
    process.execPath,
    args,
    { cwd: pathMod.join(__dirname, '..', '..'), env:childEnv, timeout: MATRIX_RUN_TIMEOUT_MS, killSignal: 'SIGTERM', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      // 子进程整文件落盘后，丢弃本进程旧快照重读，避免下次 save 覆盖子进程写入
      try { db.reload(); } catch (_) {}
      entry.endedAt = db.nowIso();
      const marker = String(stdout || '').lastIndexOf('__RESULT__');
      if (entry.userStopped) {
        entry.state = 'killed';
        entry.result = { ok:false, killed:true, error:'用户手动终止' };
      } else if (marker !== -1) {
        try {
          entry.result = JSON.parse(String(stdout).slice(marker + '__RESULT__'.length));
          entry.state = entry.result?.stopped ? 'killed' : 'done';
        } catch (_) {
          entry.result = { ok: false, error: '巡检结果 JSON 解析失败' };
          entry.state = 'error';
        }
      } else {
        entry.state = err ? 'error' : 'done';
        const timedOut = !!(err && (err.killed || err.signal) && /timed out|timeout|SIGTERM/i.test(String(err.message || '') + String(err.signal || '')));
        entry.result = { ok: !err, timeout: timedOut, error: err ? (timedOut ? `巡检超过 ${Math.round(MATRIX_RUN_TIMEOUT_MS/60000)} 分钟已终止` : err.message) : '子进程未返回结果标记' };
      }
      // 强制终止可能发生在任务刚标记 running、尚未来得及自行回写时。
      // 单飞锁保证此处无第二个 sweep，只回收本次范围，避免后台残留假“运行中”。
      if (entry.state === 'killed' || entry.state === 'error' || !entry.result?.ok) {
        try {
          const d = db.getDb();
          const scope = new Set(entry.region ? [entry.region] : (entry.regions || []));
          let recovered = 0;
          for (const task of d.crawlTasks || []) {
            if (task.status !== 'running') continue;
            if (scope.size && !scope.has(task.region)) continue;
            if (entry.category && !String(task.keyword || '').includes(entry.category)) continue;
            task.status = 'todo';
            task.error = entry.userStopped ? '' : (entry.result?.error || task.error || '巡检异常退出');
            recovered += 1;
          }
          if (recovered) db.save();
        } catch (_) {}
      }
      // 如果这次 run 来自 compensationQueue，完成后更新任务状态/退避时间。
      try {
        const d = db.getDb();
        const cq = (d.compensationQueue || []).find((q) => q.runId === runId && q.status === 'running');
        if (cq) {
          const health = (d.sourceHealth || []).find((h) => h.region === cq.region);
          if (entry.result && entry.result.ok && health && health.status === 'healthy') {
            cq.status = 'done'; cq.resolvedAt = db.nowIso();
          } else if ((cq.attempts || 0) >= 5) {
            cq.status = 'manual'; cq.lastError = entry.result?.error || health?.reason || '多次补偿未恢复';
          } else {
            cq.status = 'retry';
            cq.lastError = entry.result?.error || health?.reason || '';
            const backoffHours = Math.min(24, 2 ** Math.min(cq.attempts || 1, 5));
            cq.nextRunAt = new Date(Date.now() + backoffHours * 3600000).toISOString();
          }
          db.save();
        }
      } catch (_) {}
      _matrixRuns.set(runId, entry);
      if (stderr) console.error(`[matrix-run ${runId}] stderr: ${String(stderr).slice(0, 500)}`);
    },
  );
  entry.child = child;
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

function runSourceProbe(region) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SOURCE_PROBE_SCRIPT, '--region', region, '--max-pages', '1'],
      {
        cwd:pathMod.join(__dirname, '..', '..'),
        timeout:75_000,
        killSignal:'SIGTERM',
        windowsHide:true,
        maxBuffer:2 * 1024 * 1024,
        env:{ ...process.env, ENUM_HTTP_TIMEOUT_MS: process.env.ENUM_HTTP_TIMEOUT_MS || '6000' },
      },
      (err, stdout, stderr) => {
        const text=String(stdout || '');
        const m=text.lastIndexOf('__RESULT__');
        let result=null;
        if (m !== -1) {
          try { result=JSON.parse(text.slice(m + '__RESULT__'.length)); } catch (_) {}
        }
        if (!result) result={ ok:false, error:err?.message || String(stderr || '来源探测失败').slice(0,300) };
        resolve(result);
      },
    );
  });
}

function saveSourceProbeResult(region, result) {
  const d = db.getDb();
  if (!Array.isArray(d.sourceHealth)) d.sourceHealth = [];
  if (!Array.isArray(d.compensationQueue)) d.compensationQueue = [];
  const province = PROVINCES.find((p) => p.key === region);
  if (!province) return;
  let row = d.sourceHealth.find((x) => x.region === region);
  if (!row) {
    row = { id:province.key, region, province:province.name, root:province.root, consecutiveZeroNewRuns:0, failedRuns24h:0 };
    d.sourceHealth.push(row);
  }
  const now = db.nowIso();
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  row.lastRunAt = now;
  row.endpoints = diagnostics.map((x) => ({
    kind:`official_${x.type || 'channel'}`,
    label:x.label || '官方来源',
    url:(x.urls || [])[0] || '',
    urls:x.urls || [],
    lastHttpOk:!!x.ok,
    lastCheckedAt:now,
    itemCount:x.itemCount || 0,
    failed:x.failed || 0,
    lastError:x.lastError || '',
    errors:x.errors || [],
  }));
  if (!row.endpoints.length && result?.ok === false) {
    row.endpoints.push({
      kind:'official_probe', label:'来源探测进程', url:province.root || '', lastHttpOk:false,
      lastCheckedAt:now, itemCount:0, failed:1,
      lastError:String(result.error || '来源探测失败').slice(0, 500), errors:[],
    });
  }
  const failed = row.endpoints.filter((x) => !x.lastHttpOk);
  row.lastError = failed.map((x) => x.lastError).filter(Boolean).slice(-2).join('；').slice(0, 500);
  row.failedRuns24h = failed.length ? (row.failedRuns24h || 0) + 1 : 0;
  row.enumItems = Number(result?.itemCount || 0);
  const latest = (result?.samples || []).map((x) => String(x.publishDate || x.releaseDate || '').slice(0, 10)).filter((x) => /^20\d{2}-\d{2}(?:-\d{2})?$/.test(x)).sort().pop();
  if (latest) row.latestPrimaryPublishedAt = latest;
  const health = evaluateSourceHealth({ id:province.key, key:province.key, expectedUpdateDays:7 }, row);
  row.status = health.status;
  row.reason = health.reason;
  if (health.status === 'healthy') {
    for (const q of d.compensationQueue) {
      if (q.region === region && ['queued','retry'].includes(q.status)) { q.status='done'; q.resolvedAt=now; }
    }
  } else {
    for (const plan of buildCompensationPlan(province, health)) {
      if (!d.compensationQueue.some((q) => q.region === region && q.mode === plan.mode && ['queued','retry','running'].includes(q.status))) {
        d.compensationQueue.push({ id:db.uid('cmp'), ...plan, region, status:'queued', attempts:0, createdAt:now, nextRunAt:now });
      }
    }
  }
  db.save();
}

function runningSweepInfo() {
  const local = [..._matrixRuns.values()].find((r) => ['running','stopping'].includes(r.state));
  if (local) return { busy:true, source:'api', id:local.id, state:local.state, pid:local.child?.pid || 0, startedAt:local.startedAt };
  const external = getSweepLockStatus();
  if (external.locked) return { busy:true, source:'external', state:'running', ...external.lock };
  return { busy:false, state:'idle' };
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

  // 读取兜底：任何入池条目缺 id 自动补（枚举/爬虫个别路径漏设时，预览/入库/忽略仍可定位）
  const crawlList = () => {
    // 巡检子进程每爬完一格就落盘一次，这里同步后再读，待审批列表才能随入池实时增长
    // （否则要等整轮结束子进程退出、触发 reload 才更新）
    db.syncIfChanged();
    const q = db.getDb().crawlQueue;
    let dirty = false;
    for (const c of q) {
      if (!c.id) { c.id = db.uid('crawl'); dirty = true; }
    }
    if (dirty) db.save();
    return q;
  };

  // GET /api/crawl/crawled-pending → 待确认清单 + stats{new,exists,needs_update}
  // 响应形状 1:1 对齐原版 shared/api.interface.ts 的 ICrawlResult：
  // 前端 BitableDisplayPage 依赖 comparisonResult / bitableRecordId / province / city /
  // summary / officialUrl / policyDomain / amount / effectiveDate 等字段渲染与按钮 gating。
  app.get('/api/crawl/crawled-pending', requireUser, async (req, res, next) => {
    try {
      let all = [];
      let comparisonAvailable = true;
      let comparisonError = '';
      const compareTimeoutMs = Math.max(2000, parseInt(process.env.ADMIN_COMPARE_TIMEOUT_MS || '8000', 10) || 8000);
      try {
        all = await Promise.race([
          store.getAll(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`飞书存量比对超过 ${compareTimeoutMs}ms`)), compareTimeoutMs)),
        ]);
      } catch (e) {
        comparisonAvailable = false;
        comparisonError = String(e.message || e).slice(0, 300);
        console.warn('[crawl] 审批列表飞书比对暂不可用，先返回本地队列:', comparisonError);
      }
      const selectedRegions = new Set(regionsForBatch(req.query.batch || 'all'));
      const listMode = normalizeCrawlMode(req.query.mode);
      const today = shanghaiDate();
      const stats = { new: 0, exists: 0, needs_update: 0, suspect: 0, unknown: 0 };
      const items = crawlList()
        .filter((c) => !['confirmed', 'pending_sync', 'ignored'].includes(c.status))
        .filter((c) => selectedRegions.has(c.region || '全国'))
        .filter((c) => listMode === 'initial' || normalizePublishedDate(c.releaseDate || c.publishDate) === today)
        .map((c) => {
          const st = comparisonAvailable ? matchStatus(c, all) : 'unknown';
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
          const category = c.category || classifyCategory(`${c.title}${c.content}`) || '';
          return {
            province: region,
            city: '',
            title: c.title || '',
            summary: c.summary || c.content || '',
            publishDate: c.releaseDate || '',
            officialUrl,
            source: c.org || c.source || 'manual',
            category,
            policyDomain: category,
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
            createdAt: c.createdAt || '',
            // 今日**入池**（爬到的时间），与"今日发布(todayAdded)"是两个口径，勿混用
            addedToday: shanghaiDate(c.createdAt) === today,
          };
        });
      res.json({ items, total: items.length, mode:listMode, stats, comparisonAvailable, comparisonError });
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
    // 同步子进程写入：巡检进度、每格命中数、待确认池计数都要实时反映
    db.syncIfChanged();
    const batch = batchById(req.query.batch || 'all');
    const selectedRegions = new Set(batch.regions);
    const tasks = (db.getDb().crawlTasks || []).filter((t) => selectedRegions.has(t.region));
    const summary = summarizeTasks(tasks);
    const errs = tasks.filter((t) => taskState(t.status) === 'failed');
    const queue = (db.getDb().crawlQueue || []).filter((c) => selectedRegions.has(c.region || '全国'));
    const running = [..._matrixRuns.values()].filter((r) => ['running','stopping'].includes(r.state));
    const activeSweep = runningSweepInfo();
    const today = shanghaiDate();
    const pendingQueue = queue.filter((c) => !['confirmed', 'pending_sync', 'ignored'].includes(c.status));
    const pipeline = tasks.reduce((out, task) => {
      for (const key of Object.keys(out)) out[key] += Number(task.pipeline?.[key] || 0);
      return out;
    }, { discovered:0, dateFiltered:0, qualityFiltered:0, duplicates:0, accepted:0 });
    res.json({
      batch: { id:batch.id, label:batch.label, regions:batch.regions },
      batches: REGION_BATCHES.map((x) => ({ id:x.id, label:x.label, regionCount:x.regions.length, total:x.regions.length * MATRIX_CATEGORY_KEYWORDS.length })),
      total: summary.total,
      runningCount: summary.running,
      done: summary.done,
      error: summary.failed,
      failed: summary.failed,
      remaining: summary.pending,
      paused: summary.paused,
      recentErrors: errs.slice(-5).map((t) => ({ id: t.id, error: t.error, lastRun: t.lastRun })),
      queue: {
        pending: pendingQueue.length,
        // 「今日新增」= 今日**发布**的政策，与"今日增量"巡检模式同一口径（按发布日期）。
        // 注意：不是"今日入池"。政策可能今天才被爬到，但发布日期是历史的，
        // 这种情况不计入今日新增——这是正确语义，勿改成按 createdAt 统计。
        // 想看"今天刚爬进来"的条目，用接口里的 addedToday 字段 / 列表 NEW 徽标。
        todayAdded: pendingQueue.filter((c) => normalizePublishedDate(c.releaseDate || c.publishDate) === today).length,
        total: queue.length,
      },
      outboxPending: (db.getDb().syncOutbox || []).filter((o) => !o.synced).length,
      llmEnabled: llm.llmEnabled(),
      running: running.map((r) => r.id),
      activeSweep,
      sweepLock: getSweepLockStatus(),
      regions: REGIONS,
      matrixKeywords: MATRIX_CATEGORY_KEYWORDS,
      tasks: tasks.map((t) => ({ ...t, state:taskState(t.status), pipeline:t.pipeline || { discovered:Number(t.hits)||0, dateFiltered:0, qualityFiltered:0, duplicates:Math.max(0,(Number(t.hits)||0)-(Number(t.added)||0)), accepted:Number(t.added)||0 } })),
      pipeline,
      sourceHealth: (Array.isArray(db.getDb().sourceHealth) ? db.getDb().sourceHealth : []).filter((h) => selectedRegions.has(h.region)),
      compensationPending: (db.getDb().compensationQueue || []).filter((q) => ['queued','retry','running'].includes(q.status)).length,
    });
  });

  app.patch('/api/crawl/tasks/:id', requireUser, (req, res) => {
    const task = (db.getDb().crawlTasks || []).find((x) => x.id === req.params.id);
    if (!task) return res.status(404).json({ statusCode:404, message:'巡检任务不存在', error:'Not Found' });
    const action = String(req.body?.action || '').trim();
    if (action === 'pause') {
      if (task.status === 'running') return res.status(409).json({ statusCode:409, message:'运行中的任务请先停止整轮巡检', error:'Conflict' });
      task.status = 'paused';
    } else if (action === 'resume') {
      if (task.status === 'paused') task.status = 'todo';
    } else if (action && action !== 'priority') {
      return res.status(400).json({ statusCode:400, message:'action 仅支持 pause/resume/priority', error:'Bad Request' });
    }
    if (req.body?.priority !== undefined) {
      const priority = Number(req.body.priority);
      if (!Number.isFinite(priority)) return res.status(400).json({ statusCode:400, message:'priority 必须是数字', error:'Bad Request' });
      task.priority = Math.max(0, Math.min(100, Math.round(priority)));
    }
    db.save();
    res.json({ success:true, task:{ ...task, state:taskState(task.status) } });
  });

  app.patch('/api/crawl/candidates/:id', requireUser, (req, res) => {
    const item = crawlList().find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ statusCode:404, message:'候选政策不存在', error:'Not Found' });
    if (['confirmed','pending_sync','ignored'].includes(item.status)) return res.status(409).json({ statusCode:409, message:'该候选已处理，不能再修改', error:'Conflict' });
    const allowed = ['title','region','category','releaseDate','effectiveDate','expirationDate','summary','note'];
    const changes = {};
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) changes[key] = String(req.body[key] ?? '').trim();
    if ('title' in changes && !changes.title) return res.status(400).json({ statusCode:400, message:'标题不能为空', error:'Bad Request' });
    if ('region' in changes && !REGIONS.includes(changes.region)) return res.status(400).json({ statusCode:400, message:'地区无效', error:'Bad Request' });
    if ('category' in changes && !POLICY_SOURCES.some((x) => x.category === changes.category)) return res.status(400).json({ statusCode:400, message:'政策分类无效', error:'Bad Request' });
    for (const key of ['releaseDate','effectiveDate','expirationDate']) {
      if (changes[key] && !/^20\d{2}-\d{2}-\d{2}$/.test(changes[key])) return res.status(400).json({ statusCode:400, message:`${key} 必须为 YYYY-MM-DD`, error:'Bad Request' });
    }
    Object.assign(item, changes, { editedAt:db.nowIso(), editedBy:req.user?.name || req.user?.sub || 'admin' });
    db.save();
    res.json({ success:true, item });
  });

  function healthAction(h, activeComp) {
    const status = h.status || 'unknown';
    const reason = h.reason || 'not_checked';
    if (activeComp) return `自动补偿${activeComp.status === 'running' ? '正在执行' : '已排队'}：${activeComp.mode}`;
    if (status === 'unknown') return '先点“探测源”，确认固定入口和自动发现是否可用';
    if (status === 'down' || reason === 'no_successful_endpoint') return '先探测源；固定入口失效则修 URL，保留自动发现兜底';
    if (reason === 'secondary_newer_than_primary') return '主栏目疑似漏抓：执行深度复检/分页回溯';
    if (reason === 'abnormal_zero_updates') return '连续零新增：执行深度复检，并检查公报/规范性文件库';
    if (reason === 'primary_content_stale' || status === 'stale') return '来源疑似停更：重新发现政策入口并回溯近期分页';
    if (reason === 'partial_endpoint_failure' || status === 'degraded') return '部分入口失败：探测源并只修失败入口';
    if (status === 'suspicious') return '执行深度复检，比较搜索与官方栏目最新日期';
    return '无需人工处理';
  }

  // GET /api/crawl/source-health → 31 省来源健康、异常原因与补偿任务
  app.get('/api/crawl/source-health', requireUser, (req, res) => {
    const d = db.getDb();
    const health = Array.isArray(d.sourceHealth) ? d.sourceHealth : [];
    const queue = Array.isArray(d.compensationQueue) ? d.compensationQueue : [];
    const batch = batchById(req.query.batch || 'all');
    const regionSet = new Set(batch.regions);
    const selectedProvinces = PROVINCES.filter((p) => regionSet.has(p.key));
    const by = { healthy:0, degraded:0, stale:0, suspicious:0, down:0, unknown:0 };
    for (const p of selectedProvinces) {
      const h = health.find((x) => x.region === p.key);
      by[h?.status || 'unknown'] = (by[h?.status || 'unknown'] || 0) + 1;
    }
    const nationalTasks = (d.crawlTasks || []).filter((t) => t.region === '全国');
    const nationalSummary = summarizeTasks(nationalTasks);
    const nationalItem = regionSet.has('全国') ? {
      region:'全国', province:'全国专项', root:'https://www.gov.cn/zhengce/',
      status:nationalSummary.failed ? 'degraded' : (nationalSummary.done ? 'healthy' : 'unknown'),
      reason:nationalSummary.failed ? 'search_task_failure' : (nationalSummary.done ? 'ok' : 'not_checked'),
      action:nationalSummary.failed ? '查看失败关键词并重新运行全国专项' : (nationalSummary.done ? '无需人工处理' : '运行全国专项完成首次验证'),
      needsAction:!nationalSummary.done || !!nationalSummary.failed,
      lastRunAt:nationalTasks.map((t)=>t.lastRun || '').sort().at(-1) || '',
      lastHits:nationalTasks.reduce((n,t)=>n+(Number(t.hits)||0),0), lastAdded:nationalTasks.reduce((n,t)=>n+(Number(t.added)||0),0),
      enumItems:0, searchItems:nationalTasks.reduce((n,t)=>n+(Number(t.hits)||0),0), failedRuns24h:nationalSummary.failed,
      lastError:nationalTasks.find((t)=>taskState(t.status)==='failed')?.error || '', endpoints:[], badEndpoints:[], compensation:null,
    } : null;
    if (nationalItem) by[nationalItem.status] = (by[nationalItem.status] || 0) + 1;
    res.json({
      summary: by,
      batch:{ id:batch.id, label:batch.label },
      totalProvinces: selectedProvinces.length,
      items: [...(nationalItem ? [nationalItem] : []), ...selectedProvinces.map((p) => {
        const h = health.find((x) => x.region === p.key) || {};
        const activeComp = queue.find((q) => q.region === p.key && ['queued','retry','running'].includes(q.status)) || null;
        const endpoints = Array.isArray(h.endpoints) ? h.endpoints : [];
        const badEndpoints = endpoints.filter((e) => e.lastHttpOk === false);
        return {
          region:p.key, province:p.name, root:p.root,
          status:h.status || 'unknown', reason:h.reason || 'not_checked',
          action:healthAction(h, activeComp), needsAction:(h.status || 'unknown') !== 'healthy',
          lastRunAt:h.lastRunAt || '', lastDiscoveredAt:h.lastDiscoveredAt || '', lastHits:h.lastHits || 0, lastAdded:h.lastAdded || 0,
          enumItems:h.enumItems || 0, searchItems:h.searchItems || 0, consecutiveZeroNewRuns:h.consecutiveZeroNewRuns || 0,
          failedRuns24h:h.failedRuns24h || 0, lastError:h.lastError || '', endpoints, badEndpoints,
          compensation:activeComp ? { id:activeComp.id, mode:activeComp.mode, status:activeComp.status, priority:activeComp.priority || 0, attempts:activeComp.attempts || 0, nextRunAt:activeComp.nextRunAt || '' } : null,
        };
      })],
      compensationQueue: queue.filter((q)=>regionSet.has(q.region)).sort((a,b)=>(b.priority||0)-(a.priority||0)),
    });
  });

  // POST /api/crawl/compensation/run-next → 立即执行优先级最高且到期的补偿任务
  app.post('/api/crawl/compensation/run-next', requireUser, (req, res) => {
    const running = runningSweepInfo();
    if (running.busy) return res.status(409).json({ statusCode:409, message:`已有巡检运行中${running.id ? '：' + running.id : ''}`, running, error:'Conflict' });
    const d = db.getDb();
    const now = Date.now();
    const recovered = recoverExpiredCompensations(
      d.compensationQueue || [],
      now,
      process.env.COMPENSATION_LEASE_MS || 30 * 60 * 1000,
    );
    if (recovered) db.save();
    const q = (d.compensationQueue || [])
      .filter((x) => ['queued','retry'].includes(x.status) && (!x.nextRunAt || Date.parse(x.nextRunAt) <= now))
      .sort((a,b)=>(b.priority||0)-(a.priority||0) || Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0))[0];
    if (!q) return res.json({ success:true, empty:true, message:'当前没有到期的补偿任务' });
    q.status='running'; q.attempts=(q.attempts||0)+1; q.lastRunAt=db.nowIso();
    db.save();
    const runId = spawnMatrixRun({
      limit:MATRIX_CATEGORY_KEYWORDS.length,
      region:q.region,
      deep:true,
      owner:'compensation',
      compensationMode:q.mode,
      lookbackDays:q.lookbackDays,
    });
    q.runId=runId; db.save();
    res.json({ success:true, runId, task:q, message:`已启动 ${q.region} 补偿巡检` });
  });

  // POST /api/crawl/source-probe/:region → 轻量探测官方枚举入口，不跑13类搜索
  app.post('/api/crawl/source-probe/:region', requireUser, async (req, res, next) => {
    try {
      const region=String(req.params.region || '').trim();
      if (!REGIONS.includes(region) || region === '全国') return res.status(400).json({ statusCode:400, message:'地区无效', error:'Bad Request' });
      const result=await runSourceProbe(region);
      saveSourceProbeResult(region, result);
      res.json(result);
    } catch (e) { next(e); }
  });

  // POST /api/crawl/source-health/:region/recheck → 手动整省复检
  app.post('/api/crawl/source-health/:region/recheck', requireUser, (req, res) => {
    const region=String(req.params.region||'').trim();
    if (!REGIONS.includes(region) || region === '全国') return res.status(400).json({ statusCode:400, message:'地区无效', error:'Bad Request' });
    const running=runningSweepInfo();
    if (running.busy) return res.status(409).json({ statusCode:409, message:`已有巡检运行中${running.id ? '：' + running.id : ''}`, running, error:'Conflict' });
    const runId=spawnMatrixRun({ limit:MATRIX_CATEGORY_KEYWORDS.length, region, deep:true });
    res.json({ success:true, runId, message:`已启动 ${region} 全类别复检` });
  });

  // POST /api/crawl/matrix-run {limit?, region?, category?, all?} → 触发一批矩阵巡检（异步子进程）
  app.post('/api/crawl/matrix-run', requireUser, (req, res) => {
    const running = runningSweepInfo();
    if (running.busy) {
      return res.status(409).json({ statusCode: 409, message: `已有巡检运行中${running.id ? '：' + running.id : ''}，请等待完成后再触发`, running, error: 'Conflict' });
    }
    const { limit, region, category, all, batch:batchId='all', mode='daily' } = req.body || {};
    if (!REGION_BATCHES.some((x) => x.id === String(batchId))) {
      return res.status(400).json({ statusCode:400, message:'区域批次无效', error:'Bad Request' });
    }
    const batch = batchById(batchId);
    const normalizedRegion = String(region || '').trim();
    if (normalizedRegion && !REGIONS.includes(normalizedRegion)) {
      return res.status(400).json({ statusCode:400, message:'地区无效', error:'Bad Request' });
    }
    if (normalizedRegion && !batch.regions.includes(normalizedRegion)) {
      return res.status(400).json({ statusCode:400, message:`${normalizedRegion} 不属于${batch.label}批次`, error:'Bad Request' });
    }
    let lmt = parseInt(limit, 10);
    if (Number.isFinite(lmt) && lmt > 0) {
      lmt = Math.min(lmt, 99999);
    } else if (normalizedRegion && String(category || '').trim()) {
      lmt = 1;
    } else if (normalizedRegion) {
      lmt = MATRIX_CATEGORY_KEYWORDS.length;
    } else {
      lmt = all ? batch.regions.length * MATRIX_CATEGORY_KEYWORDS.length : 15;
    }
    const runId = spawnMatrixRun({
      limit: lmt,
      region: normalizedRegion,
      regions: normalizedRegion ? [] : batch.regions,
      batch: batch.id,
      category: String(category || '').trim(),
      all: !!all && batch.id === 'all' && !normalizedRegion,
      mode: normalizeCrawlMode(mode),
    });
    res.json({ success: true, runId, batch:{ id:batch.id, label:batch.label }, mode:normalizeCrawlMode(mode), message: `${batch.label}巡检已启动（${normalizeCrawlMode(mode)==='daily'?'今日增量':'初始化补全'}）` });
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
      batch: run.batch,
      mode: run.mode,
      regions: run.regions,
      region: run.region,
      category: run.category,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });
  });

  // POST /api/crawl/matrix-run/:id/kill → 停止正在运行的巡检子进程
  app.post('/api/crawl/matrix-run/:id/kill', requireUser, (req, res) => {
    const run = _matrixRuns.get(req.params.id);
    if (!run) return res.status(404).json({ statusCode: 404, message: '巡检任务不存在或已结束', error: 'Not Found' });
    if (run.state !== 'running') {
      return res.status(400).json({ statusCode: 400, message: `任务已结束（${run.state}），无法停止`, error: 'Bad Request' });
    }
    if (!run.child || !run.child.kill) {
      return res.status(500).json({ statusCode: 500, message: '子进程引用丢失，无法停止', error: 'Internal Error' });
    }
    run.userStopped = true;
    run.state = 'stopping';
    requestSweepStop({ pid:run.child.pid, requestedBy:'matrix-api', reason:'manual_stop' });
    terminateProcessTree(run.child).catch(() => {});
    console.log(`[matrix-run ${run.id}] 用户请求终止 pid=${run.child.pid}`);
    res.json({ success: true, stopping:true, message: '停止请求已发送，正在结束当前巡检' });
  });

  // POST /api/crawl/sweep-stop → 停止任意当前巡检（包括 cron/补偿/页面刷新后丢失 runId 的任务）
  app.post('/api/crawl/sweep-stop', requireUser, (req, res) => {
    const local = [..._matrixRuns.values()].find((r) => ['running','stopping'].includes(r.state));
    if (local?.child?.pid) {
      local.userStopped = true;
      local.state = 'stopping';
      requestSweepStop({ pid:local.child.pid, requestedBy:'global-stop', reason:'manual_stop' });
      terminateProcessTree(local.child).catch(() => {});
      return res.json({ success:true, stopping:true, runId:local.id, pid:local.child.pid, message:'正在停止当前巡检' });
    }
    const lock = getSweepLockStatus();
    if (!lock.locked || !lock.lock?.pid) return res.json({ success:true, empty:true, message:'当前没有运行中的巡检' });
    requestSweepStop({ pid:lock.lock.pid, requestedBy:'global-stop', reason:'manual_stop' });
    const identity = inspectSweepProcess(lock.lock);
    if (!identity.ok) {
      return res.status(409).json({
        statusCode:409,
        success:false,
        stopping:false,
        message:'已写入停止请求，但锁对应进程身份无法确认，已拒绝强制结束，避免误杀其他程序',
        reason:identity.reason,
        error:'Conflict',
      });
    }
    terminateProcessTree(lock.lock.pid).catch(() => {});
    res.json({ success:true, stopping:true, pid:lock.lock.pid, message:'正在停止外部巡检进程' });
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
          let suggs = [];
          try {
            suggs = await llm.suggestTableValues(`${item.title || ''}\n${(item.content || '').slice(0, 2500)}`, cols);
          } catch (err) {
            // 预览不能依赖 LLM 可用性；AI 挂掉时继续展示本地规则可生成的字段。
            console.warn(`[crawl-api] preview LLM degraded for ${recordId}: ${err.message || err}`);
          }
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
      if (item.status === 'confirmed') {
        return res.json({ success:true, alreadyConfirmed:true, category:item.targetCategory || item.category || '', targetTableId:item.targetTableId || '', message:'该条目已入库，无需重复写入' });
      }
      if (item.status === 'pending_sync') {
        return res.json({ success:true, pendingSync:true, outboxId:item.outboxId || '', category:item.targetCategory || item.category || '', targetTableId:item.targetTableId || '', message:'该条目已在待同步队列中，无需重复提交' });
      }
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
      const enqueueRetry = (fields, failure, updates) => {
        const outboxItem = { id:db.uid('sync'), kind:fields ? 'create' : 'crawl_create', appToken:src.appToken, tableId:src.tableId,
          ...(fields ? { fields } : { updates:updates || {} }), sourceItemId:item.id, category, synced:false,
          createdAt:db.nowIso(), lastError:failure.message, failureKind:failure.kind };
        db.getDb().syncOutbox.push(outboxItem);
        Object.assign(item, { status:'pending_sync', targetCategory:category, targetTableId:src.tableId, outboxId:outboxItem.id, lastError:failure.message });
        db.save();
        return res.status(201).json({ success:true, category, targetTableId:src.tableId, pendingSync:true, outboxId:outboxItem.id,
          degradeReason:failure.kind, message:`飞书暂时不可用，已安全保存到待同步队列：${failure.message}` });
      };
      let targetFields;
      try {
        targetFields = await getFieldsCached(bitable, src.appToken, src.tableId);
      } catch (err) {
        const failure = classifyBitableFailure(err);
        if (failure.retryable) return enqueueRetry(null, failure, (req.body || {}).updates);
        return res.status(422).json({ success:false, pendingSync:false, statusCode:422,
          message:`无法读取目标表字段，且该错误不会自动重试：${failure.message}`, error:'Bitable fields unavailable' });
      }
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
        const failure = classifyBitableFailure(err);
        if (failure.retryable) return enqueueRetry(fields, failure);
        return res.status(422).json({ success:false, pendingSync:false, statusCode:422,
          message:`飞书拒绝该条数据，未进入待同步队列：${failure.message}`, error:'Bitable validation failed' });
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
  app.post('/api/crawl/compare', requireUser, async (req, res, next) => {
    try {
      const { keyword, region, mode='daily' } = req.body || {};
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
      let dateFiltered = 0;
      let duplicates = 0;
      for (const item of crawled) {
        item.url = canonicalizeUrl(item.url);
        if (!queueDecision(item, mode).accept) { dateFiltered += 1; continue; }
        if (!list.some((c) => c.url && canonicalizeUrl(c.url) === item.url)) {
          item.crawlMode = normalizeCrawlMode(mode);
          list.push(item);
          added += 1;
        } else duplicates += 1;
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
      res.json({ items, total: items.length, stats, addedToQueue: added, aiEnabled: !!aiVerdicts, mode:normalizeCrawlMode(mode), pipeline:{ discovered:crawled.length, dateFiltered, qualityFiltered:Number(parsed.qualityFiltered||0), duplicates, accepted:added } });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/crawl/ai-expand {keyword, region, count?} → DeepSeek 生成搜索变体词并立即执行
  // 用于发现层：基础关键词命中为0时，用 AI 变体词重新搜索，提升新政策发现量
  app.post('/api/crawl/ai-expand', requireUser, async (req, res, next) => {
    try {
      const { keyword, region, count = 5, mode='daily' } = req.body || {};
      if (!keyword || !region) {
        return res.status(400).json({ statusCode: 400, message: 'keyword 与 region 必填', error: 'Bad Request' });
      }
      const crawler = require('../../policy-api/src/crawler');
      // 1. 先用基础词搜一次
      const baseItems = await crawler.crawlPolicies({ keyword, region }).catch(() => []);
      // 2. 若命中为0，用 DeepSeek 生成变体词再搜
      let expandedTerms = [];
      let extraItems = [];
      let aiAttempted = false;
      let aiSucceeded = false;
      let degraded = false;
      let degradeReason = '';
      if (baseItems.length === 0) {
        if (llm.llmEnabled()) {
          aiAttempted = true;
          const terms = await llm.aiExpandSearchTerms({ province: region, category: keyword, count }).catch(() => null);
          if (terms && terms.length > 0) {
            aiSucceeded = true;
            expandedTerms = terms;
            for (const term of terms) {
              const ext = await crawler.crawlPolicies({ keyword: term, region }).catch(() => []);
              extraItems = extraItems.concat(ext);
            }
          } else {
            degraded = true;
            degradeReason = 'DeepSeek 请求失败或未返回有效变体词，已降级为基础抓取结果';
          }
        } else {
          degraded = true;
          degradeReason = 'DeepSeek 未配置，已使用基础抓取结果';
        }
      }
      // 3. 合并结果并按 url 去重
      const allItems = [...baseItems, ...extraItems];
      const seen = new Set();
      const uniqueItems = [];
      for (const it of allItems) {
        if (it.url && !seen.has(it.url)) { seen.add(it.url); uniqueItems.push(it); }
      }
      // 4. 写入待确认池
      const list = crawlList();
      let added = 0;
      let dateFiltered = 0;
      let duplicates = 0;
      for (const it of uniqueItems) {
        it.url = canonicalizeUrl(it.url);
        if (!queueDecision(it, mode).accept) { dateFiltered += 1; continue; }
        if (!list.some((c) => c.url && canonicalizeUrl(c.url) === it.url)) {
          it.crawlMode = normalizeCrawlMode(mode);
          list.push(it);
          added += 1;
        } else duplicates += 1;
      }
      if (added > 0) db.save();
      res.json({
        ok: true,
        baseHits: baseItems.length,
        expandedTerms: expandedTerms.length,
        extraHits: extraItems.length,
        totalUnique: uniqueItems.length,
        addedToQueue: added,
        aiEnabled: llm.llmEnabled(),
        aiAttempted,
        aiSucceeded,
        degraded,
        degradeReason,
        engine: aiSucceeded ? 'deepseek+base-crawler' : 'base-crawler',
        mode: normalizeCrawlMode(mode),
        pipeline: { discovered:uniqueItems.length, dateFiltered, qualityFiltered:0, duplicates, accepted:added },
        terms: expandedTerms,
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerCrawlRoutes, classifyCategory, buildWriteFields, normalizeUpdates, matchStatus };
