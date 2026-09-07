'use strict';
/**
 * refetch-dates.js —— 重抓详情页补发布日期
 *
 * 用于 backfill-dates 仍补不出的条目（URL/标题/正文均无日期线索）。
 * 直接回源抓详情页，用 crawler.fetchPolicyText 提取 publishDate。
 *
 * 用法：node scripts/refetch-dates.js [--apply] [--limit N]
 * 默认 dry-run，加 --apply 写库。串行抓取，每条间隔 600ms 避免被限流。
 */
const pathMod = require('path');
try {
  require('dotenv').config({ path: pathMod.join(__dirname, '..', '.env') });
} catch (_) { /* dotenv 缺失时依赖外部 env */ }

const db = require(pathMod.join(__dirname, '..', 'src', 'db'));
const { fetchPolicyText } = require(pathMod.join(__dirname, '..', 'policy-api', 'src', 'crawler'));
const { backfillDate } = require(pathMod.join(__dirname, 'backfill-dates'));

const APPLY = process.argv.includes('--apply');
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1], 10) || 0;
const DELAY = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const store = db.getDb();
  const queue = store.crawlQueue || [];
  let targets = queue.filter((c) => c.status === 'pending' && !c.releaseDate && /^https?:/i.test(c.url || ''));
  if (LIMIT) targets = targets.slice(0, LIMIT);

  console.log(`═══ 重抓详情页补日期 ${APPLY ? '(写库)' : '(DRY-RUN)'} ═══`);
  console.log(`  目标条目 ${targets.length}\n`);

  let ok = 0;
  let fail = 0;
  const done = [];
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const tag = `[${i + 1}/${targets.length}]`;
    try {
      const page = await fetchPolicyText(c.url);
      // 优先详情页 publishDate，其次回退提取
      const d = page.publishDate || backfillDate({ url: c.url, title: page.title || c.title, content: page.text });
      if (d) {
        ok++;
        done.push({ c, date: d });
        console.log(`  ${tag} ✅ ${d}  ${(c.title || '').slice(0, 44)}`);
        if (APPLY) {
          c.releaseDate = d;
          // 顺带补全正文（枚举通道入池时 content 为空）
          if (!c.content && page.text) c.content = page.text.slice(0, 4000);
        }
      } else {
        fail++;
        console.log(`  ${tag} ⚪ 页面无日期  ${(c.title || '').slice(0, 44)}`);
      }
    } catch (e) {
      fail++;
      console.log(`  ${tag} ❌ ${String(e.message).slice(0, 30)}  ${(c.title || '').slice(0, 34)}`);
    }
    await sleep(DELAY);
  }

  console.log(`\n  ✅ 补出 ${ok}  |  ❌ 失败/无日期 ${fail}`);
  if (targets.length) console.log(`  → 成功率 ${((ok / targets.length) * 100).toFixed(1)}%`);
  if (APPLY) {
    db.save();
    console.log('  ✅ 已写库');
  }
}

main();
