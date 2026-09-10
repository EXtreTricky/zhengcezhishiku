'use strict';

/**
 * 每日定时爬取调度器
 *
 * 功能：
 *   1. 每天定时从飞书爬虫汇总表拉取最新数据
 *   2. 与正式库比对，自动归类新增/已存在/需更新
 *   3. 结果写入本地 db.json crawlQueue
 *
 * 配置（环境变量）：
 *   CRON_ENABLED=true          是否启用定时爬取
 *   CRON_HOUR=8                每天几点执行（24小时制，默认8点）
 *   CRON_MINUTE=0              几分执行（默认0分）
 *   CRON_INTERVAL_HOURS=0      间隔几小时重复执行（0=不重复，仅每天定时）
 */

const db = require('../../src/db');
const { judge } = require('./quality-gate');
const { spawn } = require('child_process');
const path = require('path');
const { getSweepLockStatus } = require('./sweep-lock');

// 配置统一走 getConfig() 动态读取 process.env，支持运行时通过 /api/cron/schedule 热更新

let timer = null;
let lastRun = null;

/**
 * 启动一次本地矩阵滚动巡检（实际抓取政府站新政策）。
 * 复用 scripts/sweep-crawl.js：日常默认按当天增量巡检，URL 级去重只加新政策。
 * @param {{all?:boolean, limit?:number}} opts
 */
function runLocalSweep(opts = {}) {
  return new Promise((resolve) => {
    const lockState = getSweepLockStatus();
    if (lockState.locked) {
      return resolve({ code: 2, busy: true, error: `已有巡检运行中（pid=${lockState.lock?.pid || '?'}）`, result: { ok:false, busy:true, error:'已有巡检运行中' } });
    }
    const args = ['scripts/sweep-crawl.js', 'run'];
    if (opts.all) args.push('--all');
    else {
      if (opts.newCycle) args.push('--new-cycle');
      if (opts.limit) args.push('--limit', String(opts.limit));
      if (opts.region) args.push('--region', String(opts.region));
      if (opts.category) args.push('--category', String(opts.category));
    }
    args.push('--mode', opts.mode === 'bootstrap' ? 'bootstrap' : 'daily');
    const env = { ...process.env, SWEEP_OWNER: opts.owner || (opts.deep ? 'compensation' : 'cron') };
    if (opts.deep) env.CRAWL_SEARCH_DEPTH = 'deep';
    const child = spawn(process.execPath, args, {
      cwd: path.join(__dirname, '..', '..'),
      env,
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const timeoutMs = Math.max(60_000, parseInt(process.env.SWEEP_RUN_TIMEOUT_MS || String(20 * 60 * 1000), 10) || 20 * 60 * 1000);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) {
          const { execFile } = require('child_process');
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true }, () => {});
        } else child.kill('SIGTERM');
      } catch (_) {}
      finish({ code: -2, timeout: true, error: `巡检超过 ${Math.round(timeoutMs/60000)} 分钟已终止`, result: null, raw: out.slice(-1500) });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024); });
    child.stderr.on('data', (d) => { out += d; if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024); });
    child.on('error', (e) => finish({ code: -1, error: e.message, result: null }));
    child.on('close', (code) => {
      const m = out.lastIndexOf('__RESULT__');
      let result = null;
      if (m !== -1) {
        try { result = JSON.parse(out.slice(m + '__RESULT__'.length)); } catch (_) {}
      }
      finish({ code, result, raw: out.slice(-1500), busy: !!result?.busy });
    });
  });
}

function getLogger() {
  return {
    info: (...args) => console.log(`[cron]`, new Date().toISOString(), ...args),
    error: (...args) => console.error(`[cron]`, new Date().toISOString(), ...args),
  };
}

/**
 * 计算距离下次执行的毫秒数
 */
