'use strict';
/**
 * backfill-dates.js —— 发布日期回退提取
 *
 * 枚举通道从栏目列表页抓到的条目常缺发布日期（列表不显示日期）。
 * 本脚本按「URL 日期路径 → 标题 → 正文」三级回退补日期。
 *
 * 用法：node scripts/backfill-dates.js [--apply]
 * 默认 dry-run，加 --apply 写库。
 */
const pathMod = require('path');
const db = require(pathMod.join(__dirname, '..', 'src', 'db'));

const APPLY = process.argv.includes('--apply');

/** 从 URL 路径提取日期：政府站普遍把日期编进路径/文件名 */
function dateFromUrl(url) {
  const u = String(url || '');
  // /2026/5/9/ 或 /2026-05-09/
  let m = u.match(/\/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})(?:[\/-_]|$)/);
  if (m) return fmt(m[1], m[2], m[3]);
  // /t20250225_ 或 /content_20250225_
  m = u.match(/\/t?(20\d{2})(\d{2})(\d{2})[_.\-]/);
  if (m) return fmt(m[1], m[2], m[3]);
  // /202502/ （年月）
  m = u.match(/\/(20\d{2})(\d{2})(?:[\/-]|$)/);
  if (m) return fmt(m[1], m[2]);
  // /2026/ （仅年）
  m = u.match(/\/(20\d{2})(?:[\/-]|$)/);
  if (m) return m[1];
  // post_20260509_
  m = u.match(/[_-](20\d{2})(\d{2})(\d{2})[_-]/);
  if (m) return fmt(m[1], m[2], m[3]);
  return '';
}

/** 从标题提取日期 */
function dateFromTitle(title) {
  const t = String(title || '');
  let m = t.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (m) return fmt(m[1], m[2], m[3]);
  m = t.match(/(20\d{2})年(\d{1,2})月/);
  if (m) return fmt(m[1], m[2]);
  m = t.match(/(20\d{2})年度/);
  if (m) return m[1];
  m = t.match(/(20\d{2})年/);
  if (m) return m[1];
  // 「9月1日起实施」这类无年份的，取标题中出现的年份兜底
  const y = t.match(/(20\d{2})/);
  m = t.match(/(\d{1,2})月(\d{1,2})日/);
  if (m && y) return fmt(y[1], m[1], m[2]);
  return '';
}

/** 从正文提取日期（正文常含「自2026年9月1日起施行」） */
function dateFromContent(content) {
  const c = String(content || '').slice(0, 3000);
  let m = c.match(/(?:自|于|印发日期[:：]?\s*)?\s*(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (m) return fmt(m[1], m[2], m[3]);
  m = c.match(/(20\d{2})年(\d{1,2})月/);
  if (m) return fmt(m[1], m[2]);
  return '';
}

function fmt(y, m, d) {
  const mm = String(Number(m)).padStart(2, '0');
  if (!d) return `${y}-${mm}`;
  return `${y}-${mm}-${String(Number(d)).padStart(2, '0')}`;
}

/** 综合回退：URL > 标题 > 正文 */
function backfillDate(item) {
  return (
    dateFromUrl(item.url) ||
    dateFromTitle(item.title) ||
    dateFromContent(item.content) ||
    ''
  );
}

module.exports = { backfillDate, dateFromUrl, dateFromTitle, dateFromContent };

// ── 主流程（仅直接运行时执行，被 require 时不跑）──
if (require.main === module) {
  const store = db.getDb();
  const queue = store.crawlQueue || [];
  const missing = queue.filter((c) => c.status === 'pending' && !c.releaseDate);

  let filled = 0;
  let stillMissing = 0;
  const results = [];
  for (const c of missing) {
    const d = backfillDate(c);
    if (d) {
      filled++;
      results.push({ c, date: d, src: dateFromUrl(c.url) ? 'URL' : dateFromTitle(c.title) ? '标题' : '正文' });
      if (APPLY) c.releaseDate = d;
    } else {
      stillMissing++;
    }
  }

  console.log(APPLY ? '═══ 已写库 ═══' : '═══ DRY-RUN（加 --apply 写库）═══');
  console.log(`  缺日期条目   ${missing.length}`);
  console.log(`  ✅ 成功补出  ${filled}`);
  console.log(`  ❌ 仍缺失    ${stillMissing}`);
  if (missing.length) console.log(`  → 补全率     ${((filled / missing.length) * 100).toFixed(1)}%`);

  if (!APPLY) {
    console.log('\n──── 补出示例（前 25）────');
    results.slice(0, 25).forEach((r) =>
      console.log(`  ${r.date.padEnd(11)} [${r.src}] ${(r.c.title || '').slice(0, 46)}`),
    );
    if (stillMissing) {
      console.log('\n──── 仍缺日期（需重抓详情页）────');
      missing
        .filter((c) => !backfillDate(c))
        .slice(0, 12)
        .forEach((c) => console.log(`  [${c.category}] ${(c.title || '').slice(0, 50)}`));
    }
  } else {
    db.save();
  }
}
