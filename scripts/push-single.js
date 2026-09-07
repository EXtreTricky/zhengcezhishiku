#!/usr/bin/env node
/**
 * push-single.js —— 把指定 URL 单条精准 push 进 crawlQueue（不写正文、不抓详情，留给审批台 / 后续候选形态）
 *
 * 用法: node scripts/push-single.js --url <URL> --title <TITLE> --category <CAT> --region <省/直辖市>
 * 例:   node scripts/push-single.js \
 *         --url https://hrss.gd.gov.cn/...post_3459289.html \
 *         --title "关于印发《关于高温津贴发放的管理办法》的通知" \
 *         --category 高温津贴 --region 广东省
 */
const pathMod = require('path');
try { require('dotenv').config({ path: pathMod.join(__dirname, '..', '.env') }); } catch (_) {}

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const m = /^--(\w[\w-]*)(?:=(\S+))?$/.exec(argv[i]);
  if (!m) continue;
  args[m[1]] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
}

const db = require('../src/db');

function parseArgs() {
  const argv = process.argv.slice(2);
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w[\w-]*)(?:=(\S+))?$/.exec(argv[i]);
    if (!m) continue;
    a[m[1]] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return {
    url: a.url,
    title: a.title,
    category: a.category,
    region: a.region,
    date: a.date || '',
    crawledBy: a.by || 'enum-guangdong-2012',
  };
}

const { url, title, category, region, date, crawledBy } = parseArgs();

if (!url || !title || !category || !region) {
  console.log('必填 --url --title --category --region  (--date --by 可选)');
  process.exit(1);
}

const queue = db.getDb().crawlQueue || [];

// 防止重复入库
if (queue.some((c) => c.url === url)) {
  console.log(`已在待确认池：${url}`);
  process.exit(0);
}

const now = new Date().toISOString();
const id = 'crw_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 8);

queue.push({
  id,
  status: 'pending',
  createdAt: now,
  title: title.slice(0, 80),
  region,
  summary: '',
  content: '',
  releaseDate: date,
  effectiveDate: '',
  url,
  org: '广东省人力资源和社会保障厅',
  source: '',
  category,
  amount: '',
  documentNumber: '',
  crawledBy,
});

db.save();
console.log(`✅ 进池成功 id=${id}  category=${category}  region=${region}`);
console.log(`   title=${title.slice(0, 60)}`);
console.log(`   url=${url}`);
console.log(`   当前 crawlQueue: ${queue.length} 条`);
