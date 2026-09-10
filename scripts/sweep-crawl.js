#!/usr/bin/env node
/**
 * sweep-crawl.js —— 核心省 × 政策类 全矩阵巡检（滚动任务队列）
 *
 * 为什么存在：crawl-once.js 一次只搜「1 个关键词 + 1 个地区」。政策是地区×类别的二维
 * 矩阵（每省都有最低工资/公积金/高温津贴…），要"抓得多"必须自动把整个矩阵滚一遍。
 * 本脚本把 省份×类别 组合固化为任务队列存 db.json.crawlTasks，每次执行消费一批
 * （默认 15 个组合），断点续跑、url 级去重、结果并入 crawlQueue（待确认池）。
 *
 * 用法：
 *   node scripts/sweep-crawl.js list                      查看任务队列状态
 *   node scripts/sweep-crawl.js reset                     重建/重置任务队列（清 done 标记）
 *   node scripts/sweep-crawl.js run --limit 15            消费下一批（默认 15）
 *   node scripts/sweep-crawl.js run --region 广东 --category 最低工资   定向补充单格
 *   node scripts/sweep-crawl.js run --all                 一口气跑完整个矩阵（约 30-40 分钟）
 *
 * 输出：stdout 最后一行 __RESULT__ + JSON { ok, done, hits, added, remaining, error }
 */
const fs = require('fs');
const path = require('path');

// 加载项目根 .env（爬虫无需飞书凭据，但兼容 LLM_* 配置与 db 路径约定）
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .forEach((l) => {
      const m = /^([A-Za-z_]+)=(.*)$/.exec(l.trim());
      if (m) process.env[m[1]] = m[2];
    });
} catch (_) {}

