'use strict';
/**
 * clean-noise.js —— 清理待确认池存量噪音
 *
 * 策略（保守，宁可留不可错杀）：
 *   1. judge() 判 drop 的（自媒体源/站名页）→ ignored
 *   2. 年金类事务性公告（评选/招标/采购/受托人/管理信息/新增计划）→ ignored
 *   3. 明确无政策价值的（站名页、纯问答查询页）→ ignored
 *   4. 其余（真政策但无抽取建议值 / 标题截断 / 征求意见稿）→ 标记人工复核通过，回到主列表
 *
 * 用法：node scripts/clean-noise.js [--apply]
 * 默认 dry-run，加 --apply 才写库。
 */
const pathMod = require('path');
const db = require(pathMod.join(__dirname, '..', 'src', 'db'));
const { judge } = require(pathMod.join(__dirname, '..', 'policy-api', 'src', 'quality-gate'));

const APPLY = process.argv.includes('--apply');

// 高置信噪音：年金事务性公告（评选/招标/采购/受托人/信息披露/新增计划等）
const ANNUITY_NOISE =
  /(评选|中标|招标|投标|采购|磋商|成交|询价|遴选|邀请函|比选|会计师事务所|审计服务|托管银行|归集账户|受托人|受托机构|投资管理人|账户管理人|信息披露|管理情况|管理信息|基金信息|基金管理|运行情况|选树|招聘月|新增.{0,6}计划|增设.{0,6}计划)/;
// 明确无政策价值：站名页 / 纯查询问答
const WORTHLESS = /^(全国\s*)?国家政务服务平台|是多少[？?]?$|多少钱[？?]?$|查询$/;

const store = db.getDb();
const queue = store.crawlQueue || [];
let st = { drop: 0, annuity: 0, worthless: 0, keep: 0, relabel: 0 };
const ignored = [];
const relabeled = [];

for (const c of queue) {
  if (c.status !== 'pending') continue;
  const title = c.title || '';
  const g = judge({ title, url: c.url || '', category: c.category, summary: c.summary || '', content: c.content || '', valuesSuggest: c.valuesSuggest || [] });

  // 1) 源头垃圾
  if (g.level === 'drop') {
    st.drop++;
    ignored.push({ c, why: g.reasons.join('；') });
    if (APPLY) c.status = 'ignored';
    continue;
  }
  // 2) 年金事务性公告（排除真正的管理办法/指导意见）
  if (
    c.category === '年金' &&
    ANNUITY_NOISE.test(title) &&
    !/(管理办法|监管办法|指导意见|暂行规定|实施细则|若干意见)/.test(title)
  ) {
    st.annuity++;
    ignored.push({ c, why: '年金事务性公告（非政策本体）' });
    if (APPLY) c.status = 'ignored';
    continue;
  }
  // 3) 明确无价值
  if (WORTHLESS.test(title.replace(/^\S+省\s*/, '')) || /国家政务服务平台/.test(title)) {
    st.worthless++;
    ignored.push({ c, why: '站名页/查询页，无政策价值' });
    if (APPLY) c.status = 'ignored';
    continue;
  }
  // 4) 其余：真政策 → 若此前被判 suspect，标记人工复核通过，回到主列表
  st.keep++;
  if (g.level === 'suspect') {
    st.relabel++;
    relabeled.push({ c, why: g.reasons.join('；') });
    if (APPLY) {
      c.quality = 'pass';
      c.qualityReasons = ['人工复核：确认为政策条目'];
    }
  }
}

console.log(APPLY ? '═══ 执行清理（已写库）═══' : '═══ DRY-RUN（未写库，加 --apply 执行）═══');
console.log(`  忽略 · 源头垃圾(drop)      ${st.drop}`);
console.log(`  忽略 · 年金事务性公告      ${st.annuity}`);
console.log(`  忽略 · 站名/查询页         ${st.worthless}`);
console.log(`  保留 · 真政策              ${st.keep}（其中 ${st.relabel} 条从存疑改判通过）`);
console.log(`  ── 合计忽略 ${st.drop + st.annuity + st.worthless} 条，保留 ${st.keep} 条`);

if (!APPLY) {
  console.log('\n──── 将忽略的条目 ────');
  ignored.forEach((x) => console.log(`  [${x.c.category}] ${(x.c.region || '')} ${x.c.title.slice(0, 48)}\n        ↳ ${x.why}`));
  console.log('\n──── 改判通过（回到主列表）────');
  relabeled.forEach((x) => console.log(`  [${x.c.category}] ${(x.c.region || '')} ${x.c.title.slice(0, 48)}`));
} else {
  db.save();
  console.log('\n✅ 已写库');
}
