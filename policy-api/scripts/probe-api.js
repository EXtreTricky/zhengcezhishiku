'use strict';

/**
 * policy-api 只读闭环验证脚本 —— 浏览器同源访问前的接口体检。
 *
 * 用法：
 *   cd feishu-webapp
 *   node policy-api/scripts/probe-api.js              # 全量体检（stats/列表/分类/详情）
 *   node policy-api/scripts/probe-api.js --base http://127.0.0.1:4100
 */

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:4100';

let failures = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`✓ ${name}${detail ? `  ${detail}` : ''}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name}  ${err.message}`);
  }
}

async function main() {
  const j = async (path) => {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${path}`);
    return res.json();
  };

  // 1) 首页统计
  await check('dashboard/stats', async () => {
    const s = await j('/api/dashboard/stats');
    if (!Number.isFinite(s.totalPolicies) || s.totalPolicies <= 0) throw new Error('totalPolicies 异常');
    return `total=${s.totalPolicies} published=${s.publishedPolicies} categories=${s.byCategory.length} regions=${s.byRegion.length} recent=${s.recentUpdates.length}`;
  });

  // 2) 分类
  await check('policies/categories', async () => {
    const c = await j('/api/policies/categories');
    if (!Array.isArray(c) || c.length !== 10) throw new Error(`分类数异常: ${c.length}`);
    return c.join('/');
  });

  // 3) 列表（最低工资 + 分页字段）
  await check('policies 列表', async () => {
    const r = await j('/api/policies?category=%E6%9C%80%E4%BD%8E%E5%B7%A5%E8%B5%84&page=1&pageSize=2');
    const it = r.items && r.items[0];
    if (!it || !it.id || !it.title) throw new Error('items 结构异常');
    if (!it.id.startsWith('tbl')) throw new Error(`id 缺少表前缀: ${it.id}`);
    return `first="${it.title.slice(0, 30)}…" total=${r.total} hasMore=${r.hasMore}`;
  });

  // 4) 详情（取列表首条回查）
  await check('policies/:id 详情', async () => {
    const list = await j('/api/policies?page=1&pageSize=1');
    const id = list.items[0].id;
    const d = await j(`/api/policies/${id}`);
    if (d.id !== id || d.title !== list.items[0].title) throw new Error('详情与列表不一致');
    return `"${d.title.slice(0, 30)}…" sourceFields=${Object.keys(d.sourceFields || {}).length} content=${(d.content || '').length}B`;
  });

  // 5) 详情 404
  await check('policies/:id 404', async () => {
    const res = await fetch(`${BASE}/api/policies/nonexistent__recx`);
    if (res.status !== 404) throw new Error(`期望 404，实际 ${res.status}`);
    return 'ok';
  });

  // 6) 空态接口
  await check('versions/calendar 空态', async () => {
    const v = await j('/api/versions/policy/anything');
    const c = await j('/api/calendar/events');
    if (!Array.isArray(v) || !Array.isArray(c)) throw new Error('应为数组');
    return '[] / []';
  });

  // 7) 刷新（POST）
  await check('bitable/refresh', async () => {
    const res = await fetch(`${BASE}/api/bitable/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    if (!r.success) throw new Error('refresh 失败');
    return 'ok';
  });

  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('运行失败:', err.message);
  process.exit(1);
});
