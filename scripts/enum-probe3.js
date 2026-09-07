/**
 * enum-probe3.js —— ①福建列表结构取证 ②JS型栏目内嵌JSON挖掘
 */
'use strict';
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

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

async function probeStatic(url, label) {
  console.log(`\n========== [静态取证] ${label} ==========`);
  const r = await getHtml(url);
  const html = decode(r.buf, r.headers['content-type'] || '');
  console.log(`HTTP ${r.status}  len=${html.length}`);
  // 找正文列表容器：常见的 <ul class="...list..."> 或 <div class="...con...list...">
  const ulM = /<ul[^>]*class=["'][^"']*list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i.exec(html);
  const body = ulM ? ulM[1] : html;
  // 打印 body 里前 3 个 <li> 原始片段（截断）
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let cnt = 0, m;
  while ((m = liRe.exec(body)) && cnt < 3) {
    console.log(`\n-- li #${cnt + 1} 原始片段 --`);
    console.log(m[0].replace(/\s+/g, ' ').slice(0, 600));
    cnt++;
  }
  // 全部翻页链接（index_1 / index_2 / ?page / 下一页）
  const pagerLinks = [...new Set((html.match(/href=["']([^"']*(?:index_\d+\.s?html?|index\.s?html?|\?page(?:No|Num|Index)?=\d+)[^"']*)["']/gi) || []))].slice(0, 10);
  console.log(`\n翻页候选: ${pagerLinks.length ? pagerLinks.join('  |  ') : '（未发现标准翻页）'}`);
  if (!pagerLinks.length) {
    const nextM = /href=["']([^"']+)["'][^>]*>\s*(?:下一页|下页|尾页|>)\s*</i.exec(html);
    if (nextM) console.log(`“下一页”指向: ${nextM[1]}`);
    else console.log('无“下一页”文本链接');
  }
}

function mineJsonScripts(html, label) {
  console.log(`\n========== [JS挖掘] ${label} ==========`);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1]);
  let found = 0;
  scripts.forEach((s, i) => {
    if (s.length < 400) return;
    // 特征键探测：cms 列表 JSON 常见 title/url/publishDate/createtime/article
    const keys = ['"title"', '"url"', 'publishDate', 'createtime', '"href"', 'articleId', 'record', 'listData', 'contentList', '"name"'];
    const hits = keys.filter((k) => s.includes(k));
    if (hits.length >= 2) {
      found++;
      console.log(`\n-- script#${i} len=${s.length} 含键: ${hits.join(',')}`);
      // 找 JSON 数组片段并取样
      const arrM = s.match(/\[[\s\S]{200,4000}\]/);
      if (arrM) console.log(`数组取样: ${arrM[0].slice(0, 900)}`);
      else console.log(`片段取样: ${s.slice(0, 900)}`);
      if (found >= 3) return;
    }
  });
  if (!found) console.log('未发现含列表数据的 script（纯外链/功能脚本）');
}

async function main() {
  const T = process.argv[2] || 'all';
  if (T === 'all' || T === 'fj') {
    try {
      await probeStatic('https://rst.fujian.gov.cn/zw/gsgg/', '福建·公示公告(列表结构+翻页)');
    } catch (e) { console.log('福建 gsgg 失败:', e.message); }
    await sleep(200);
  }
  if (T === 'all' || T === 'mine') {
    for (const [label, url] of [
      ['江苏·政策文件 col77273', 'https://jshrss.jiangsu.gov.cn/col/col77273/index.html'],
      ['四川·规范性文件 zfxxgkpage', 'https://rst.sc.gov.cn/rst/zcwj/zfxxgkpage.shtml'],
      ['浙江·公示公告 col1229116948', 'https://rlsbt.zj.gov.cn/col/col1229116948/index.html'],
    ]) {
      try {
        const r = await getHtml(url);
        const html = decode(r.buf, r.headers['content-type'] || '');
        console.log(`HTTP ${r.status} len=${html.length}`);
        mineJsonScripts(html, label);
      } catch (e) { console.log(`${label} 失败: ${e.message}`); }
      await sleep(250);
    }
  }
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
