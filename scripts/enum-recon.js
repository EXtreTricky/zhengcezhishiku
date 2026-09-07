#!/usr/bin/env node
/**
 * enum-recon.js —— 省级人社官网「一键勘察」（把矩阵里的省逐个摸清，供批量注册 enum-sources）
 *
 * 对每个目标省：
 *   1. 域名候选探测 → 确认有效官网（HTTP 200 + HTML 含人社特征词）
 *   2. 抓首页 → 按导航锚词发现候选栏目（政策文件/规范性文件/公示公告/通知公告/解读/信息公开…）
 *   3. 逐栏目抓取判定渲染方式：
 *        - static：HTML 里能直接解析出 >=5 条详情链接 → 输出前 3 条原始 <a> 样本（供写 itemRe）
 *        - sitemap：/sitemap.xml 可达
 *        - api/js：静态 HTML 无列表条目、疑似 JS/接口渲染（附证据：页面含 api 关键词等）
 *   4. 汇总报告写 .workbuddy/_recon-report.{json,md}
 *
 * 用法：
 *   node scripts/enum-recon.js                 # 扫全部目标省
 *   node scripts/enum-recon.js --only 江苏,浙江 # 只扫指定省
 *   node scripts/enum-recon.js --probe <url>    # 单看一个 URL 的渲染判定
 *
 * 注意：gov.cn 需在后台任务网络运行（与 4201 服务同源，沙箱 curl 直连不通）。
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 10000;
const GAP = 250;

// 简名 → 标准省名（--only 用）
const SHORT2FULL = { 北京: '北京市', 上海: '上海市', 天津: '天津市', 重庆: '重庆市', 江苏: '江苏省', 浙江: '浙江省', 山东: '山东省', 四川: '四川省', 湖北: '湖北省', 河南: '河南省', 湖南: '湖南省', 河北: '河北省', 广东: '广东省', 福建: '福建省' };

// 目标省 × 域名候选（多候选取第一个连通者；gov 域名不规律，靠探测不靠猜）
const TARGETS = {
  北京市: ['rsj.beijing.gov.cn'],
  上海市: ['rsj.sh.gov.cn'],
  天津市: ['hrss.tj.gov.cn'],
  重庆市: ['rlsbj.cq.gov.cn'],
  江苏省: ['jshrss.jiangsu.gov.cn'],
  浙江省: ['rlsbt.zj.gov.cn'],
  山东省: ['hrss.shandong.gov.cn', 'rst.shandong.gov.cn'],
  四川省: ['rst.sc.gov.cn'],
  湖北省: ['rst.hubei.gov.cn'],
  河南省: ['hrss.henan.gov.cn'],
  湖南省: ['rst.hunan.gov.cn'],
  河北省: ['rst.hebei.gov.cn'],
  // 已注册的两省也顺带复核（不改注册，仅报告）
  广东省: ['hrss.gd.gov.cn'],
  福建省: ['rst.fujian.gov.cn'],
};

// 栏目锚词 → 语义分组（决定报告中栏目排序与可注册性）
const NAV_WORDS = [
  { re: /规范性文件|政策文件|政策法规|法规文件/, tag: '政策文件', prio: 1 },
  { re: /公示公告|通知公告|公告公示/, tag: '公示公告', prio: 2 },
  { re: /政策解读|文件解读|解读/, tag: '政策解读', prio: 3 },
  { re: /政府信息公开|信息公开|政务公开/, tag: '信息公开', prio: 4 },
  { re: /人事人才|职称|招聘/, tag: '人事人才', prio: 5 },
];

const NAV_HREF_HINT = /(zcwj|zcjd|gfxwj|gsgg|tzgg|xxgk|zwgk|flfg|zcfg|wj|gg|bmwj|qtwj)/i;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getHtml(url) {
  return new Promise((resolve, reject) => {
    let mod;
    try { mod = url.startsWith('https') ? https : http; } catch { return reject(new Error('bad url')); }
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeout: TIMEOUT,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(getHtml(new URL(res.headers.location, url).toString()));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), finalUrl: url }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function decode(buf, contentType = '') {
  let cs = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!cs) {
    const head = buf.slice(0, 2048).toString('latin1');
    cs = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  const c = (cs || 'utf-8').toLowerCase();
  try {
    if (['gbk', 'gb2312', 'gb18030'].includes(c)) return new TextDecoder('gb18030').decode(buf);
    return buf.toString('utf8');
  } catch { return buf.toString('utf8'); }
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&ldquo;|&rdquo;|&middot;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 详情链接强特征：命中即视为政策详情页 */
const DETAIL_STRONG = [
  /t\d+_\d+\.(?:htm|html|shtml)/, // 福建/常见 TRS
  /content[\/_-]post_\d+/,        // 广东
  /\/20\d{6}\//,                  // 日期目录型
  /\.s?html?$/,                   // 以 .htm/.html 结尾
];
/** 目录/非详情排除 */
const NOT_DETAIL = [
  /\.(css|js|jpe?g|png|gif|svg|ico|pdf|docx?|xlsx?|zip|rar|mp4)(\?|$)/i,
  /(sitemap|search|sousuo|rss|print|error|login)/i,
  /(^|\/)index(_\d+)?\.s?html?$/i, // 列表页自身
  /\/list|channel|column|category|special|zhuanti\//i,
];