function msUntilNext() {
  const cfg = getConfig();
  const now = new Date();
  const next = new Date(now);
  next.setHours(cfg.hour, cfg.minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}


function pickDueCompensation() {
  const d = db.getDb();
  const now = Date.now();
  return (d.compensationQueue || [])
    .filter((q) => ['queued','retry'].includes(q.status) && (!q.nextRunAt || Date.parse(q.nextRunAt) <= now))
    .sort((a,b)=>(b.priority||0)-(a.priority||0) || Date.parse(a.createdAt||0)-Date.parse(b.createdAt||0))[0] || null;
}

async function runDueCompensation(log) {
  const q = pickDueCompensation();
  if (!q) return null;
  q.status='running'; q.attempts=(q.attempts||0)+1; q.lastRunAt=new Date().toISOString();
  db.save();
  log.info(`优先执行补偿任务：${q.region} / ${q.mode} / priority=${q.priority}`);
  const r = await runLocalSweep({ region:q.region, limit:13, deep:true, owner:'compensation', mode:'daily' });
  db.reload();
  const fresh=(db.getDb().compensationQueue||[]).find((x)=>x.id===q.id);
  if (fresh && fresh.status==='running') {
    const ok=r.code===0 && r.result && r.result.ok;
    if (ok) {
      const h=(db.getDb().sourceHealth||[]).find((x)=>x.region===q.region);
      if (h && h.status==='healthy') { fresh.status='done'; fresh.resolvedAt=new Date().toISOString(); }
      else { fresh.status='retry'; fresh.nextRunAt=new Date(Date.now()+Math.min(24,2**Math.min(fresh.attempts||1,5))*3600000).toISOString(); }
    } else {
      fresh.status=(fresh.attempts||0)>=5?'manual':'retry';
      fresh.lastError=(r.error || r.result?.error || 'compensation failed').slice(0,300);
      fresh.nextRunAt=new Date(Date.now()+Math.min(24,2**Math.min(fresh.attempts||1,5))*3600000).toISOString();
    }
    db.save();
  }
  return { taskId:q.id, region:q.region, result:r };
}

/**
 * 执行一次爬取任务
 */
async function runCrawl(bitableClient, policySources) {
  const log = getLogger();
  log.info('开始执行定时爬取任务...');
  const started = Date.now();

  try {
    // 异常来源优先于普通滚动任务，避免“已检测到漏抓但补偿队列无人消费”。
    const compensation = await runDueCompensation(log);
    if (compensation) log.info(`补偿任务执行结束：${compensation.region}`);

    // 从爬虫汇总表拉取最新数据
    const crawlAppToken = process.env.FEISHU_CRAWL_APP_TOKEN;
    const crawlTableId = process.env.FEISHU_CRAWL_TABLE_ID;

    // 一轮 cron 若已经执行了补偿，不再紧接着再跑 15 个普通格子，避免双倍网络负载。
    if (compensation && (!crawlAppToken || !crawlTableId)) {
      lastRun = new Date().toISOString();
      return { success:true, mode:'compensation_only', compensation };
    }

    if (!crawlAppToken || !crawlTableId) {
      // 没有独立飞书采集汇总表时，不能把定时任务“空跑掉”。
      // 自动退回本地 31 省矩阵巡检，确保 CRON_ENABLED=true 真正产生采集工作。
      const limit = Math.max(1, Math.min(100, parseInt(process.env.CRON_SWEEP_LIMIT || '15', 10) || 15));
      log.info(`未配置爬虫汇总表，切换 local_sweep（limit=${limit}）`);
      const local = await runLocalSweep({ limit, owner:'cron', mode:'daily' });
      lastRun = new Date().toISOString();
      return { success: local.code === 0 && !!(local.result && local.result.ok), mode: 'local_sweep', ...local };
    }

    const records = await bitableClient.listAllRecords(crawlAppToken, crawlTableId);
    log.info(`从汇总表拉取 ${records.length} 条记录`);

    // 从正式库拉取所有记录用于比对
    const allPolicies = [];
    for (const src of policySources) {
      try {
        const recs = await bitableClient.listAllRecords(src.appToken, src.tableId);
        allPolicies.push(...recs.map(r => ({ ...r, _category: src.category })));
      } catch (err) {
        log.error(`拉取「${src.category}」失败: ${err.message}`);
      }
    }

    // 比对逻辑：URL 精确匹配
    const existingUrls = new Set();
    for (const p of allPolicies) {
      const fields = p.fields || {};
      for (const [k, v] of Object.entries(fields)) {
        if (/来源|链接|url/i.test(k) && typeof v === 'string' && /^https?:/i.test(v.trim())) {
          existingUrls.add(v.trim());
        }
        if (typeof v === 'object' && v.link) {
          existingUrls.add(v.link.trim());
        }
      }
    }

    // 处理爬虫记录
    let newCount = 0;
    let existsCount = 0;
    const crawlQueue = db.getDb().crawlQueue;

    for (const rec of records) {
      const f = rec.fields || {};
      const recordId = rec.record_id || rec.recordId;

      // 提取 URL
      let url = '';
      for (const [k, v] of Object.entries(f)) {
        if (/来源|链接|url/i.test(k)) {
          if (typeof v === 'string' && /^https?:/i.test(v.trim())) {
            url = v.trim();
            break;
          }
          if (typeof v === 'object' && v.link) {
            url = v.link.trim();
            break;
          }
        }
      }

      // 检查是否已存在
      const exists = url && existingUrls.has(url);
      if (exists) {
        existsCount++;
      } else {
        newCount++;
      }

      // 检查是否已在队列中
      const alreadyQueued = crawlQueue.some(q => q.sourceRecordId === recordId);
      if (!alreadyQueued && !exists) {
        // 提取基础字段
        const title = extractText(f['标题'] || f['标题/文件名'] || f['title'] || '');
        const province = extractText(f['省份'] || f['地区'] || '');
        const city = extractText(f['城市'] || '');
        const effectiveDate = extractDate(f['生效日期'] || f['effective_date']);
        const summary = extractText(f['摘要'] || f['备注'] || f['人工审核备注'] || '');
        const category = classifyCategory(title + summary);

        // 入池质量闸门（与搜索/枚举通道同一规则）
        const gate = judge({ title, url, category, summary, content: '', valuesSuggest: [] });
        if (gate.level === 'drop') {
          console.log(`[gate] 丢弃「${String(title).slice(0, 34)}」→ ${gate.reasons.join('；')}`);
          continue;
        }

        crawlQueue.push({
          id: db.uid('crawl'),
          sourceRecordId: recordId,
          title: gate.title || '(无标题)',
          region: province || city || '全国',
          content: summary,
          url: url,
          effectiveDate: effectiveDate,
          category,
          quality: gate.level,
          qualityReasons: gate.reasons,
          status: 'pending',
          source: 'scheduled_crawl',
          createdAt: db.nowIso(),
        });
      }
    }

    db.save();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    log.info(`爬取完成：汇总表 ${records.length} 条，新增 ${newCount}，已存在 ${existsCount}，耗时 ${elapsed}s`);

    lastRun = new Date().toISOString();
    return { success: true, total: records.length, new: newCount, exists: existsCount, elapsed };

  } catch (err) {
    log.error(`爬取失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function extractText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(v => extractText(v)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.text) return value.text;
    if (value.name) return value.name;
    if (value.value) return String(value.value);
  }
  return String(value);
}

function extractDate(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    // 毫秒时间戳转 YYYY-MM-DD
    const d = new Date(value);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2050) {
      return d.toISOString().slice(0, 10);
    }
    return '';
  }
  if (typeof value === 'string') return value.trim();
  return '';
}

function classifyCategory(text) {
  const t = text.toLowerCase();
  if (/最低工资/.test(t)) return '最低工资';
  if (/平均工资|社平/.test(t)) return '平均工资';
  if (/公积金/.test(t)) return '公积金';
  if (/年金/.test(t)) return '年金';
  if (/大病|医疗/.test(t)) return '大病医疗';
  if (/高温|津贴/.test(t)) return '高温津贴';
  if (/残疾/.test(t)) return '残疾职工';
  if (/婚|育|产假|陪产/.test(t)) return '婚育相关';
  if (/病假/.test(t)) return '病假工资';
  if (/经济补偿/.test(t)) return '平均工资';
  return '';
}

/**
 * 动态更新调度时间（不停服）
 */
function updateSchedule({ hour, minute, intervalHours, enabled }) {
  const log = getLogger();
  stopScheduler();

  if (enabled !== undefined) process.env.CRON_ENABLED = enabled ? 'true' : 'false';
  if (hour !== undefined) process.env.CRON_HOUR = String(hour);
  if (minute !== undefined) process.env.CRON_MINUTE = String(minute);
  if (intervalHours !== undefined) process.env.CRON_INTERVAL_HOURS = String(intervalHours);

  // 重新读取
  const cfg = getConfig();
  if (cfg.enabled && _bitableClient && _policySources) {
    startScheduler(_bitableClient, _policySources);
    log.info(`调度已更新：${cfg.schedule}，间隔 ${cfg.intervalHours}h`);
  } else {
    log.info('调度已关闭');
  }
  return getStatus();
}

function getConfig() {
  return {
    enabled: process.env.CRON_ENABLED === 'true',
    hour: parseInt(process.env.CRON_HOUR, 10) || 8,
    minute: parseInt(process.env.CRON_MINUTE, 10) || 0,
    intervalHours: parseInt(process.env.CRON_INTERVAL_HOURS, 10) || 0,
  };
}

/** 手动触发一次爬取（不等待定时） */
async function runNow() {
  if (_bitableClient && _policySources) {
    return runCrawl(_bitableClient, _policySources);
  }
  // 无飞书汇总配置时，fallback 到本地矩阵滚动巡检
  return runLocalNow();
}

/**
 * 手动触发一次本地矩阵滚动巡检（无飞书汇总表时作为默认方案）。
 * 复用 scripts/sweep-crawl.js：日常默认按当天增量巡检，URL 级去重只加新政策。
 */
async function runLocalNow(opts = {}) {
  const log = getLogger();
  log.info('[cron] 运行本地矩阵滚动巡检…');
  const r = await runLocalSweep({ all: false, limit: 15, newCycle: !!opts.newCycle });
  const ok = r.code === 0 && !!(r.result && r.result.ok);
  const res = { ok, source: 'local_sweep' };
  if (r.result) {
    res.hits = r.result.hits;
    res.added = r.result.added;
    res.failed = r.result.failed;
    res.remaining = r.result.remaining;
    res.done = r.result.done;
    res.message = r.result.message;
  } else {
    res.error = r.error || '子进程无结果';
    res.raw = r.raw;
  }
  if (!ok && !res.error) res.error = r.result?.error || `巡检进程退出码 ${r.code}`;
  lastRun = new Date().toISOString();
  return res;
}

let _bitableClient = null;
let _policySources = null;

/**
 * 启动定时调度。
 * 优先使用飞书汇总配置（bitableClient + policySources）。
 * 无飞书汇总时，退化为本地矩阵滚动巡检：每隔 N 小时跑一次（默认 6h）。
 */
function startScheduler(bitableClient, policySources) {
  _bitableClient = bitableClient;
  _policySources = policySources;

  const cfg = getConfig();
  const hasFeishu = _bitableClient && _policySources;

  const log = getLogger();
  if (hasFeishu) {
    if (!cfg.enabled) {
      console.log('[cron] 定时爬取未启用（设置 CRON_ENABLED=true 或调用 /api/cron/schedule 开启）');
      return;
    }
    const delay = msUntilNext();
    const nextTime = new Date(Date.now() + delay);
    log.info(`定时爬取已启用（飞书汇总模式），下次执行：${nextTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

    timer = setTimeout(async function tick() {
      await runCrawl(bitableClient, policySources);
      if (cfg.intervalHours > 0) {
        timer = setTimeout(tick, cfg.intervalHours * 3600 * 1000);
      } else {
        timer = setTimeout(tick, msUntilNext());
      }
    }, delay);
    return;
  }

  // 无飞书汇总 → 本地 sweep 循环。CRON_ENABLED=false 必须同样彻底关闭，
  // 不能因为缺飞书汇总表就绕过开关自行启动。
  if (!cfg.enabled) {
    console.log('[cron] 定时爬取未启用（本地 sweep 模式同样遵守 CRON_ENABLED=false）');
    return;
  }
  const intervalHours = cfg.intervalHours > 0 ? cfg.intervalHours : 6;
  const log2 = getLogger();
  log2.info(`定时爬取已启用（本地 sweep 模式，飞书汇总表未配置），每 ${intervalHours}h 一轮`);

  timer = setTimeout(async function tickLocal() {
    try {
      if (getConfig().enabled) await runLocalNow({ newCycle:true });
    } catch (_) {}
    if (getConfig().enabled) timer = setTimeout(tickLocal, intervalHours * 3600 * 1000);
    else timer = null;
  }, intervalHours * 3600 * 1000);
}

function stopScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function getStatus() {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    schedule: `${cfg.hour}:${String(cfg.minute).padStart(2, '0')}`,
    intervalHours: cfg.intervalHours,
    lastRun,
    nextRun: cfg.enabled ? new Date(Date.now() + msUntilNext()).toISOString() : null,
  };
}

module.exports = { startScheduler, stopScheduler, runCrawl, runNow, runLocalNow, updateSchedule, getStatus };
