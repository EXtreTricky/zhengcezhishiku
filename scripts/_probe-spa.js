'use strict';
// 探测 4100 网关当前托管的 SPA：/ 与首个 /assets/*.js 是否真正可达（记录状态码与字节数）
const BASE = 'http://127.0.0.1:4100';
async function probe() {
  const home = await fetch(BASE + '/');
  const html = await home.text();
  console.log('[home]', home.status, 'bytes=', html.length, 'title=', (html.match(/<title>([^<]*)<\/title>/) || [])[1]);
  const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
  if (!m) { console.log('[asset] 首页中未发现 /assets/*.js'); return; }
  const url = BASE + m[1];
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  console.log('[asset]', r.status, 'bytes=', buf.length, 'url=', url);
  console.log('[asset] head:', buf.slice(0, 120).toString('utf8').replace(/\n/g, ' '));
  // 再探测一个 API
  const api = await fetch(BASE + '/api/dashboard/stats');
  console.log('[api] /api/dashboard/stats ->', api.status, (await api.text()).slice(0, 160));
  const me = await fetch(BASE + '/api/me');
  console.log('[api] /api/me ->', me.status, (await me.text()).slice(0, 160));
}
probe().catch((e) => { console.error('ERR', e.message); process.exit(1); });
