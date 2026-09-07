/**
 * enum-probe.js —— 省级人社厅「栏目自动发现」探测脚本
 *
 * 输入：各省人社厅首页 URL
 * 输出：候选政策栏目列表（栏目页 URL、标题样本、翻页规律、详情链接特征），供人工挑选注册进 PROVINCE_CHANNELS。
 *
 * 用法: node scripts/enum-probe.js
 * 运行环境要求：能直连 gov.cn（本项目 4201 后台任务网络可）。
 */
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 12000;

// 已确认可解析域名的 4 省
const PROVINCES = [
  { province: '江苏省', org: '江苏省人力资源和社会保障厅', home: 'https://jshrss.jiangsu.gov.cn/' },
  { province: '浙江省', org: '浙江省人力资源和社会保障厅', home: 'https://rlsbt.zj.gov.cn/' },
  { province: '四川省', org: '四川省人力资源和社会保障厅', home: 'https://rst.sc.gov.cn/' },
  { province: '福建省', org: '福建省人力资源和社会保障厅', home: 'https://rst.fujian.gov.cn/' },
];

// 导航关键词：href 或可见文本命中任一组即视为「政策/公示栏目」
const NAV_KEYWORDS = ['规范性文件', '政策文件', '政策法规', '公示公告', '通知公告', '政府信息公开', 'zcwj', 'gfxwj', 'zcfg', 'gsgg', 'tzgg', 'zfxxgk'];

function getHtml(url, referer = '') {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9', timeout: TIMEOUT };
    if (referer) headers.Referer = referer;
    const req = mod.get(url, { headers }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getHtml(new URL(res.headers.location, url).toString(), referer));
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

/** 从 HTML 中提取<a>，返回 {href,text}[]（相对 href 已用 base 转绝对） */
function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const hrefRaw = m[1].trim();
    if (!hrefRaw || /^(javascript|#|mailto|tel:)/i.test(hrefRaw)) continue;
    let abs;
    try { abs = new URL(hrefRaw, baseUrl).toString(); } catch (_) { continue; }
    if (!/^https?:/.test(abs)) continue;
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim().slice(0, 60);
    if (!text) continue;
    out.push({ href: abs, text });
  }
  return out;
}

/** 判断是否详情页链接（gov 常见详情页特征） */
function looksDetail(href) {
  return /\.s?html?$/i.test(href) && !/index|list|more|\.css|\.js/i.test(href);
}

async function probeProvince(p) {
  const report = { province: p.province, home: p.home, channels: [], errors: [] };
  let html = '';
  try {
    const r = await getHtml(p.home);
    if (r.status !== 200) throw new Error(`首页 HTTP ${r.status}`);
    html = decode(r.buf, r.headers['content-type'] || '');
  } catch (e) {
    report.errors.push(`首页抓取失败: ${e.message}`);
    return report;
  }

  // 1) 候选栏目链接：导航关键词命中
  const allLinks = extractLinks(html, p.home);
  const cand = [];
  const seenCand = new Set();
  for (const l of allLinks) {
    const hit = NAV_KEYWORDS.find((k) => l.text.includes(k) || l.href.includes(k));
    if (!hit) continue;
    if (l.href === p.home) continue;
    if (seenCand.has(l.href)) continue;
    seenCand.add(l.href);
    cand.push({ ...l, hit });
  }
  // 去重并按文本长度排序（短文本多为导航项）
  cand.sort((a, b) => a.text.length - b.text.length);
  const top = cand.slice(0, 10);

  for (const c of top) {
    const ch = { label: c.text || c.href, url: c.href, keyword: c.hit, samples: [], pager: null, detailCount: 0 };
    try {
      const r = await getHtml(c.href, p.home);
      if (r.status !== 200) { ch.error = `HTTP ${r.status}`; report.channels.push(ch); continue; }
      const body = decode(r.buf, r.headers['content-type'] || '');
      // 详情链接样本
      const links = extractLinks(body, c.href);
      const details = links.filter((l) => looksDetail(l.href));
      // 去掉明显的栏目/翻页/列表自身
      const dedup = [];
      const sd = new Set();
      for (const d of details) {
        const key = d.href.split('?')[0];
        if (sd.has(key)) continue;
        sd.add(key);
        if (dedup.length < 8) dedup.push(d);
      }
      ch.detailCount = details.length;
      ch.samples = dedup.map((d) => ({ href: d.href.slice(0, 140), text: d.text.slice(0, 60) }));
      // 翻页规律探测：找 index_2.html / _2.shtml / index_2.htm / ?page=2 / 下一页
      const pagers = new Set();
      const pRe = /href=["']([^"']*(?:index_|list_|_?)(\d{1,2})\.s?html?[^"']*|page=(\d+)[^"']*)["']/gi;
      let pm;
      while ((pm = pRe.exec(body))) { try { pagers.add(new URL(pm[1], c.href).toString()); } catch (_) { /* noop */ } }
      if (/下一页|下页|pagination|page-list|dede_pages/i.test(body)) ch.hasPagerText = true;
      if (pagers.size) {
        ch.pager = [...pagers].slice(0, 5).map((u) => u.slice(0, 140));
      }
      report.channels.push(ch);
    } catch (e) {
      ch.error = e.message;
      report.channels.push(ch);
    }
    await sleep(300);
  }
  return report;
}

async function main() {
  const outDir = path.join(process.cwd(), '.workbuddy', '_enum-probe');
  fs.mkdirSync(outDir, { recursive: true });
  const reports = [];
  for (const p of PROVINCES) {
    console.log(`\n===== ${p.province} ${p.home} =====`);
    const r = await probeProvince(p);
    reports.push(r);
    // 即时打印摘要
    for (const c of r.channels) {
      console.log(`\n[栏目] ${c.label}  (关键词:${c.keyword})`);
      console.log(`  url: ${c.url}`);
      if (c.error) { console.log(`  ✗ ${c.error}`); continue; }
      console.log(`  详情链接数(去重前): ${c.detailCount}`);
      for (const s of c.samples) console.log(`    - ${s.text}  |  ${s.href}`);
      if (c.pager?.length) console.log(`  翻页: ${c.pager.join('  |  ')}`);
    }
    if (r.errors.length) console.log(`\n[错误] ${r.errors.join('; ')}`);
    await sleep(500);
  }
  const out = path.join(outDir, `report-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(reports, null, 1));
  console.log(`\n报告已写: ${out}`);
}

main().catch((e) => { console.error('enum-probe 失败:', e); process.exit(1); });
