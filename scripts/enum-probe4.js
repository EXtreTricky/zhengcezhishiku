/**
 * enum-probe4.js —— 精确取证
 * ①福建 gsgg：详情<a>的上下文结构（容器+日期）→ 写 listRe/itemRe 依据
 * ②江苏 col77273：页面内全部子栏目(col/col*)链接的锚文本 → 定位"规范性文件"真身
 */
'use strict';
const https = require('https');
const http = require('http');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

function getHtml(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' }, timeout: TIMEOUT }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return resolve(getHtml(new URL(res.headers.location, url).toString())); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
function decode(buf, ct = '') {
  const cs = /charset=([\w-]+)/i.exec(ct)?.[1]?.toLowerCase() || 'utf-8';
  try { if (['gbk', 'gb2312', 'gb18030'].includes(cs)) return new TextDecoder('gb18030').decode(buf); } catch { /* noop */ }
  return buf.toString('utf8');
}

async function main() {
  // ①福建 gsgg 详情链接上下文
  {
    const r = await getHtml('https://rst.fujian.gov.cn/zw/gsgg/');
    const html = decode(r.buf, r.headers['content-type'] || '');
    console.log(`===== 福建 gsgg HTTP ${r.status} len=${html.length} =====`);
    // 详情链接：/zw/gsgg/YYYYMM/tYYYYMMDD_NNNN.htm
    const re = /<a[^>]+href="([^"]*\/t\d+_\d+\.htm)"[^>]*>[\s\S]{0,400}?<\/a>/gi;
    let m, cnt = 0;
    const pagerCands = new Set();
    const pRe = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]{0,60}?(下一页|尾页|下页|>\s*$)[\s\S]{0,20}?<\/a>/i;
    while ((m = re.exec(html)) && cnt < 3) {
      const start = Math.max(0, m.index - 260);
      console.log(`\n-- 详情#${cnt + 1} (前260字符上下文) --`);
      console.log(html.slice(start, m.index + 260).replace(/\s+/g, ' ').slice(-520));
      cnt++;
    }
    if (!cnt) console.log('未匹配详情链接，采样含日期文本附近:');
    if (cnt === 0) {
      const dRe = /20\d{2}-[01]\d-[0-3]\d/;
      const idx = html.search(dRe);
      if (idx > 0) console.log(html.slice(idx - 400, idx + 300).replace(/\s+/g, ' '));
    }
    const allPages = [...html.matchAll(/href="([^"]+)"[^>]*>[\s\S]{0,40}?(下一页|尾页|下页)/gi)].map((x) => x[1]);
    allPages.forEach((p) => pagerCands.add(p));
    console.log(`\n翻页(next/尾): ${[...pagerCands].slice(0, 6).join('  |  ') || '无'}`);
    const idxPages = [...html.matchAll(/href="([^"]*index_\d+\.s?html?)"/gi)].map((x) => x[1]);
    if (idxPages.length) console.log(`index_N 翻页: ${[...new Set(idxPages)].slice(0, 8).join('  |  ')}`);
  }

  // ②江苏 col77273 子栏目锚文本
  {
    const r = await getHtml('https://jshrss.jiangsu.gov.cn/col/col77273/index.html');
    const html = decode(r.buf, r.headers['content-type'] || '');
    console.log(`\n===== 江苏 col77273 HTTP ${r.status} len=${html.length} 子栏目清单 =====`);
    const seen = new Set();
    const re = /<a[^>]+href="([^"]*\/col\/col\d+\/index\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim().slice(0, 40);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      console.log(`  ${text.padEnd(30)} ${m[1]}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
