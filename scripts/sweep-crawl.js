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

// 核心省清单（正式库里的主要覆盖对象；可在此增删）
const REGIONS = ['全国', '北京', '上海', '广东', '江苏', '浙江', '山东', '四川', '湖北', '河南', '福建', '湖南', '河北', '天津', '重庆', '安徽', '江西', '陕西', '辽宁', '黑龙江'];

// 每类一个搜索词（10 类中的薪酬月刊为人工内容，不爬）
const CATEGORY_KEYWORDS = [
  '最低工资标准',
  '平均工资 标准',
  '公积金 缴存基数',
  '企业年金 免税',
  '大病医疗 个税 扣除',
  '大病医疗 互助',
  '职工大病医保',
  '高温津贴 标准',
  '残疾人就业 减免',
  '残疾人 残保金',
  '残疾 就业保障金',
  '产假 育儿假 天数',
  '病假工资 标准',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (!Array.isArray(d.crawlTasks) || !d.crawlTasks.length) {
    d.crawlTasks = buildTaskList();
    db.save();
  }
  return d.crawlTasks;
}

function pickTasks(limit, region, category) {
  const tasks = ensureTasks();
  if (region || category) {
    const hit = tasks.find((t) => (!region || t.region === region) && (!category || t.keyword.includes(category)));
    return hit ? [hit] : [];
  }
  return tasks.filter((t) => t.status !== 'done').slice(0, limit);
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
  db.save();
  process.stdout.write(`已重建任务队列：${d.crawlTasks.length} 个组合\n`);
  return { total: d.crawlTasks.length };
}

async function runBatch({ limit, region, category, all }) {
  let tasks = pickTasks(all ? 99999 : limit, region, category);
  // 队列耗尽（上一轮全部标记 done）→ 自动重置开始新一轮巡检，捕捉期间新发布政策。
  // 定向补充（指定 region/category）不自动重置，避免误清空其它格子进度。
  if (!tasks.length && !region && !category) {
    console.log('任务队列已耗尽，自动重置并开始新一轮滚动巡检…');
    resetTasks();
    tasks = pickTasks(all ? 99999 : limit, region, category);
  }
  if (!tasks.length) {
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: true, done: 0, hits: 0, added: 0, remaining: ensureTasks().filter((t) => t.status !== 'done').length, message: all ? '矩阵已全部巡检完毕' : '当前无待跑任务' }));
    return;
  }
  const crawler = require('../policy-api/src/crawler');
  const crawlQueue = db.getDb().crawlQueue;
  const existingUrls = new Set(crawlQueue.filter((c) => c.url).map((c) => c.url));
  const existingIds = new Set(crawlQueue.map((c) => c.id));

  let hits = 0;
  let added = 0;
  let failed = 0;
  let aiExpanded = 0; // 统计 AI 扩了多少次
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const label = `[${i + 1}/${tasks.length}] ${t.region} × ${t.keyword}`;
    try {
      let items = await crawler.crawlPolicies({ keyword: t.keyword, region: t.region });
      // AI 扩展：基础词命中为0时，用 DeepSeek 生成变体词重新搜索（最多 2 轮）
      let expanded = false;
      if (items.length === 0 && llm.llmEnabled()) {
        const terms = await llm.aiExpandSearchTerms({ province: t.region, category: t.keyword, count: 3 }).catch(() => null);
        if (terms && terms.length > 0) {
          console.log(`[AI] ${label} 基础词无命中，尝试 ${terms.length} 个变体词...`);
          for (const term of terms) {
            const extItems = await crawler.crawlPolicies({ keyword: term, region: t.region }).catch(() => []);
            items = items.concat(extItems);
            if (extItems.length > 0) {
              console.log(`[AI] 变体词「${term}」命中 ${extItems.length} 条`);
            }
          }
          expanded = true;
          aiExpanded += terms.length;
        }
      }
      let addN = 0;
      for (const it of items) {
        if (it.url && existingUrls.has(it.url)) continue;
        if (existingIds.has(it.id)) continue;
        crawlQueue.push(it);
        if (it.url) existingUrls.add(it.url);
        existingIds.add(it.id);
        addN += 1;
      }
      if (addN) db.save();
      hits += items.length;
      added += addN;
      t.status = 'done';
      t.lastRun = new Date().toISOString();
      t.hits = items.length;
      t.added = addN;
      const aiTag = expanded ? ' [AI扩词]' : '';
      console.log(`${label} → 命中 ${items.length} 条，新入池 ${addN} 条${aiTag}`);
    } catch (err) {
      failed += 1;
      t.status = 'error';
      t.lastRun = new Date().toISOString();
      t.error = String(err.message || err).slice(0, 200);
      console.log(`${label} → 失败: ${err.message}`);
    }
    db.save();
    if (i < tasks.length - 1) await sleep(1200); // 防反爬限速
  }
  const remaining = ensureTasks().filter((t) => t.status !== 'done').length;
  process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: true, done: tasks.length, hits, added, failed, remaining, aiExpanded }));
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = { limit: 15, region: '', category: '', all: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[i + 1], 10) || 15;
    else if (argv[i] === '--region') args.region = argv[i + 1];
    else if (argv[i] === '--category') args.category = argv[i + 1];
    else if (argv[i] === '--all') args.all = true;
  }
  return { cmd, args };
}

(async () => {
  try {
    const { cmd, args } = parseArgs();
    if (cmd === 'list') showList();
    else if (cmd === 'reset') resetTasks();
    else if (cmd === 'run') await runBatch(args);
    else {
      process.stdout.write(
        '\n__RESULT__' +
          JSON.stringify({ ok: false, error: '用法: sweep-crawl.js <list|reset|run [--limit N|--all|--region X --category Y]>', items: [] })
      );
    }
    process.exit(0);
  } catch (err) {
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: false, error: err.message, items: [] }));
    process.exit(1);
  }
})();
