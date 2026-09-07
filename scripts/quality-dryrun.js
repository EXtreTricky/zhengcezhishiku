'use strict';
/**
 * 质量闸门 dry-run：对现有待审批池跑一遍规则，输出统计与逐条判定。
 * 用法：node scripts/quality-dryrun.js [--show=drop|suspect|pass|all]
 */
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const { judgeAll } = require(path.join(__dirname, '..', 'policy-api', 'src', 'quality-gate'));

const argShow = (process.argv.find((a) => a.startsWith('--show=')) || '--show=all').split('=')[1];

const store = db.getDb();
const pending = (store.crawlQueue || []).filter((c) => c.status === 'pending');

const res = judgeAll(pending);

console.log('════════ 质量闸门 dry-run ════════');
console.log(`总计 ${res.stat.total} 条`);
console.log(`  ✅ pass    通过 ${res.stat.pass}`);
console.log(`  ⚠️  suspect 存疑 ${res.stat.suspect}`);
console.log(`  🗑️  drop    丢弃 ${res.stat.drop}`);
console.log('');

const show = (level, list, icon) => {
  if (argShow !== 'all' && argShow !== level) return;
  if (!list.length) return;
  console.log(`────── ${icon} ${level.toUpperCase()} (${list.length}) ──────`);
  for (const r of list) {
    const c = r.item;
    const prov = (c.region || '').replace(/[省市壮族回族维吾尔自治区]+$/, '');
    console.log(`[${c.category}] ${prov} ${c.title.slice(0, 52)}`);
    console.log(`         ↳ ${r.reasons.join('；')}`);
  }
  console.log('');
};

show('drop', res.drop, '🗑️');
show('suspect', res.suspect, '⚠️');
show('pass', res.pass, '✅');

// 误杀抽查：drop/suspect 里如果包含强政策文体词的，重点提示
console.log('════════ 误杀风险抽查（被判 drop/suspect 但含政策文体词）════════');
const { POLICY_FORM_WORDS } = require(path.join(__dirname, '..', 'policy-api', 'src', 'quality-gate'));

let risky = 0;
for (const r of [...res.drop, ...res.suspect]) {
  const t = r.item.title || '';
  const hit = POLICY_FORM_WORDS.filter((w) => t.includes(w));
  const strong = hit.filter((w) => ['办法', '规定', '条例', '实施细则', '指导意见', '通告', '决定'].includes(w));
  if (strong.length) {
    risky++;
    console.log(`  ⚠ [${r.level}] [${r.item.category}] ${t.slice(0, 56)}`);
    console.log(`       文体词命中: ${strong.join(',')} | 判定理由: ${r.reasons.join('；')}`);
  }
}
if (!risky) console.log('  无（未发现强文体词被误判）');
