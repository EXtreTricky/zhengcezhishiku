'use strict';
const BASE = 'http://127.0.0.1:4100';
let cookie = '';
async function req(method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
(async () => {
  await req('GET', '/auth/login');
  console.log('login ok:', !!cookie);

  const pending = await req('GET', '/api/crawl/crawled-pending');
  console.log('crawled-pending:', pending.data.total, '条 | stats:', JSON.stringify(pending.data.stats));
  const first = pending.data.items[0];
  if (!first) { console.log('(空，跳过后续)'); return; }
  console.log('first item:', first.id, '|', first.category, '|', first.title.slice(0, 30), '| matchStatus:', first.matchStatus);

  const ai = await req('POST', '/api/crawl/ai-extract', { recordId: first.id });
  console.log('ai-extract ->', ai.status, '| confidence:', ai.data.confidence);
  for (const f of ai.data.fields) {
    if (f.status !== 'match') console.log('   diff:', f.key, '| cur:', (f.current || '(空)').slice(0, 24), '-> ai:', (f.aiValue || '(空)').slice(0, 24), '|', f.status);
  }
  console.log('   (仅展示非 match 项；全部 match 表示 AI 与现有一致)');

  const apply = await req('POST', '/api/crawl/ai-apply', { recordId: first.id, updates: { summary: 'AI 复核摘要：标准与现行一致，待确认后入库（演示采纳）' } });
  console.log('ai-apply ->', apply.status, apply.data.success);

  const confirm = await req('POST', '/api/crawl/confirm', { recordId: first.id });
  console.log('confirm ->', confirm.status, '|', JSON.stringify(confirm.data).slice(0, 300));

  const outbox = await req('GET', '/api/bitable/sync-out');
  console.log('syncOutbox:', outbox.data.count, '条 |', outbox.data.items[0] ? 'op:' + outbox.data.items[0].kind + ' -> ' + outbox.data.items[0].category + ' | synced:' + outbox.data.items[0].synced : '');

  const syncTry = await req('POST', '/api/bitable/sync-out');
  console.log('sync-out retry ->', syncTry.status, JSON.stringify(syncTry.data).slice(0, 200));

  const compare = await req('POST', '/api/crawl/compare', { keyword: '最低工资', region: '北京' });
  console.log('compare 最低工资/北京 -> hits:', compare.data.total);

  const pending2 = await req('GET', '/api/crawl/crawled-pending');
  console.log('crawled-pending after confirm:', pending2.data.total, '条（confirm 那条已移出）');
})();
