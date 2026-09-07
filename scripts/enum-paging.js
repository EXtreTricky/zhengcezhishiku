#!/usr/bin/env node
/**
 * enum-paging.js —— 探测已注册省栏目的分页 URL 模式（把"只抓第一页"扩成"抓多页历史"）
 * 对每个栏目 pageUrl(1)，试 2-3 个常见第 2 页候选（index_2.html/shtml、目录尾 index_2.*），
 * 200 且详情链接数 >=1 即视为支持分页，输出可用于 enum-sources pageCount/pageUrl 参数化的模式。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PROVINCE_CHANNELS } = require('../policy-api/src/enum-sources');
const https = require('https');
const http = require('http');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA }, timeout: 8000 }, (r) => {
      if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return resolve(get(new URL(r.headers.location, url).toString()));
      }
      const c = [];
      r.on('data', (x) => c.push(x));
      r.on('end', () => resolve({ status: r.statusCode, buf: Buffer.concat(c) }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
  });
}

function page2Candidates(u1) {
  const out = new Set();
  for (const ext of ['html', 'shtml', 'htm']) {
    const re = new RegExp('index\\.' + ext + '$');
    if (re.test(u1)) out.add(u1.replace(re, 'index_2.' + ext));
  }
  if (u1.endsWith('/')) {
    out.add(u1 + 'index_2.html');
    out.add(u1 + 'index_2.shtml');
  }
  return [...out].slice(0, 3);
}

function countDetail(html) {
  return (html.match(/t\d+_\d+\.s?html?|content\/post_|\/art\/|\/articles\/ch\d+/g) || []).length;
}

(async () => {
  console.log('省份 | 栏目 | page1 | page2候选可用性');
  const results = [];
  for (const [prov, chans] of Object.entries(PROVINCE_CHANNELS)) {
    for (const ch of chans) {
      if (ch.type !== 'page') continue;
      const u1 = ch.pageUrl(1);
      const cands = page2Candidates(u1);
      let okUrl = '';
      let okCount = 0;
      for (const cu of cands) {
        const r = await get(cu);
        if (r.status === 200) {
          const n = countDetail(r.buf.toString('utf8'));
          if (n >= 1) { okUrl = cu; okCount = n; break; }
        }
      }
      results.push({ prov, label: ch.label, u1, page2: okUrl, page2Count: okCount });
      console.log(`${prov} | ${ch.label} | ${u1} | ${okUrl ? '✅ ' + okUrl + ' (' + okCount + ' 详情)' : '✗ 无分页'}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  require('fs').writeFileSync(require('path').join(process.cwd(), '.workbuddy', '_paging-report.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\n报告: .workbuddy/_paging-report.json');
})();
