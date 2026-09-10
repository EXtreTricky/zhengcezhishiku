/**
 * enum-sources.js —— 省级政策栏目「枚举式发现」源（第③层抓全方案）
 *
 * 思路：搜索模式（crawler.discoverBySearch）拿关键词去政府库"碰运气"，
 *       命中率受词表与库收录影响；枚举模式改为直接把省厅政策文件栏目
 *       的官方发布列表全量拉下来（一条不漏），再交给 classifyCategory
 *       筛出与 10 类白名单匹配的条目 → 进入与搜索相同的 抓正文/抽取/AI 补全 管线。
 *
 * 试点：广东省人社厅「规范性文件」栏目（静态 HTML 无 WAF，index_N.html 分页 39 页）。
 * 扩展：加省/厅 = 在 PROVINCE_CHANNELS 追加一条（需适配 listRe/itemRe 与分页规则）。
 */
const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = Math.max(2500, parseInt(process.env.ENUM_HTTP_TIMEOUT_MS || '6000', 10) || 6000);
const RETRIES = Math.max(0, Math.min(2, parseInt(process.env.ENUM_HTTP_RETRIES || '0', 10) || 0));
const CHANNEL_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.ENUM_CHANNEL_CONCURRENCY || '2', 10) || 2));
const PAGE_GAP_MS = Math.max(100, parseInt(process.env.ENUM_PAGE_GAP_MS || '300', 10) || 300); // 温和限速

/** 栏目源注册表
 *  type: 'page'  —— 列表分页型（现有模式）
 *    字段：pageCount（总页数，未知可给大值靠空页中断）、pageUrl(n)（分页 URL 函数）、
 *          listRe（可选，列表容器，缺省 <ul class="list">）、itemRe（可选，条目正则，须捕获 url/title/date 三组）、
 *          detailUrlRe（可选，详情链接特征过滤，缺省 /content\/post_/，即广东人社局详情页形态）
 *  type: 'sitemap' —— 全站 sitemap.xml 索引型（一次性拿 N 多条目，按 path 前缀过滤）
 *    提供：sitemapUrl、pathPrefixes（任一前缀命中即纳入）、cachePath（本地缓存避免每次重拉；不存在时拉一次落到磁盘）
 */
// 旧全称条目已清除，统一由 crawl-regions.js PROVINCES 动态注册 + discover 兜底
const PROVINCE_CHANNELS = {};


// 每个省都保留一个“官方根站自动发现”兜底源。
// 不能只给缺省份加 discover：固定栏目一旦改版/404，如果没有 discover，整省会直接失联。
const { PROVINCES } = require('./crawl-regions');
for (const p of PROVINCES) {
  if (!PROVINCE_CHANNELS[p.name]) PROVINCE_CHANNELS[p.name] = [];
  const channels = PROVINCE_CHANNELS[p.name];
  if (!channels.some((x) => x.type === 'discover')) {
    const fixedSeeds = [];
    for (const ch of channels) {
      try {
        if (typeof ch.pageUrl === 'function') fixedSeeds.push(ch.pageUrl(1));
        if (ch.sitemapUrl) fixedSeeds.push(ch.sitemapUrl);
      } catch (_) {}
    }
    channels.push({
      label: `${p.name}政府网·自动发现兜底`,
      type: 'discover',
      rootUrl: p.root,
      seedUrls: [...new Set(fixedSeeds.filter(Boolean))].slice(0, 4),
      keywords: ['政策', '政策文件', '政府文件', '规范性文件', '行政规范性文件', '政府公报', '人力资源', '社会保障'],
    });
  }
}

