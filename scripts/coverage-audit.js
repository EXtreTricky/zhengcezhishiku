#!/usr/bin/env node
/**
 * coverage-audit.js —— 政策知识库覆盖率审计（按 15地区 × 10类别 矩阵）
 *
 * 用法:
 *   node scripts/coverage-audit.js [--out coverage.json] [--include-queue]
 *
 * 数据源: 4201 实例 /api/policies（聚合后的飞书全表）。
 *        加 --include-queue 同时把 src/db.js 的 crawlQueue（审批前暂存）合并入矩阵，
 *        在飞书写权限 91403 阶段可看「批准后预估覆盖率」会变多少。
 * 目标: 把现状打成矩阵 + 覆盖率% + 缺哪几格 + 给出补全建议
 */
const http = require('http');

function getJson(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://127.0.0.1:4201');
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const t = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(t) });
          } catch (e) {
            resolve({ status: res.statusCode, raw: t.slice(0, 300) });
          }
        });
        res.on('error', reject);
      })
      .on('error', reject)
      .setTimeout(20000, function () {
        this.destroy(new Error('timeout'));
      });
  });
}

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const m = /^--(\w[\w-]*)(?:=(\S+))?$/.exec(a);
  if (!m) continue;
  args[m[1]] = m[2] !== undefined ? m[2] : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}

const PAGE = parseInt(args.page || '1000', 10);

const REGIONS = [
  '全国',
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南',
  '四川', '贵州', '云南', '陕西', '甘肃', '青海',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
];
const CATEGORIES = [
  '最低工资', '平均工资', '公积金', '年金', '大病医疗',
  '高温津贴', '残疾职工', '婚育相关', '病假工资', '薪酬月刊',
];

(async () => {
  console.log(`==> 拉取 /api/policies?pageSize=${PAGE}`);
  const r = await getJson(`/api/policies?pageSize=${PAGE}`);
  if (!r.json || !Array.isArray(r.json.items)) {
    console.log('   ✗ 接口未返回 items，请确认 4201 是否活着。 raw:', r.raw);
    process.exit(1);
  }
  const all = r.json.items;
  console.log(`   ✓ ${all.length} 条（pageSize=${PAGE},hasMore=${r.json.hasNextPage}）`);

  // 是否合并 crawlQueue（预估"批准入库"后）
  let queueItems = [];
  if (args['include-queue']) {
    try {
      const db = require('../src/db');
      const q = (db.getDb().crawlQueue || []);
      queueItems = q.map((c) => ({
        // 归一到审计字段：applicableRegion / topicCategory / region / category
        applicableRegion: c.region || c.applicableRegion || '',
        topicCategory: c.category || c.topicCategory || '',
        region: c.region || '',
        category: c.category || '',
      }));
      console.log(`   + crawlQueue 合并 ${queueItems.length} 条（待确认池，--include-queue）`);
    } catch (e) {
      console.log('   ! crawlQueue 合并失败:', e.message);
    }
  }
  const merged = all.concat(queueItems);

  // 区域归一化：广东/广州→广东；江苏/苏州→江苏；等等。把不规范的归到最近母省。
  const regionAlias = (s) => {
    if (!s) return '';
    for (const r of REGIONS) if (s.includes(r)) return r;
    if (s.includes('全国') || s.includes('中央')) return '全国';
    return s.slice(0, 6);
  };

  // 统计矩阵
  const matrix = {};
  for (const cat of CATEGORIES) matrix[cat] = {};
  for (const cat of CATEGORIES) for (const reg of REGIONS) matrix[cat][reg] = 0;
  matrix._other = {}; // 不在 15 地区的另外打堆

  const allRegions = new Set();
  for (const p of merged) {
    const reg = regionAlias(p.applicableRegion || p.region || '');
    const cat = p.topicCategory || p.category || '其他';
    allRegions.add(reg);
    if (matrix[cat] && REGIONS.includes(reg)) matrix[cat][reg]++;
    else {
      const key = reg || '(空)';
      if (!matrix._other[key]) matrix._other[key] = 0;
      matrix._other[key]++;
    }
  }

  // 总数 / 格子数
  const cells = CATEGORIES.length * REGIONS.length; // 150
  let filled = 0;
  for (const cat of CATEGORIES) for (const reg of REGIONS) if (matrix[cat][reg] > 0) filled++;
  const coveragePct = ((filled / cells) * 100).toFixed(1);

  // 按列(row)输出
  console.log('\n== 矩阵：行=类别  列=地区（值=记录条数，0 表示该格空） ==');
  const hdr = ['类别'.padEnd(8), ...REGIONS.map((r) => r.slice(0, 4).padStart(4)), '小计'.padStart(5)];
  console.log('           ' + hdr.join(' '));
  let tot = 0;
  for (const cat of CATEGORIES) {
    let rowTot = 0;
    const row = REGIONS.map((reg) => {
      const v = matrix[cat][reg] || 0;
      rowTot += v;
      return (v > 0 ? String(v) : '·').padStart(4);
    });
    console.log(cat.padEnd(8) + ' ' + row.join(' ') + String(rowTot).padStart(5));
    tot += rowTot;
  }
  const colTotals = REGIONS.map((reg) =>
    CATEGORIES.reduce((s, c) => s + (matrix[c][reg] || 0), 0),
  );
  console.log('合计'.padEnd(8) + ' ' + colTotals.map((v) => (v > 0 ? String(v) : '·').padStart(4)).join(' ') + String(tot).padStart(5));

  // 覆盖率
  console.log(`\n== 覆盖率：${filled}/${cells} 格命中 = ${coveragePct}%（"命中" 指 ≥1 条） ==`);

  // 空缺列出来（前 30）
  const gaps = [];
  for (const cat of CATEGORIES) for (const reg of REGIONS) if (!matrix[cat][reg]) gaps.push({ cat, reg });
  gaps.sort((a, b) => a.cat.localeCompare(b.cat));
  console.log(`\n== 完全空白格子 ${gaps.length} 个（按类别聚合） ==`);
  const gapByCat = {};
  for (const g of gaps) gapByCat[g.cat] = (gapByCat[g.cat] || 0) + 1;
  for (const [c, n] of Object.entries(gapByCat).sort((a, b) => b[1] - a[1])) console.log(`   ${c}: ${n}/15 地区空缺`);

  // 收尾：异常 region
  console.log(`\n== 发现的 region 集合（去重）==`);
  console.log('   ', [...allRegions].filter(Boolean).join('、'));
  if (Object.keys(matrix._other).length) {
    console.log('\n== 不在 15 地区矩阵里的 region（可能是市/特殊名） ==');
    for (const [k, v] of Object.entries(matrix._other).sort((a, b) => b[1] - a[1]).slice(0, 20))
      console.log(`   ${k.padEnd(8)} ${v}`);
  }

  if (args.out) {
    require('fs').writeFileSync(args.out, JSON.stringify({ total: all.length, matrix, coveragePct, filled, cells }, null, 2));
    console.log(`\n✓ 写入 ${args.out}`);
  }
})().catch((e) => {
  console.error('audit failed:', e);
  process.exit(1);
});