function isDetailHref(href) {
  if (!/^https?:\/\//.test(href)) return false;
  let p;
  try { p = new URL(href).pathname; } catch { return false; }
  if (p === '/' || !p) return false;
  for (const n of NOT_DETAIL) if (n.test(p)) return false;
  for (const s of DETAIL_STRONG) if (s.test(p)) return true;
  return false; // 拿不准的不算，宁少勿滥
}

/** 分析一页：收集详情链接 <a> 原始片段与总数 */
function analyzeListHtml(html, baseUrl) {
  const seen = new Set();
  const samples = [];
  let total = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const hrefM = /href=["']([^"']+)["']/i.exec(tag);
    if (!hrefM) continue;
    let href;
    try { href = new URL(hrefM[1], baseUrl).toString(); } catch { continue; }
    if (!isDetailHref(href) || seen.has(href)) continue;
    seen.add(href);
    total++;
    if (samples.length < 3) samples.push({ href, raw: tag + m[1].replace(/\s+/g, ' ').slice(0, 220) });
  }
  // 列表语义佐证：页面是否含日期串（政府列表页几乎必带发布日期）
  const dateHits = (html.match(/(20\d{2})[-年/.](0?[1-9]|1[0-2])[-月/.](0?[1-9]|[12]\d|3[01])/g) || []).length;
  const liCount = (html.match(/<li\b/g) || []).length;
  return { total, samples, dateHits, liCount };
}

function isStaticList(r) {
  // 详情链接 >=5 或（>=3 且页面有较集中日期串）判为静态列表可抓
  return r.total >= 5 || (r.total >= 3 && r.dateHits >= 5);
}

async function probeSite(province, hosts) {
  for (const host of hosts) {
    for (const proto of ['https', 'http']) {
      const url = `${proto}://${host}/`;
      try {
        const { status, headers, buf } = await getHtml(url);
        if (status !== 200) continue;
        const text = decode(buf, headers['content-type'] || '');
        const title = cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || '');
        if (/人力|人社|劳动保障|社会保障/.test(title + text.slice(0, 600))) {
          return { ok: true, url: `${proto}://${host}`, title: title.slice(0, 80), len: text.length };
        }
      } catch { /* next */ }
    }
    await sleep(150);
  }
  return { ok: false, reason: '候选域名均不可达或无人社特征' };
}