const VERIFIED_DISCOVERY_SEEDS = {
  '吉林省': [
    'https://www.jl.gov.cn/zcxx/zfwj/wap.html',
    'https://www.jl.gov.cn/zcxx/',
    'https://hrss.jl.gov.cn/flfg/',
  ],
  '内蒙古自治区': [
    'https://www.nmg.gov.cn/zwgk/',
    'https://www.nmg.gov.cn/zfbgt/zwgk/zzqwj/',
  ],
  '广西壮族自治区': [
    'https://www.gxzf.gov.cn/html///zfwj/zzqrmzfbgtwj_34828/',
    'https://rst.gxzf.gov.cn/zwgk/xxgkzcfg/gxflfg/',
  ],
  '贵州省': [
    'https://www.guizhou.gov.cn/zwgk/zcfg/',
    'https://rst.guizhou.gov.cn/',
  ],
  '云南省': [
    'https://www.yn.gov.cn/zwgk/zcwj/zxwj/',
    'https://www.yn.gov.cn/zwgk/zfxxgkpt/gkptzcwj/xzgfxwj/',
  ],
  '西藏自治区': [
    'https://www.xizang.gov.cn/zwgk/xxfb/zfwj/',
    'https://www.xizang.gov.cn/zwgk/xxfb/zbwj/',
    'https://www.xizang.gov.cn/zwgk/zfgb/',
    'https://hrss.xizang.gov.cn/xwzx/tzgg/',
  ],
  '宁夏回族自治区': [
    'https://www.nx.gov.cn/zwgk/qzfwj/',
    'https://www.nx.gov.cn/zwgk/qzfwj/list.html',
    'https://hrss.nx.gov.cn/',
  ],
  '新疆维吾尔自治区': [
    'https://www.xinjiang.gov.cn/xinjiang/zhengce/zfxxgk_zhengce_31.shtml',
    'https://www.xinjiang.gov.cn/xinjiang/gfxwj1/zfxxgk_zc_gfxwj.shtml',
    'https://www.xinjiang.gov.cn/xinjiang/fgwjx/zzzb_list.shtml',
    'https://www.xinjiang.gov.cn/xinjiang/zfgb/zfgb.shtml',
    'https://rst.xinjiang.gov.cn/xjrst/zcwj/zfxxgk_gknrz.shtml',
  ],
};
for (const [name, urls] of Object.entries(VERIFIED_DISCOVERY_SEEDS)) {
  const channels=PROVINCE_CHANNELS[name] || [];
  const discover=channels.find((x)=>x.type==='discover');
  if (discover) discover.seedUrls=[...new Set([...(discover.seedUrls || []), ...urls])];
  else channels.push({label:`${name}政府网·补充发现`,type:'discover',rootUrl:PROVINCES.find((p)=>p.name===name)?.root,seedUrls:urls,keywords:['政策','政府文件','规范性文件','公报','人力资源','社会保障']});
}

function getHtml(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' }, timeout: TIMEOUT },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(getHtml(new URL(res.headers.location, url).toString(), attempt));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时(${TIMEOUT}ms)`)));
    req.on('error', (e) => {
      if (attempt < RETRIES) return resolve(getHtml(url, attempt + 1));
      reject(e);
    });
  });
}