const db = require('../src/db');
const llm = require('../src/llm');
const { REGIONS, CATEGORY_KEYWORDS, provinceByKey } = require('../policy-api/src/crawl-regions');
const { canonicalizeUrl } = require('../policy-api/src/url-utils');
const { enumerateProvinceDetailed } = require('../policy-api/src/enum-sources');
const { classifyCategory } = require('../policy-api/src/crawl-api');
const { evaluateSourceHealth, buildCompensationPlan } = require('../policy-api/src/source-health');
const { acquireSweepLock, isSweepStopRequested } = require('../policy-api/src/sweep-lock');
const { queueDecision, normalizeCrawlMode } = require('../policy-api/src/crawl-mode');
const { judge } = require('../policy-api/src/quality-gate');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单格硬超时：一格卡住会拖垮整轮，20 分钟后全轮被 kill、进度归零。
// 这里给每格封顶，超时就记失败跳过，保证一轮能持续推进并产出真实结果。
const TASK_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.SWEEP_TASK_TIMEOUT_MS || String(75_000), 10) || 75_000);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)}s 单格超时已跳过`)), ms);
    }),
  ]);
}

// 每格搜索都起一个干净子进程。
// 原因见 crawl-once.js 头部：搜索引擎对「长驻进程连续请求」会降级返回垃圾结果
// （实测同机同时刻：长驻进程 0 条 vs 一次性进程 5 条）。sweep 在单进程内连搜十几格，
// 第 1 格还正常，之后就只返回「XX市政府门户网站」「XX概况」这类导航页，命中率归零。
// 改成子进程后每格都是「首次请求」，命中率恢复。
const REPO_ROOT = path.join(__dirname, '..');
const CRAWL_ONCE = path.join(__dirname, 'crawl-once.js');

function runCrawlOnce(keyword, region) {
  return new Promise((resolve) => {
    // eslint-disable-next-line global-require
    const { execFile } = require('child_process');
    execFile(
      process.execPath,
      [CRAWL_ONCE, keyword, region],
      { cwd: REPO_ROOT, timeout: TASK_TIMEOUT_MS, killSignal: 'SIGTERM', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || '');
        const at = text.lastIndexOf('__RESULT__');
        if (at === -1) {
          return resolve({ ok: false, items: [], error: err ? (err.message || String(err)) : '采集子进程未返回结果' });
        }
        try {
          resolve(JSON.parse(text.slice(at + '__RESULT__'.length)));
        } catch (e) {
          resolve({ ok: false, items: [], error: '采集子进程输出解析失败' });
        }
      },
    );
  });
}

function buildTaskList() {
  const out = [];
  for (const region of REGIONS) {
    for (const keyword of CATEGORY_KEYWORDS) {
      out.push({ id: `${region}__${keyword.replace(/\s+/g, '_')}`, region, keyword, status: 'todo', lastRun: '', hits: 0, added: 0 });
    }
  }
  return out;
}

function ensureTasks() {
  const d = db.getDb();
  const desired = buildTaskList();
  const current = Array.isArray(d.crawlTasks) ? d.crawlTasks : [];
  const byId = new Map(current.map((t) => [t.id, t]));
  let changed = current.length !== desired.length;
  d.crawlTasks = desired.map((base) => {
    const old = byId.get(base.id);
    if (!old) { changed = true; return base; }
    return { ...base, ...old, region: base.region, keyword: base.keyword, id: base.id };
  });
  if (changed) db.save({ externalWriter: true, touchedKeys: ['crawlTasks'] });
  return d.crawlTasks;
}

function pickTasks(limit, region, category, regions = []) {
  const tasks = ensureTasks();
  const allowed = new Set(Array.isArray(regions) ? regions.filter(Boolean) : []);
  if (region || category || allowed.size) {
    return tasks
      .filter((t) => (!region || t.region === region) && (!allowed.size || allowed.has(t.region)) && (!category || t.keyword.includes(category)))
      .filter((t) => t.status !== 'paused')
      .filter((t) => t.status !== 'done' || region || category)
      .sort((a,b)=>(Number(b.priority)||0)-(Number(a.priority)||0))
      .slice(0, Math.max(1, limit));
  }
  return tasks.filter((t) => !['done','paused'].includes(t.status)).sort((a,b)=>(Number(b.priority)||0)-(Number(a.priority)||0)).slice(0, limit);
}

function showList() {
  const tasks = ensureTasks();
  const done = tasks.filter((t) => t.status === 'done').length;
  const rows = [];
  for (const t of tasks) {
    if (t.status !== 'done') rows.push(`  todo  ${t.id}`);
  }
  process.stdout.write(
    `任务总数 ${tasks.length}，已完成 ${done}，待跑 ${tasks.length - done}\n` + rows.slice(0, 30).join('\n') + (rows.length > 30 ? `\n  ... 其余 ${rows.length - 30} 项省略` : '') + '\n'
  );
  return { total: tasks.length, done, remaining: tasks.length - done };
}

function resetTasks() {
  const d = db.getDb();
  d.crawlTasks = buildTaskList();
  db.save({ externalWriter: true, touchedKeys: ['crawlTasks'] });
  process.stdout.write(`已重建任务队列：${d.crawlTasks.length} 个组合\n`);
  return { total: d.crawlTasks.length };
}


function enumCategoryMatches(keyword, item) {
  const cat = classifyCategory(`${item.title || ''} ${item.summary || ''}`);
  if (!cat) return false;
  if (/最低工资/.test(keyword)) return cat === '最低工资';
  if (/平均工资/.test(keyword)) return cat === '平均工资';
  if (/公积金/.test(keyword)) return cat === '公积金';
  if (/年金/.test(keyword)) return cat === '年金';
  if (/大病|医保/.test(keyword)) return cat === '大病医疗';
  if (/高温/.test(keyword)) return cat === '高温津贴';
  if (/残疾|残保/.test(keyword)) return cat === '残疾职工';
  if (/产假|育儿/.test(keyword)) return cat === '婚育相关';
  if (/病假/.test(keyword)) return cat === '病假工资';
  return false;
}

function enumMaxPagesForCompensation(mode='', lookbackDays=0) {
  const baseByMode = {
    'endpoint-retry':3,
    'alternate-entrypoint':4,
    'category-recheck':4,
    'pagination-backtrack':6,
    'site-search-fallback':3,
    'primary-recheck':4,
    'normative-library-recheck':5,
    'gazette-recheck':5,
    'rediscover-entrypoints':5,
  };
  const base=baseByMode[mode] || 3;
  const byLookback=lookbackDays ? Math.ceil(Number(lookbackDays)/20) : 0;
  return Math.max(3,Math.min(12,Math.max(base,byLookback)));
}

async function getEnumItemsForRegion(region, cache, compensationMode='', lookbackDays=0) {
  if (region === '全国') return { items: [], diagnostics: [], ok: true, allFailed: false };
  if (cache.has(region)) return cache.get(region);
  const p = provinceByKey(region);
  if (!p) return { items: [], diagnostics: [], ok: false, allFailed: true, error: '未知省份' };
  let result;
  try {
    // 常规 sweep 只取最近若干页；异常补偿/专用脚本再做深回溯。
    result = await enumerateProvinceDetailed(p.name, {
      maxPages:enumMaxPagesForCompensation(compensationMode,lookbackDays),
    });
  } catch (e) {
    console.log(`[enum] ${p.name} 枚举失败: ${e.message}`);
    result = { items: [], diagnostics: [{ label: `${p.name}枚举`, type: 'unknown', ok: false, failed: 1, lastError: e.message }], ok: false, allFailed: true, error: e.message };
  }
  cache.set(region, result);
  return result;
}

function newestDate(items, keys) {
  let best = '';
  for (const it of items || []) {
    for (const k of keys) {
      const v = String(it?.[k] || '').slice(0, 10);
      if (/^20\d{2}-\d{2}(?:-\d{2})?$/.test(v) && v > best) best = v;
    }
  }
  return best;
}

function updateSourceTelemetry(region, task, { enumResult=null, enumCount=0, searchCount=0, searchItems=[], added=0, error='' } = {}) {
  if (region === '全国') return;
  const d = db.getDb();
  if (!Array.isArray(d.sourceHealth)) d.sourceHealth = [];
  if (!Array.isArray(d.compensationQueue)) d.compensationQueue = [];
  const p = provinceByKey(region) || { key: region, name: region, root: '' };
  let row = d.sourceHealth.find((x) => x.region === region);
  if (!row) { row = { id: p.key, region, province: p.name, root: p.root, endpoints: [], consecutiveZeroNewRuns: 0, failedRuns24h: 0 }; d.sourceHealth.push(row); }
  const now = new Date().toISOString();
  row.lastRunAt = now;
  const enumDiags = enumResult?.diagnostics || [];
  row.endpoints = [
    { kind:'search', label:'搜索发现', lastHttpOk: !error, lastCheckedAt: now, lastError: error || '' },
    ...enumDiags.map((x) => ({
      kind:`official_${x.type || 'channel'}`,
      label:x.label || '官方来源',
      url:(x.urls || [])[0] || '',
      urls:x.urls || [],
      lastHttpOk: !!x.ok,
      lastCheckedAt:now,
      itemCount:x.itemCount || 0,
      failed:x.failed || 0,
      lastError:x.lastError || '',
      errors:x.errors || [],
    })),
  ];
  const enumAll = enumResult?.items || [];
  const latestOfficial = newestDate(enumAll, ['publishDate','releaseDate']);
  const latestSearch = newestDate(searchItems, ['releaseDate','publishDate']);
  if (latestOfficial) row.latestPrimaryPublishedAt = latestOfficial;
  if (latestSearch) row.latestSecondaryPublishedAt = latestSearch;
  const enumHardFail = enumDiags.length > 0 && enumDiags.every((x) => !x.ok);
  const combinedError = error || (enumHardFail ? (enumDiags.map((x)=>x.lastError).filter(Boolean).slice(-2).join('；') || '官方枚举入口全部失败') : '');
  if (combinedError && (!enumResult || enumHardFail)) {
    row.failedRuns24h = (row.failedRuns24h || 0) + 1;
    row.lastError = combinedError.slice(0, 500);
  } else {
    row.failedRuns24h = 0;
    row.lastError = combinedError.slice(0, 500);
  }
  if (!error && added === 0 && enumCount + searchCount === 0) row.consecutiveZeroNewRuns = (row.consecutiveZeroNewRuns || 0) + 1;
  else if (added > 0 || enumCount + searchCount > 0) row.consecutiveZeroNewRuns = 0;
  if (added > 0) row.lastDiscoveredAt = now;
  row.lastHits = enumCount + searchCount;
  row.lastAdded = added;
  row.enumItems = enumCount;
  row.searchItems = searchCount;
  const health = evaluateSourceHealth({ id:p.key, key:p.key, expectedUpdateDays:7 }, row);
  row.status = health.status; row.reason = health.reason;
  if (health.status === 'healthy') {
    // running 任务必须由整省补偿结束后的回调结单，不能被第一个类别的健康快照提前完成。
    for (const q of d.compensationQueue) if (q.region === region && ['queued','retry'].includes(q.status)) { q.status = 'done'; q.resolvedAt = now; }
  } else {
    for (const plan of buildCompensationPlan(p, health)) {
      if (!d.compensationQueue.some((q) => q.region === region && q.mode === plan.mode && ['queued','retry','running'].includes(q.status))) {
        d.compensationQueue.push({ id: db.uid('cmp'), ...plan, region, status:'queued', attempts:0, createdAt:now, nextRunAt:now });
      }
    }
  }
}

async function runBatch({ limit, region, regions=[], category, all, newCycle=false, compensationMode='', lookbackDays=0, mode='daily' }) {
  const crawlMode = normalizeCrawlMode(mode);
  let tasks = pickTasks(all ? 99999 : limit, region, category, regions);
  // 手动巡检完成一轮后必须停止，不自动 reset。
  // 只有 cron 显式传 --new-cycle 时，才会在上一轮全部 done 后开启下一周期。
  if (!tasks.length && !region && !category && newCycle) {
    console.log('上一轮矩阵已完成；定时调度开启新周期…');
    resetTasks();
    tasks = pickTasks(all ? 99999 : limit, region, category, regions);
  }
  if (!tasks.length) {
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: true, done: 0, hits: 0, added: 0, remaining: ensureTasks().filter((t) => t.status !== 'done').length, message: all ? '矩阵已全部巡检完毕' : '当前无待跑任务' }));
    return;
  }
  // 仅供端到端验收：让真实 sweep 子进程和锁保持一小段时间，测试停止/刷新恢复，
  // 同时避免隔离测试环境访问公网。生产默认值为 0，不改变正常巡检行为。
  const testHoldMs = Math.max(0, Math.min(30_000, Number(process.env.SWEEP_TEST_HOLD_MS || 0)));
  if (testHoldMs > 0) {
    const holdUntil = Date.now() + testHoldMs;
    while (Date.now() < holdUntil) {
      const stop = isSweepStopRequested(process.pid);
      if (stop) {
        process.stdout.write('\n__RESULT__' + JSON.stringify({ ok:false, stopped:true, done:0, hits:0, added:0, failed:0, remaining:tasks.length, error:'用户手动终止' }));
        return;
      }
      await sleep(Math.min(100, holdUntil - Date.now()));
    }
  }
  const crawler = require('../policy-api/src/crawler');
  const crawlQueue = db.getDb().crawlQueue;
  const existingUrls = new Set(crawlQueue.filter((c) => c.url).map((c) => canonicalizeUrl(c.url)));
  const enumCache = new Map();
  const existingIds = new Set(crawlQueue.map((c) => c.id));

  let hits = 0;
  let added = 0;
  let failed = 0;
  let aiExpanded = 0; // 统计 AI 扩了多少次
  const pipeline = { discovered:0, dateFiltered:0, qualityFiltered:0, duplicates:0, accepted:0 };

  // AI 扩词：为每个任务生成搜索变体词，提升命中率
  const aiExpansionEnabled = llm.llmEnabled();

  for (let i = 0; i < tasks.length; i++) {
    const stop = isSweepStopRequested(process.pid);
    if (stop) {
      const remaining = ensureTasks().filter((t) => t.status !== 'done').length;
      process.stdout.write('\n__RESULT__' + JSON.stringify({ ok:false, stopped:true, done:i, hits, added, failed, remaining, error:'用户手动终止' }));
      return;
    }
    const t = tasks[i];
    const label = `[${i + 1}/${tasks.length}] ${t.region} × ${t.keyword}`;
    t.status = 'running';
    t.lastRun = new Date().toISOString();
    db.save({ externalWriter:true, touchedKeys:['crawlTasks'] });
    try {
      // 先跑基础关键词；只有基础搜索无结果时才启用 AI 扩词兜底。
      // 旧逻辑“AI 3个变体 × 每个变体整套搜索”会把单格网络请求放大数十倍，容易把 4201 拖成假死。
      let items = [];
      let expanded = false;
      let searchError = '';
      try {
        const r = await withTimeout(runCrawlOnce(t.keyword, t.region), TASK_TIMEOUT_MS, `${label} 基础搜索`);
        if (!r.ok) searchError = r.error || '采集子进程失败';
        items = Array.isArray(r.items) ? r.items : [];
      } catch (e) {
        searchError = e.message || String(e);
        console.log(`[search] ${label} 基础搜索失败: ${searchError}`);
      }
      const baseItems = items.slice();

      if (items.length === 0 && aiExpansionEnabled && process.env.SWEEP_AI_FALLBACK !== 'false') {
        const terms = await llm.aiExpandSearchTerms({ province: t.region, category: t.keyword, count: 3 }).catch(() => null);
        if (terms && terms.length > 0) {
          console.log(`[AI] ${label} 基础搜索无结果，使用最多 2 个变体词兜底...`);
          for (const term of terms.slice(0, 2)) {
            const rr = await withTimeout(
              runCrawlOnce(term, t.region),
              TASK_TIMEOUT_MS,
              `${label} 变体词「${term}」`,
            ).catch((e) => ({ ok: false, items: [], error: e.message || String(e) }));
            if (!rr.ok && !searchError) searchError = rr.error || '';
            const extItems = Array.isArray(rr.items) ? rr.items : [];
            items = items.concat(extItems);
            if (extItems.length > 0) console.log(`[AI] 变体词「${term}」命中 ${extItems.length} 条`);
          }
          expanded = true;
          aiExpanded += Math.min(2, terms.length);
        }
      }

      // 搜索通道 + 官方栏目枚举通道同轮合并。枚举在 region 级缓存，一省 13 类只抓一次官网栏目。
      const searchCount = items.length;
      const enumResult = await withTimeout(
        getEnumItemsForRegion(t.region, enumCache, compensationMode, lookbackDays),
        TASK_TIMEOUT_MS,
        `${label} 官网栏目枚举`,
      ).catch((e) => {
        console.log(`[enum] ${label} 枚举超时/失败，跳过: ${e.message || e}`);
        return { items: [] };
      });
      const enumAll = enumResult.items || [];
      const enumMatched = [];
      let enumQualityFiltered = 0;
      for (const it of enumAll) {
        if (!enumCategoryMatches(t.keyword, it)) { enumQualityFiltered += 1; continue; }
        const categoryName = classifyCategory(it.title);
        const gate = judge({ title:it.title, url:it.url, category:categoryName, summary:it.summary || '', content:'' });
        if (gate.level === 'drop') { enumQualityFiltered += 1; continue; }
        enumMatched.push({
          id: db.uid('crawl'), status:'pending', createdAt:new Date().toISOString(), title:gate.title, region:t.region, summary:'', content:'',
          releaseDate:it.publishDate || '', effectiveDate:'', url:canonicalizeUrl(it.url), org:(provinceByKey(t.region)?.name || t.region) + '政府官网',
          source:'official_enum', category:categoryName, quality:gate.level, qualityReasons:gate.reasons, crawledBy:`enum-${t.region}`
        });
      }
      items = items.concat(enumMatched);
      let addN = 0;
      let dateFilteredN = 0;
      let duplicateN = 0;
      for (const it of items) {
        if (it.url) it.url = canonicalizeUrl(it.url);
        if (!queueDecision(it, crawlMode).accept) { dateFilteredN += 1; continue; }
        if (it.url && existingUrls.has(it.url)) { duplicateN += 1; continue; }
        if (it.id && existingIds.has(it.id)) { duplicateN += 1; continue; }
        it.crawlMode = crawlMode;
        it.batchRunAt = new Date().toISOString();
        crawlQueue.push(it);
        if (it.url) existingUrls.add(it.url);
        if (it.id) existingIds.add(it.id);
        addN += 1;
      }
      const taskPipeline = { discovered:items.length + enumQualityFiltered, dateFiltered:dateFilteredN, qualityFiltered:enumQualityFiltered, duplicates:duplicateN, accepted:addN };
      for (const key of Object.keys(pipeline)) pipeline[key] += taskPipeline[key];
      hits += items.length;
      updateSourceTelemetry(t.region, t, { enumResult, enumCount: enumMatched.length, searchCount, searchItems: items, added: addN, error: searchError });
      added += addN;
      t.status = 'done';
      t.lastRun = new Date().toISOString();
      t.hits = items.length;
      t.added = addN;
      t.pipeline = taskPipeline;
      t.crawlMode = crawlMode;
      const aiTag = expanded ? ' [AI扩词]' : '';
      console.log(`${label} → 发现 ${taskPipeline.discovered}，日期过滤 ${dateFilteredN}，质量过滤 ${enumQualityFiltered}，去重 ${duplicateN}，入池 ${addN}${aiTag}`);
    } catch (err) {
      failed += 1;
      t.status = 'error';
      t.lastRun = new Date().toISOString();
      t.error = String(err.message || err).slice(0, 200);
      updateSourceTelemetry(t.region, t, { error: String(err.message || err) });
      console.log(`${label} → 失败: ${err.message}`);
    }
    db.save({ externalWriter: true, touchedKeys: ['crawlQueue','crawlTasks','sourceHealth','compensationQueue'] });
    if (isSweepStopRequested(process.pid)) {
      const remaining = ensureTasks().filter((x) => x.status !== 'done').length;
      process.stdout.write('\n__RESULT__' + JSON.stringify({ ok:false, stopped:true, done:i + 1, hits, added, failed, remaining, error:'用户手动终止' }));
      return;
    }
    if (i < tasks.length - 1) await sleep(Math.max(0, Number(process.env.SWEEP_TASK_DELAY_MS || 500))); // 搜索内部已有节流，这里仅保留轻量间隔
  }
  const remaining = ensureTasks().filter((t) => t.status !== 'done').length;
  process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: true, done: tasks.length, hits, added, failed, remaining, aiExpanded, mode:crawlMode, pipeline }));
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = { limit: 15, region: '', regions:[], category: '', all: false, newCycle: false, compensationMode:'', lookbackDays:0, mode:'daily' };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[i + 1], 10) || 15;
    else if (argv[i] === '--region') args.region = argv[i + 1];
    else if (argv[i] === '--regions') args.regions = String(argv[++i] || '').split(',').map((x)=>x.trim()).filter(Boolean);
    else if (argv[i] === '--category') args.category = argv[i + 1];
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--new-cycle') args.newCycle = true;
    else if (argv[i] === '--compensation-mode') args.compensationMode = String(argv[++i] || '');
    else if (argv[i] === '--lookback-days') args.lookbackDays = Math.max(0,parseInt(argv[++i],10)||0);
    else if (argv[i] === '--mode') args.mode = normalizeCrawlMode(argv[++i]);
  }
  return { cmd, args };
}

(async () => {
  let lock = null;
  try {
    const { cmd, args } = parseArgs();
    if (args.compensationMode) process.env.COMPENSATION_MODE=args.compensationMode;
    if (args.lookbackDays) process.env.COMPENSATION_LOOKBACK_DAYS=String(args.lookbackDays);
    if (cmd === 'run') {
      lock = acquireSweepLock({ owner:process.env.SWEEP_OWNER || 'sweep-crawl', region:args.region, category:args.category });
      if (!lock.ok) {
        const holder = lock.lock || {};
        process.stdout.write('\n__RESULT__' + JSON.stringify({
          ok:false,
          busy:true,
          error:`已有巡检进程运行中（pid=${holder.pid || '?'}，region=${holder.region || 'all'}）`,
          lock:holder,
          items:[],
        }));
        process.exitCode = 2;
        return;
      }
    }
    if (cmd === 'list') showList();
    else if (cmd === 'reset') resetTasks();
    else if (cmd === 'run') await runBatch(args);
    else {
      process.stdout.write(
        '\n__RESULT__' +
          JSON.stringify({ ok: false, error: '用法: sweep-crawl.js <list|reset|run [--limit N|--all|--new-cycle|--region X --category Y]>', items: [] })
      );
      process.exitCode = 1;
    }
  } catch (err) {
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: false, error: err.message, items: [] }));
    process.exitCode = 1;
  } finally {
    if (lock && lock.ok) lock.release();
  }
})();