/** 从首页发现栏目：按锚文本关键词 + href 提示过滤，归一化绝对 URL */
function discoverChannels(homeHtml, siteUrl) {
  const found = new Map(); // url → {tag,title,prio}
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(homeHtml))) {
    const tag = m[0];
    const hrefM = /href=["']([^"']+)["']/i.exec(tag);
    if (!hrefM) continue;
    const raw = hrefM[1];
    if (/^(javascript|mailto|#)/i.test(raw)) continue;
    let href;
    try { href = new URL(raw, siteUrl).toString(); } catch { continue; }
    const host = new URL(href).host;
    if (!host.endsWith(new URL(siteUrl).host) && new URL(siteUrl).host !== host) continue; // 只留本站
    const text = cleanText(m[1]);
    if (text.length < 4) continue;
    const hit = NAV_WORDS.find((w) => w.re.test(text));
    if (!hit) continue;
    if (!NAV_HREF_HINT.test(new URL(href).pathname) && !hit.re.test(text)) continue;
    // 同 pathname 只留一条（http/https 双版本去重，优先 https）
    const keyPath = new URL(href).pathname;
    const existing = [...found.values()].find((f) => new URL(f.url).pathname === keyPath);
    if (existing) {
      if (href.startsWith('https')) existing.url = href;
      continue;
    }
    found.set(href.split('#')[0], { title: text.slice(0, 40), prio: hit.prio, tag: hit.tag, url: href.split('#')[0] });
  }
  return [...found.values()].sort((a, b) => a.prio - b.prio).slice(0, 8);
}

async function reconProvince(province, hosts, out) {
  const rec = { province, ok: false, site: '', siteTitle: '', channels: [], sitemap: null, errors: [] };
  const site = await probeSite(province, hosts);
  if (!site.ok) { rec.errors.push(site.reason); out.push(rec); return rec; }
  rec.ok = true;
  rec.site = site.url;
  rec.siteTitle = site.title;

  // sitemap 探测
  try {
    const sm = await getHtml(site.url + '/sitemap.xml');
    if (sm.status === 200 && /xml/.test(sm.headers['content-type'] || '') && sm.buf.length > 2048) {
      rec.sitemap = { url: site.url + '/sitemap.xml', bytes: sm.buf.length };
    }
  } catch { /* no sitemap */ }
  await sleep(GAP);

  // 首页 → 栏目
  let homeHtml = '';
  try {
    const h = await getHtml(site.url + '/');
    homeHtml = decode(h.buf, h.headers['content-type'] || '');
  } catch (e) { rec.errors.push('首页抓取失败 ' + e.message); }
  await sleep(GAP);
  if (!homeHtml) { out.push(rec); return rec; }

  const chs = discoverChannels(homeHtml, site.url);
  for (const ch of chs.slice(0, 6)) {
    const c = { label: ch.title, tag: ch.tag, url: ch.url, verdict: '', detailCount: 0, dateHits: 0, samples: [], note: '' };
    try {
      const { status, headers, buf } = await getHtml(ch.url);
      if (status !== 200) { c.verdict = 'http' + status; rec.channels.push(c); await sleep(GAP); continue; }
      const html = decode(buf, headers['content-type'] || '');
      const a = analyzeListHtml(html, ch.url);
      c.detailCount = a.total;
      c.dateHits = a.dateHits;
      c.samples = a.samples;
      const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      c.note = cleanText(titleM?.[1] || '').slice(0, 60);
      if (a.total === 0) {
        c.verdict = /api|ajax|json|\.do\?|list\?/.test(html) ? 'api/js渲染（静态HTML无列表）' : '静态页但无详情链接（可能纯JS/iframe）';
      } else if (isStaticList(a)) {
        c.verdict = 'STATIC ✅ 可直接注册 page 型';
      } else {
        c.verdict = `弱静态（详情链接 ${a.total} 条，日期串 ${a.dateHits}），需人工核验`;
      }
      rec.channels.push(c);
    } catch (e) {
      c.verdict = '抓取失败: ' + e.message.slice(0, 60);
      rec.channels.push(c);
    }
    await sleep(GAP);
  }
  out.push(rec);
  console.log(`✔ ${province}: ${site.url} | 栏目 ${rec.channels.length} | sitemap ${rec.sitemap ? '有(' + rec.sitemap.bytes + 'B)' : '无'}`);
  for (const c of rec.channels) {
    console.log(`    [${c.verdict.slice(0, 22)}] ${c.tag} ${c.label} → ${c.url} (详情链接 ${c.detailCount})`);
  }
  return rec;
}

function renderMd(out) {
  const L = [];
  L.push('# 省级人社官网勘察报告\n');
  for (const rec of out) {
    L.push(`## ${rec.province} ${rec.ok ? '' : '(✗ ' + rec.errors[0] + ')'}`);
    if (!rec.ok) continue;
    L.push(`- 站点: ${rec.site} — ${rec.siteTitle}`);
    if (rec.sitemap) L.push(`- sitemap: 可用（${rec.sitemap.bytes} B）`);
    for (const c of rec.channels) {
      L.push(`- [${c.verdict}] ${c.tag}「${c.label}」 ${c.url}`);
      L.push(`  - 详情链接 ${c.detailCount} 条 / 日期串 ${c.dateHits}`);
      for (const s of c.samples.slice(0, 2)) {
        L.push('  - 样本: ' + s.raw.replace(/\n/g, ' ').slice(0, 260));
      }
    }
    if (!rec.channels.length) L.push('- 未发现白名单相关栏目');
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.indexOf('--only') >= 0 ? argv[argv.indexOf('--only') + 1].split(/[,，]/).filter(Boolean) : null;
  const probeUrl = argv.indexOf('--probe') >= 0 ? argv[argv.indexOf('--probe') + 1] : '';
  if (probeUrl) {
    const { status, headers, buf } = await getHtml(probeUrl);
    const html = decode(buf, headers['content-type'] || '');
    const a = analyzeListHtml(html, probeUrl);
    console.log(JSON.stringify({ status, len: html.length, ...a }, null, 2));
    return;
  }
  const targets = only ? Object.fromEntries(only.map((p) => [p, TARGETS[SHORT2FULL[p] || p]]).filter(([, h]) => h)) : TARGETS;
  const out = [];
  for (const [province, hosts] of Object.entries(targets)) {
    try { await reconProvince(province, hosts, out); }
    catch (e) { out.push({ province, ok: false, errors: [e.message.slice(0, 100)] }); }
    await sleep(400);
  }
  fs.mkdirSync(path.join(process.cwd(), '.workbuddy'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), '.workbuddy', '_recon-report.json'), JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(path.join(process.cwd(), '.workbuddy', '_recon-report.md'), renderMd(out), 'utf8');
  console.log('\n报告: .workbuddy/_recon-report.md');
}

main().catch((e) => { console.error('recon 失败:', e); process.exit(1); });