function decode(buf, contentType = '') {
  let cs = /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  const c = cs.toLowerCase();
  try {
    if (['gbk', 'gb2312', 'gb18030'].includes(c)) return new TextDecoder('gb18030').decode(buf);
  } catch { /* fallthrough */ }
  return buf.toString('utf8');
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&ldquo;|&rdquo;|&middot;|&mdash;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从详情 URL 兜底提取发布日期（多数 gov 站 URL 内含日期目录/前缀） */
function dateFromUrl(u) {
  let mm;
  // 1) TRS 前缀：/202608/t20260828_xxx.html 或 t20260828.xxx
  mm = /t(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_/.]/.exec(u);
  if (mm) return `${mm[1]}-${mm[2]}-${mm[3]}`;
  // 2) 江苏式：/art/2026/8/31/art_...
  mm = /art\/(20\d{2})\/(\d{1,2})\/(\d{1,2})\//.exec(u);
  if (mm) return `${mm[1]}-${String(mm[2]).padStart(2, '0')}-${String(mm[3]).padStart(2, '0')}`;
  // 3) 河南式：/2026/09-02/xxxx.html
  mm = /\/(20\d{2})\/(\d{2})-(\d{2})\//.exec(u);
  if (mm) return `${mm[1]}-${mm[2]}-${mm[3]}`;
  // 4) 纯 8 位日期目录：/20260803/
  mm = /\/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\//.exec(u);
  if (mm) return `${mm[1]}-${mm[2]}-${mm[3]}`;
  // 5) 6 位年月目录：/articles/ch00330/202609/（山东式，只有年月）
  mm = /\/(20\d{2})(0[1-9]|1[0-2])\//.exec(u);
  if (mm) return `${mm[1]}-${mm[2]}`;
  return '';
}

/** 解析一页列表 HTML → [{url,title,publishDate}]
 *  ch 为栏目配置（可选）：detailUrlRe（详情链接特征，缺省 /content\/post_/）、
 *  listRe（列表容器，缺省 <ul class="list">）、itemRe（条目正则，须捕获 url/title[/date]） */
function parseListPage(html, baseUrl, ch = {}) {
  const detailUrlRe = ch.detailUrlRe || /content\/post_/;
  // listRe 未配置 → 默认 <ul class="list">（广东形态）；显式 null → 全页按 itemRe 抓
  const listRe = ch.listRe === undefined ? /<ul class="list"[^>]*>([\s\S]*?)<\/ul>/i : ch.listRe;
  const itemRe = ch.itemRe || /<a href="([^"]+)" title="([^"]+)">[\s\S]*?(?:<span class="pubDate"[^>]*>(\d{4}-\d{2}-\d{2}))?/g;
  const out = [];
  const listM = listRe ? listRe.exec(html) : null;
  const body = listM ? listM[1] : html;
  itemRe.lastIndex = 0;
  let m;
  while ((m = itemRe.exec(body))) {
    const raw = m[1];
    if (!raw) continue;
    let href;
    try { href = new URL(raw, baseUrl).toString(); } catch (_) { continue; }
    if (!detailUrlRe.test(href)) continue;
    const title = cleanText(m[2] || '').slice(0, 120);
    if (!title) continue;
    const publishDate = (m[3] && /^\d{4}-\d{2}-\d{2}$/.test(m[3])) ? m[3] : dateFromUrl(href);
    out.push({ url: href, title, publishDate });
  }
  return out;
}


function extractAnchors(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try { url = new URL(m[1], baseUrl).toString(); } catch (_) { continue; }
    const title = cleanText(m[2] || '').slice(0, 120);
    out.push({ url, title });
  }
  return out;
}

function scoreEntry(link, keywords = []) {
  const hay = `${link.title} ${link.url}`.toLowerCase();
  let score = 0;
  for (const k of keywords) if (hay.includes(String(k).toLowerCase())) score += 20;
  if (/zhengce|zcwj|zfwj|xzgfx|gfxwj|gongbao|zfgb|policy|zwgk/.test(hay)) score += 15;
  if (/login|signin|video|photo|mail|互动|留言/.test(hay)) score -= 40;
  return score;
}

async function mapLimit(list, limit, worker) {
  const arr = Array.from(list || []);
  const out = new Array(arr.length);
  let next = 0;
  const n = Math.max(1, Math.min(arr.length || 1, Number(limit) || 1));
  async function run() {
    while (true) {
      const i = next++;
      if (i >= arr.length) return;
      try { out[i] = { ok: true, value: await worker(arr[i], i) }; }
      catch (error) { out[i] = { ok: false, error }; }
    }
  }
  await Promise.all(Array.from({ length: n }, () => run()));
  return out;
}

