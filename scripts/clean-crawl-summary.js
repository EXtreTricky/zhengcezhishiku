/**
 * 清理爬虫汇总表（秒搭旧数据）
 * 汇总表定位=待确认暂存区，全量删除不影响正式政策库（专题表在别的 Base）。
 * 用法: node scripts/clean-crawl-summary.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// 从 .env 读凭据
const envPath = path.join(__dirname, '..', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const APP_ID = env.FEISHU_APP_ID;
const APP_SECRET = env.FEISHU_APP_SECRET;
const APP_TOKEN = 'CulNbDPMkaiuiNs10u8cY6Uenbd';
const TABLE_ID = 'tblWaFr1oX0Tg6tt';

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'open.feishu.cn',
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { reject(new Error('bad json: ' + buf.slice(0, 200))); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1. token
  const tk = await request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET,
  });
  if (tk.code !== 0) throw new Error('token失败: ' + JSON.stringify(tk));
  const token = tk.tenant_access_token;
  console.log('[1/3] token OK');

  // 2. 列出全部记录
  let pageToken = '';
  const all = [];
  do {
    const q = `page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
    const r = await request('GET', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${q}`, null, token);
    if (r.code !== 0) throw new Error('list失败: ' + JSON.stringify(r));
    all.push(...(r.data.items || []));
    pageToken = r.data.has_more ? r.data.page_token : '';
  } while (pageToken);
  console.log(`[2/3] 共 ${all.length} 条记录:`);
  for (const it of all) {
    const f = it.fields || {};
    const title = f['政策标题'] || f['标题'] || f['事项'] || JSON.stringify(f).slice(0, 60);
    console.log('  -', it.record_id, String(title).slice(0, 50));
  }
  if (all.length === 0) { console.log('[3/3] 无记录，无需删除'); return; }

  // 3. 批量删除（每次最多500条）
  const ids = all.map((x) => x.record_id);
  const del = await request('POST', `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/batch_delete`, { records: ids }, token);
  if (del.code !== 0) throw new Error('删除失败: ' + JSON.stringify(del));
  console.log(`[3/3] 已删除 ${ids.length} 条旧记录，汇总表已清空`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
