/**
 * enum-probe2.js —— 定向栏目「渲染方式体检」
 * 对给定栏目 URL 抓原始 HTML，判定：
 *   a) 详情链接是否为静态 <a>（可 page 型注册）
 *   b) 翻页 URL 规律
 *   c) 是否 JS/接口渲染（列表可能藏在 <script> 数据里或需接口）
 * 输出前 12 条详情样本 + 诊断结论。
 *
 * 用法: node scripts/enum-probe2.js
 */
'use strict';
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

const TARGETS = [
  { label: '四川·规范性文件', url: 'https://rst.sc.gov.cn/rst/zcwj/zfxxgkpage.shtml' },
  { label: '福建·政府信息公开目录母页', url: 'https://rst.fujian.gov.cn/zw/zfxxgk/zfxxgkml/' },
  { label: '福建·规范性文件(猜)', url: 'https://rst.fujian.gov.cn/zw/zfxxgk/zfxxgkml/zcwj/' },
  { label: '江苏·政策文件(col77273 为何0)', url: 'https://jshrss.jiangsu.gov.cn/col/col77273/index.html' },
  { label: '江苏·公示公告翻页(猜index_2)', url: 'https://jshrss.jiangsu.gov.cn/col/col78503/index_2.html' },
  { label: '浙江·公示公告(为何0)', url: 'https://rlsbt.zj.gov.cn/col/col1229116948/index.html' },
  { label: '浙江·政府信息公开母页', url: 'https://rlsbt.zj.gov.cn/col/col1389507/index.html' },
];

function getHtml(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' }, timeout: TIMEOUT }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getHtml(new URL(res.headers.location, url).toString()));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function decode(buf, contentType = '') {
  let cs = /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  const c = cs.toLowerCase();
  try { if (['gbk', 'gb2312', 'gb18030'].includes(c)) return new TextDecoder('gb18030').decode(buf); } catch { /* noop */ }
  return buf.toString('utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const t of TARGETS) {
    console.log(`\n========== ${t.label} ==========`);
    console.log(`URL: ${t.url}`);
    try {
      const r = await getHtml(t.url);
      if (r.status !== 200) { console.log(`HTTP ${r.status}`); continue; }
      const html = decode(r.buf, r.headers['content-type'] || '');
      console.log(`HTML 长度: ${html.length}  charset: ${(r.headers['content-type'] || '').match(/charset=[\w-]+/i)?.[0] || '?'}`);

      // 1) 静态 <a> 详情链接统计
      const links = [];
      const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html))) {
        const href = m[1];
        if (!/\.s?html?$/i.test(href) || /index|list|more/i.test(href)) continue;
        const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 55);
        if (!text) continue;
        if (links.length < 12) links.push({ href: href.length > 130 ? href.slice(0, 130) + '…' : href, text });
      }
      console.log(`静态详情<a>数(取样上限12): ${links.length}`);
      links.forEach((l) => console.log(`  - ${l.text}  |  ${l.href}`));

      // 2) 翻页规律
      const pager = [...new Set((html.match(/(?:href=["'])([^"']*(?:index|list|page)[^"']*\.s?html?(?:\?[^"']*)?)(?:["'])/gi) || []).slice(0, 6))];
      if (pager.length) console.log(`翻页候选: ${pager.join('  ||  ')}`);

      // 3) JS/接口线索
      const jsHints = [];
      if (/<script[^>]+src=["'][^"']+\.js/i.test(html)) jsHints.push('外链js');
      if (/url:\s*["']|ajax|XMLHttpRequest|fetch\(/i.test(html)) jsHints.push('ajax/fetch');
      if (/var\s+(data|list|json|arr)\s*=/i.test(html)) jsHints.push('内嵌数据变量');
      if (/window\.location|location\.href/i.test(html)) jsHints.push('跳转');
      if (jsHints.length) console.log(`JS线索: ${jsHints.join(', ')}`);

      // 4) 疑似数据接口 URL（.do/.action/.json/api 常见）
      const apiRe = /["']([^"']*(?:\.do|\.action|\.json|\/api\/|servlet|getContent)[^"']*)["']/gi;
      const apis = [...new Set((html.match(apiRe) || []).slice(0, 5))];
      if (apis.length) console.log(`接口候选: ${apis.join('  |  ')}`);

      // 5) 采样原始片段（列表容器附近，帮助写正则）
      const ulM = /<ul[^>]*class=["'][^"']*(?:list|news|zx|cont)[^"']*["'][^>]*>[\s\S]{0,1200}/i.exec(html);
      if (ulM) {
        const frag = ulM[0].replace(/\s+/g, ' ').slice(0, 500);
        console.log(`列表片段: ${frag}`);
      }
    } catch (e) {
      console.log(`抓取失败: ${e.message}`);
    }
    await sleep(250);
  }
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