async function discoverChannelItems(ch, maxPages = 3, diagnostics = null) {
  const roots = [...new Set([...(ch.seedUrls || []), ch.rootUrl, new URL('/zwgk/', ch.rootUrl).toString(), new URL('/zhengce/', ch.rootUrl).toString()].filter(Boolean))];
  const entryMap = new Map();
  let rootOk = 0;
  let rootFailed = 0;
  const errors = [];

  // 根入口有限并发：坏站不再按 URL 一个个累计超时。
  const rootResults = await mapLimit(roots, CHANNEL_CONCURRENCY, async (root) => {
    const r = await getHtml(root);
    return { root, ...r };
  });
  for (let i = 0; i < rootResults.length; i++) {
    const rr = rootResults[i];
    const root = roots[i];
    if (!rr.ok) {
      rootFailed += 1;
      errors.push(`${root} ${rr.error?.message || rr.error}`);
      continue;
    }
    const { status, headers, buf } = rr.value;
    if (status !== 200) {
      rootFailed += 1;
      errors.push(`${root} HTTP ${status}`);
      continue;
    }
    rootOk += 1;
    const html = decode(buf, headers['content-type'] || '');
    for (const a of extractAnchors(html, root)) {
      const sc = scoreEntry(a, ch.keywords || []);
      if (sc < 20) continue;
      const old = entryMap.get(a.url);
      if (!old || old.score < sc) entryMap.set(a.url, { ...a, score: sc });
    }
  }

  const entries = [...entryMap.values()].sort((a,b)=>b.score-a.score).slice(0, Math.max(3, maxPages * 3));
  const entryTargets = entries.slice(0, Math.max(3, maxPages * 2));
  const found = new Map();
  let entryOk = 0;
  let entryFailed = 0;
  const baseHost = (() => { try { return new URL(ch.rootUrl).hostname.replace(/^www\./,''); } catch (_) { return ''; } })();

  const entryResults = await mapLimit(entryTargets, CHANNEL_CONCURRENCY, async (entry) => {
    const r = await getHtml(entry.url);
    return { entry, ...r };
  });
  for (let i = 0; i < entryResults.length; i++) {
    const er = entryResults[i];
    const entry = entryTargets[i];
    if (!er.ok) {
      entryFailed += 1;
      errors.push(`${entry.url} ${er.error?.message || er.error}`);
      continue;
    }
    const { status, headers, buf } = er.value;
    if (status !== 200) {
      entryFailed += 1;
      errors.push(`${entry.url} HTTP ${status}`);
      continue;
    }
    entryOk += 1;
    const html = decode(buf, headers['content-type'] || '');
    for (const a of extractAnchors(html, entry.url)) {
      const sameHost = (() => {
        try {
          const host = new URL(a.url).hostname.replace(/^www\./,'');
          return host === baseHost || host.endsWith('.' + baseHost) || baseHost.endsWith('.' + host);
        } catch (_) { return false; }
      })();
      if (!sameHost || !a.title || a.title.length < 5) continue;
      const hay = `${a.title} ${a.url}`;
      const policyish = /(政策|通知|办法|规定|意见|标准|实施|细则|公报|工资|公积金|津贴|产假|育儿假|医疗|残保金|社会保障|人力资源)/.test(hay) || /\/art\/|content|t20\d{6}|\.shtml|\.html/.test(a.url);
      if (!policyish) continue;
      if (/index(?:_\d+)?\.s?html?$|\/index\/?$/i.test(a.url)) continue;
      found.set(a.url, { url: a.url, title: a.title, publishDate: dateFromUrl(a.url) });
    }
  }

  if (entryTargets.length) await new Promise((r)=>setTimeout(r, PAGE_GAP_MS));
  if (diagnostics) Object.assign(diagnostics, {
    roots: roots.length,
    rootOk,
    rootFailed,
    entriesDiscovered: entries.length,
    entryOk,
    entryFailed,
    errors: errors.slice(-8),
  });
  return [...found.values()];
}

/** 读/写本地缓存：先 fs 读，失败则 https 拉一次落盘再读。返回字符串 xml。 */
async function loadOrFetchSitemap(cachePath, sitemapUrl) {
  const fs = require('fs');
  const path = require('path');
  const abs = path.isAbsolute(cachePath) ? cachePath : path.join(process.cwd(), cachePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs) && fs.statSync(abs).size > 1024) {
    return fs.readFileSync(abs, 'utf8');
  }
  const { status, buf } = await getHtml(sitemapUrl);
  if (status !== 200) throw new Error(`sitemap HTTP ${status}: ${sitemapUrl}`);
  fs.writeFileSync(abs, buf);
  return buf.toString('utf8');
}

