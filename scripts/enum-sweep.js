/**
 * enum-sweep.js —— 省级栏目「枚举式发现」试点（发现层对账）
 *
 * 用法:
 *   node scripts/enum-sweep.js --region 广东 [--pages 6] [--since 2024-01-01] [--write]
 *
 * 默认 dry-run：枚举栏目全量 → classifyCategory 筛出 10 类白名单命中
 *   → 与待确认池 db.crawlQueue 的 URL 对账 → 报告"全新候选"清单，不写任何库。
 * 加 --write 才把「全新命中」push 进 crawlQueue（进审批台待确认池）。
 */
// 先加载根 .env（policy-api/src/crawl-api → auth 顶层检查 FEISHU_*，缺 env 会 fatal）
const pathMod = require('path');
try {
  require('dotenv').config({ path: pathMod.join(__dirname, '..', '.env') });
} catch (e) { /* dotenv 缺失时依赖外部 env */ }

const db = require('../src/db');
const { classifyCategory } = require('../policy-api/src/crawl-api');
const { enumerateProvince, registeredProvinces } = require('../policy-api/src/enum-sources');

const PROV_MAP = { 广东: '广东省', 北京: '北京市', 上海: '上海市', 江苏: '江苏省', 浙江: '浙江省', 山东: '山东省', 四川: '四川省', 湖北: '湖北省', 河南: '河南省', 福建: '福建省', 湖南: '湖南省', 河北: '河北省', 天津: '天津市', 重庆: '重庆市' };
const PROV_ORG = {
  广东省: '广东省人力资源和社会保障厅',
  福建省: '福建省人力资源和社会保障厅',
  江苏省: '江苏省人力资源和社会保障厅',
  浙江省: '浙江省人力资源和社会保障厅',
  四川省: '四川省人力资源和社会保障厅',
  北京市: '北京市人力资源和社会保障局',
  上海市: '上海市人力资源和社会保障局',
  天津市: '天津市人力资源和社会保障局',
  重庆市: '重庆市人力资源和社会保障局',
  山东省: '山东省人力资源和社会保障厅',
  湖北省: '湖北省人力资源和社会保障厅',
  河南省: '河南省人力资源和社会保障厅',
  湖南省: '湖南省人力资源和社会保障厅',
  河北省: '河北省人力资源和社会保障厅',
};

function parseArgs(argv) {
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
  };
  return {
    region: get('--region') || '广东',
    pages: parseInt(get('--pages') || '0', 10) || 0,
    since: get('--since') || '',
    write: argv.includes('--write'),
  };
}

async function main() {
  const { region, pages, since, write } = parseArgs(process.argv.slice(2));
  const province = PROV_MAP[region] || region;
  if (!registeredProvinces().includes(province)) {
    console.log(`未注册栏目源: ${province}；现有: ${registeredProvinces().join('/')}`);
    process.exit(1);
  }
  console.log(`\n== 枚举栏目: ${province}（页数上限 ${pages || '全量'}、since=${since || '不限'}）==`);
  const started = Date.now();
  const list = await enumerateProvince(province, {
    maxPages: pages || undefined,
    since: since || undefined,
    onPage: (p, total, got) => console.log(`  第${p}/${total}页 → ${got} 条`),
  });
  console.log(`  枚举完成：${list.length} 条（${((Date.now() - started) / 1000).toFixed(1)}s）`);

  // 分类命中（仅按标题；标题不含类别词的正文型条目此处如实漏过，报告中说明）
  const hitMap = new Map(); // url → {item, category}
  for (const it of list) {
    const cat = classifyCategory(it.title);
    if (cat && cat !== '薪酬月刊') hitMap.set(it.url, { item: it, category: cat });
  }

  // 与待确认池 URL 对账
  const queue = db.getDb().crawlQueue || [];
  const existing = new Set(queue.filter((c) => c.url).map((c) => c.url));
  const hits = [...hitMap.values()];
  const fresh = hits.filter((h) => !existing.has(h.item.url));

  // 报告
  console.log('\n== 分类命中分布 ==');
  const byCat = {};
  for (const h of hits) byCat[h.category] = (byCat[h.category] || 0) + 1;
  for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`\n== 对账 ==`);
  console.log(`  白名单命中 ${hits.length} 条 | 已在待确认池 ${hits.length - fresh.length} | 全新候选 ${fresh.length}`);
  console.log(`  （说明：命中=标题可判定类别；判定不到不代表文件不存在对应政策，仅代表该栏目标题不含类别词）`);

  if (fresh.length) {
    console.log(`\n== 全新候选样例（前 25 条，按发布日期倒序）==`);
    fresh
      .sort((a, b) => String(b.item.publishDate).localeCompare(String(a.item.publishDate)))
      .slice(0, 25)
      .forEach((h, i) => {
        console.log(`  ${String(i + 1).padStart(2)} [${h.category}] ${h.item.publishDate} ${h.item.title.slice(0, 56)}`);
        console.log(`     ${h.item.url}`);
      });
  }

  if (write && fresh.length) {
    const now = new Date().toISOString();
    const uid = () => 'crw_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 8);
    let pushed = 0;
    let dropped = 0;
    for (const h of fresh) {
      const fullTitle = h.item.title.slice(0, 80);
      // 入池质量闸门（与搜索通道同一规则，见 policy-api/src/quality-gate.js）
      const gate = require('../policy-api/src/quality-gate').judge({
        title: fullTitle,
        url: h.item.url,
        category: h.category,
        summary: '',
        content: '',
        valuesSuggest: [],
      });
      if (gate.level === 'drop') {
        console.log(`  [gate] 丢弃「${fullTitle.slice(0, 34)}」→ ${gate.reasons.join('；')}`);
        dropped++;
        continue;
      }
      queue.push({
        id: uid(),
        status: 'pending',
        createdAt: now,
        title: gate.title,
        region: province,
        summary: '',
        content: '',
        releaseDate: h.item.publishDate || '',
        effectiveDate: '',
        url: h.item.url,
        org: PROV_ORG[province] || `${province}人力资源和社会保障厅`,
        source: '',
        category: h.category,
        amount: '',
        documentNumber: '',
        quality: gate.level,
        qualityReasons: gate.reasons,
        crawledBy: `enum-${province}`,
      });
      pushed++;
    }
    console.log(`  [gate] 丢弃 ${dropped} 条噪音，实际入库 ${pushed} 条`);
    db.save();
    console.log(`\n✅ 已进待确认池 ${pushed} 条（crawledBy=enum-${province}），可在审批台查看。`);
  } else if (write) {
    console.log('\n（--write 已指定，但无全新候选可进池）');
  } else {
    console.log('\n（dry-run：未写库。确认后加 --write 进待确认池）');
  }
}

main().catch((e) => {
  console.error('enum-sweep 失败:', e);
  process.exit(1);
});