/** 从 sitemap XML 抽 <loc>/<lastmod>，按 path 前缀过滤 */
function parseSitemap(xml, pathPrefixes = []) {
  const out = [];
  // 简单 XML 块匹配：单条 <url>...</url>，内含 <loc>与<lastmod>
  const blockRe = /<url>([\s\S]*?)<\/url>/g;
  let m;
  while ((m = blockRe.exec(xml))) {
    const blk = m[1];
    const loc = /<loc>([^<]+)<\/loc>/.exec(blk)?.[1] || '';
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(blk)?.[1] || '';
    if (!loc) continue;
    let pathname = '';
    try { pathname = new URL(loc).pathname; } catch (_) { continue; }
    // 去掉 /index_N.html 之类分页（sitemap 里是详情页，没有分页，正常）
    const hitPrefix = pathPrefixes.find((p) => pathname.startsWith('/' + p.replace(/^\//, '')) || pathname.includes('/' + p.replace(/^\//, '')));
    if (!hitPrefix) continue;
    const dateOnly = (/(\d{4}-\d{2}-\d{2})/.exec(lastmod) || [])[1] || '';
    // 标题兜底：从路径里抽末段（content/post_4951031 → post_4951031），无标题也接受详情页 dedup
    const seg = pathname.replace(/\.html$/, '').split('/').filter(Boolean).pop() || loc;
    out.push({ url: loc, title: seg, publishDate: dateOnly });
  }
  return out;
}

/**
 * 枚举某省全部已注册栏目（可选限制页数与最早日期）
 * @param {string} province 标准省名（如 '广东省'）
 * @param {{maxPages?: number, since?: string, onPage?: (p:number,total:number,got:number)=>void}} opts
 * @returns {Promise<Array<{url,title,publishDate,province,channel}>>}
 */
async function processChannel(province, ch, opts = {}) {
  const { maxPages = Infinity, since = '', onPage } = opts;
  const diag = { label: ch.label, type: ch.type || 'page', ok: false, requests: 0, success: 0, failed: 0, itemCount: 0, lastError: '', errors: [] };
  const localItems = [];

  if ((ch.type || 'page') === 'page') {
    let emptyStreak = 0;
    const total = Math.min(ch.pageCount || Infinity, maxPages);
    for (let p = 1; p <= total; p++) {
      const url = ch.pageUrl(p);
      let html = '';
      diag.requests += 1;
      try {
        const { status, headers, buf } = await getHtml(url);
        if (status !== 200) throw new Error(`HTTP ${status}`);
        diag.success += 1;
        html = decode(buf, headers['content-type'] || '');
      } catch (e) {
        diag.failed += 1;
        diag.lastError = `${url} ${e.message}`;
        diag.errors.push(diag.lastError);
        console.log(`[enum] ${ch.label} 第${p}页失败: ${e.message}`);
        if (++emptyStreak >= 3) break;
        continue;
      }
      const items = parseListPage(html, url, ch);
      if (!items.length) {
        emptyStreak += 1;
        if (emptyStreak >= 3) break;
        continue;
      }
      emptyStreak = 0;
      let added = 0;
      for (const it of items) {
        if (since && it.publishDate && it.publishDate < since) continue;
        localItems.push({ ...it, province, channel: ch.label });
        added += 1;
      }
      diag.itemCount += added;
      if (onPage) onPage(p, total, items.length);
      await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    }
    diag.ok = diag.success > 0 && diag.itemCount > 0;
    if (diag.success > 0 && diag.itemCount === 0 && !diag.lastError) diag.lastError = 'HTTP成功但未解析到详情链接（可能页面改版）';
    return { diag, items: localItems };
  }

  if (ch.type === 'discover') {
    diag.requests = 1;
    try {
      const dd = {};
      const items = await discoverChannelItems(ch, Math.min(3, Number.isFinite(maxPages) ? maxPages : 3), dd);
      diag.success = (dd.rootOk || 0) + (dd.entryOk || 0);
      diag.failed = (dd.rootFailed || 0) + (dd.entryFailed || 0);
      diag.requests = diag.success + diag.failed;
      diag.errors = dd.errors || [];
      diag.lastError = diag.errors[diag.errors.length - 1] || '';
      diag.ok = (dd.rootOk || 0) > 0 && items.length > 0;
      if ((dd.rootOk || 0) > 0 && items.length === 0 && !diag.lastError) diag.lastError = '入口可访问但未发现政策详情链接';
      if (onPage) onPage(1, 1, items.length);
      for (const it of items) {
        if (since && it.publishDate && it.publishDate < since) continue;
        localItems.push({ ...it, province, channel: ch.label });
        diag.itemCount += 1;
      }
    } catch (e) {
      diag.failed += 1;
      diag.lastError = e.message;
      diag.errors.push(e.message);
      console.log(`[enum] ${ch.label} 自动发现失败: ${e.message}`);
    }
    return { diag, items: localItems };
  }

  if (ch.type === 'sitemap') {
    diag.requests = 1;
    try {
      const xml = await loadOrFetchSitemap(ch.cachePath, ch.sitemapUrl);
      diag.success = 1;
      const items = parseSitemap(xml, ch.pathPrefixes || []);
      diag.ok = items.length > 0;
      if (!items.length) diag.lastError = 'sitemap 可访问但没有匹配政策路径';
      if (onPage) onPage(1, 1, items.length);
      for (const it of items) {
        if (since && it.publishDate && it.publishDate < since) continue;
        localItems.push({ ...it, title: it.title || '(无标题，需抓详情)', province, channel: ch.label });
        diag.itemCount += 1;
      }
      await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    } catch (e) {
      diag.failed = 1;
      diag.lastError = e.message;
      diag.errors.push(e.message);
      console.log(`[enum] ${ch.label} sitemap 失败: ${e.message}`);
    }
    return { diag, items: localItems };
  }

  diag.failed = 1;
  diag.lastError = `未知 channel type: ${ch.type}`;
  diag.errors.push(diag.lastError);
  console.log(`[enum] ${diag.lastError}`);
  return { diag, items: localItems };
}

async function enumerateProvinceDetailed(province, opts = {}) {
  const channels = PROVINCE_CHANNELS[province];
  if (!channels || !channels.length) throw new Error(`未注册省份栏目源: ${province}（现有: ${Object.keys(PROVINCE_CHANNELS).join('/')}）`);

  // 同一省的多个栏目有限并发，避免坏 URL 一个个累计 6~8 秒超时。
  const results = await mapLimit(channels, CHANNEL_CONCURRENCY, (ch) => processChannel(province, ch, opts));
  const diagnostics = [];
  const seen = new Map();
  for (let i = 0; i < results.length; i++) {
    const rr = results[i];
    if (!rr.ok) {
      diagnostics.push({ label: channels[i].label, type: channels[i].type || 'page', ok:false, requests:1, success:0, failed:1, itemCount:0, lastError:String(rr.error?.message || rr.error || 'channel failed'), errors:[String(rr.error?.message || rr.error || 'channel failed')] });
      continue;
    }
    diagnostics.push(rr.value.diag);
    for (const it of rr.value.items || []) if (!seen.has(it.url)) seen.set(it.url, it);
  }

  return {
    items: [...seen.values()],
    diagnostics,
    ok: diagnostics.some((d) => d.ok),
    allFailed: diagnostics.length > 0 && diagnostics.every((d) => !d.ok),
  };
}

async function enumerateProvince(province, opts = {}) {
  const result = await enumerateProvinceDetailed(province, opts);
  return result.items;
}

/** 已注册省份列表 */
function registeredProvinces() {
  return Object.keys(PROVINCE_CHANNELS);
}

module.exports = { PROVINCE_CHANNELS, enumerateProvince, enumerateProvinceDetailed, parseListPage, parseSitemap, loadOrFetchSitemap, registeredProvinces, extractAnchors, scoreEntry, discoverChannelItems };
