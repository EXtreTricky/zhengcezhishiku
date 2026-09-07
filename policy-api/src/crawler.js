/**
 * crawler.js —— 政策真爬虫：搜索引擎发现 → 原文抓取 → 字段提取 → 待确认池
 *
 * 链路：cn.bing.com 站内搜索（国内直连、无需 Key）
 *   → gov.cn 原文页抓取（自动处理 GBK/UTF-8 编码）
 *   → llm.aiExtractFromText 提取文号/日期/机关
 *   → classifyCategory 10 类白名单过滤
 *   → 调用方负责写入 db.crawlQueue 并比对正式库
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const llm = require('../../src/llm');
const { classifyCategory } = require('./crawl-api');
const { POLICY_SOURCES } = require('./policy-sources');
const { judge } = require('./quality-gate');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 8000;
const MAX_DETAIL_PAGES = 6;

/** 省份推断表：关键词 → 标准省名 */
const PROVINCE_MAP = [
  ['北京', '北京市'], ['上海', '上海市'], ['天津', '天津市'], ['重庆', '重庆市'],
  ['广东', '广东省'], ['广州', '广东省'], ['深圳', '广东省'], ['珠海', '广东省'],
  ['江苏', '江苏省'], ['南京', '江苏省'], ['苏州', '江苏省'],
  ['浙江', '浙江省'], ['杭州', '浙江省'], ['宁波', '浙江省'],
  ['山东', '山东省'], ['济南', '山东省'], ['青岛', '山东省'],
  ['四川', '四川省'], ['成都', '四川省'],
  ['湖北', '湖北省'], ['武汉', '湖北省'],
  ['湖南', '湖南省'], ['长沙', '湖南省'],
  ['河南', '河南省'], ['郑州', '河南省'],
  ['河北', '河北省'], ['石家庄', '河北省'],
  ['福建', '福建省'], ['福州', '福建省'], ['厦门', '福建省'],
  ['安徽', '安徽省'], ['合肥', '安徽省'],
  ['陕西', '陕西省'], ['西安', '陕西省'],
  ['山西', '山西省'], ['太原', '山西省'],
  ['江西', '江西省'], ['南昌', '江西省'],
  ['辽宁', '辽宁省'], ['沈阳', '辽宁省'], ['大连', '辽宁省'],
  ['吉林', '吉林省'], ['长春', '吉林省'],
  ['黑龙江', '黑龙江省'], ['哈尔滨', '黑龙江省'],
  ['广西', '广西壮族自治区'], ['南宁', '广西壮族自治区'],
  ['海南', '海南省'], ['海口', '海南省'],
  ['贵州', '贵州省'], ['贵阳', '贵州省'],
  ['云南', '云南省'], ['昆明', '云南省'],
  ['甘肃', '甘肃省'], ['兰州', '甘肃省'],
  ['青海', '青海省'], ['宁夏', '宁夏回族自治区'], ['新疆', '新疆维吾尔自治区'],
  ['西藏', '西藏自治区'], ['内蒙古', '内蒙古自治区'],
];

function uid() {
  return 'crw_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

/** 带重定向的 GET，返回 { buf, headers, finalUrl, status } */
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    let mod;
    try {
      mod = url.startsWith('https') ? https : http;
    } catch {
      return reject(new Error('非法 URL'));
    }
    const req = mod.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: FETCH_TIMEOUT,
    }, (res) => {
      const { statusCode, headers } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location && redirects > 0) {
        res.resume();
        const next = new URL(headers.location, url).toString();
        return resolve(httpGet(next, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), headers, finalUrl: url, status: statusCode }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 按 charset 解码 HTML（政府站大量 GBK/GB2312） */
function decodeHtml(buf, contentType = '') {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buf.slice(0, 2048).toString('latin1');
    charset = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  const cs = (charset || 'utf-8').toLowerCase();
  try {
    if (['gbk', 'gb2312', 'gb18030'].includes(cs)) return new TextDecoder('gb18030').decode(buf);
    return new TextDecoder('utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 去标签取纯文本 */
function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从整页纯文本里切出「政策正文主体」：去掉站点导航/头部/页脚噪声。
 * 政府站正文通常以 通知标题/文号/正文起始语 开头，以 附件/版权/打印 收尾。
 */
function extractBody(text) {
  let t = String(text || '').trim();
  const startRe = /关于[\s\S]{0,60}?通知|〔20\d{2}〕|(?:各市|各地|为切实|为贯彻|为进一步|根据《|按照《|现将|经研究)/;
  const m = t.search(startRe);
  const bodyStart = m > 0 && m < 700 ? m : 0;
  if (bodyStart > 0) t = t.slice(bodyStart);
  const cutRe = /相关附件|附件[:：]|附件下载|扫一扫在手机|友情链接|网站地图|主办单位|技术支持[:：]|版权所有|CopyRight|打印本页|关闭窗口|【打印】/;
  const cut = t.search(cutRe);
  if (cut > 80) t = t.slice(0, cut);
  return t;
}

/** 中国政府网政策库搜索（主力通道）：官方 JSON API，无反爬、结果全是 gov.cn 原文直链 */
async function govLibSearch(keyword, count = 10) {
  const year = new Date().getFullYear();
  const url =
    'https://sousuo.www.gov.cn/search-gov/data?t=zhengcelibrary&q=' +
    encodeURIComponent(keyword) +
    `&sort=pubtime&searchfield=title&pubtimeyear=${year}&p=1&n=${count}`;
  const { buf, status } = await httpGet(url);
  if (status !== 200) throw new Error(`gov政策库 HTTP ${status}`);
  const json = JSON.parse(buf.toString('utf8'));
  const out = [];
  const catMap = (json && json.searchVO && json.searchVO.catMap) || {};
  for (const cat of Object.values(catMap)) {
    for (const it of cat.listVO || []) {
      if (!it.url || !/^https?:\/\//.test(it.url)) continue;
      if (out.some((r) => r.url === it.url)) continue;
      out.push({
        url: it.url,
        title: stripTags(it.title || ''),
        snippet: stripTags(it.summary || ''),
        publishDate: String(it.pubtimeStr || '').replace(/\./g, '-'),
        docNumber: it.pcode || it.wenhao || '',
        org: it.fwdw || '',
      });
      if (out.length >= count) return out;
    }
  }
  return out;
}

/** bing 国内版搜索，返回 [{ url, title, snippet }]（备用路径，对中文长查询易降级） */
async function bingSearch(query, count = 8) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${count}&setlang=zh-CN`;
  const { buf, headers, status } = await httpGet(url);
  if (status !== 200) throw new Error(`搜索失败 HTTP ${status}`);
  const html = decodeHtml(buf, headers['content-type']);
  const results = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = re.exec(html)) && results.length < count) {
    const link = m[1];
    if (!/^https?:\/\//.test(link)) continue;
    results.push({
      url: link,
      title: stripTags(m[2]),
      snippet: stripTags(m[3] || ''),
    });
  }
  return results;
}

/** 百度搜索（主力路径）：结果页 data-tools 属性直接含真实 URL，无需逐条跳转 */
async function baiduSearch(query, count = 10) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${count}`;
  const { buf, headers, status } = await httpGet(url);
  if (status !== 200) throw new Error(`百度搜索失败 HTTP ${status}`);
  const html = decodeHtml(buf, headers['content-type']);
  const results = [];
  // 优先从 data-tools JSON 提取真实 URL
  const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*?(?:data-tools='([^']*)')?[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < count) {
    let realUrl = '';
    let title = stripTags(m[3]);
    if (m[2]) {
      try {
        const meta = JSON.parse(m[2].replace(/&quot;/g, '"'));
        realUrl = meta.url || '';
        title = meta.title || title;
      } catch { /* data-tools 解析失败则用跳转链 */ }
    }
    const link = /^https?:\/\//.test(realUrl) ? realUrl : m[1];
    if (!/^https?:\/\//.test(link)) continue;
    if (results.some((r) => r.url === link)) continue;
    results.push({ url: link, title, snippet: '' });
  }
  return results;
}

/** 百度跳转链解析真实 URL（data-tools 缺失时的兜底） */
async function resolveBaiduLink(url) {
  try {
    const { finalUrl } = await httpGet(url, 2);
    return finalUrl;
  } catch {
    return url;
  }
}

/** 抓政策详情页，提取 { title, publishDate, text } */
async function fetchPolicyText(url) {
  const { buf, headers, status } = await httpGet(url);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const html = decodeHtml(buf, headers['content-type']);
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '')
    .replace(/[-_|].*$/, '')
    .trim();
  // 正文容器优先：多数 gov 站详情页把正文包在 class 含 content/article/detail 的容器里，
  // 先切到容器再 strip，可整段甩掉顶部导航与页头噪声。
  let bodyHtml = html;
  const containerRe = /<(?:div|article|main|section)[^>]*class=["'][^"']*(?:content|article|detail|zwxl|zoom|TRS_Editor|article-content|pages_content)[^"']*["']/i;
  const mC = containerRe.exec(bodyHtml);
  if (mC) bodyHtml = bodyHtml.slice(mC.index, mC.index + 120000);
  const text = extractBody(stripTags(bodyHtml)).slice(0, 12000);
  const dateMatch = /(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/.exec(text);
  const publishDate = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : '';
  return { title, publishDate, text };
}

/** 从文本推断省份（入参 region 非「全国」时优先用入参） */
function inferRegion(text, inputRegion) {
  if (inputRegion && inputRegion !== '全国') {
    for (const [kw, prov] of PROVINCE_MAP) {
      if (inputRegion.includes(kw)) return prov;
    }
    return inputRegion;
  }
  for (const [kw, prov] of PROVINCE_MAP) {
    if (String(text).includes(kw)) return prov;
  }
  return '';
}

/** 判断链接是否像政策原文页（排除列表页/专题页/无关域） */
function looksLikePolicyPage(url, title) {
  if (!/gov\.cn|mohrss|gov\.hk|gov\.mo/.test(url)) return false;
  if (/search|sousuo|index\.s?html?$|list|channel|column|zhuanti|special/i.test(url)) return false;
  return /通知|公告|标准|调整|办法|规定|意见|决定|批复|最低工资|津贴|公积金|产假|病假|补偿/.test(title + url);
}

/**
 * 搜索发现（发现层 A）：关键词 → gov.cn 政策库 JSON API + 百度/bing SERP
 * @param {{keyword: string, region: string}} input
 * @returns {Promise<Array>} candidates: [{url,title,snippet,publishDate,docNumber,org}]
 */
async function discoverBySearch({ keyword, region }) {
  const year = new Date().getFullYear();
  const regionPart = region === '全国' ? '' : region;
  // 百度为主（中文查询理解好）：带地区 + 不带地区两路；bing 一路兜底（对中文长查询易降级）
  const searchPlan = [
    { engine: 'baidu', q: `${regionPart} ${keyword} 通知 ${year}`.trim() },
    { engine: 'baidu', q: `${keyword} 调整 标准 ${year} site:gov.cn` },
    { engine: 'bing', q: `${regionPart} ${keyword} ${year}`.trim() },
  ];

  // 1. 搜索发现：gov.cn 政策库 API 为主力（稳定 JSON），百度/bing SERP 为补充（可能抖动）
  const found = new Map();
  const libResult = await govLibSearch(keyword, 10).catch((e) => {
    console.log('[crawler] gov政策库失败:', e.message);
    return [];
  });
  for (const hit of libResult) found.set(hit.url, hit);

  const searchResults = await Promise.allSettled(
    searchPlan.map(({ engine, q }) => (engine === 'baidu' ? baiduSearch(q, 10) : bingSearch(q, 8))),
  );
  for (const r of searchResults) {
    if (r.status !== 'fulfilled') continue;
    for (const hit of r.value) {
      if (!found.has(hit.url)) found.set(hit.url, hit);
    }
  }
  const govHits = [...found.values()].filter((h) => /gov\.cn|mohrss/.test(h.url));
  const candidates = govHits
    .filter((h) => looksLikePolicyPage(h.url, h.title + h.snippet))
    .slice(0, MAX_DETAIL_PAGES);
  console.log(`[crawler] 搜索命中 ${found.size} 条（gov.cn ${govHits.length}），候选 ${candidates.length} 条`);
  return candidates;
}

/**
 * 候选 → 待确认条目（抓正文 + 抽取 + AI 补全 + 表字段候选）
 * 搜索 / 枚举（省级栏目）两条发现通道共用同一组装管线。
 * @param {Array} candidates [{url,title,snippet,publishDate,docNumber,org}]
 * @param {{keyword?: string, region?: string}} ctx keyword 参与分类判定、region 参与地区过滤
 * @returns {Promise<Array>} crawlQueue 记录数组（未写库，由调用方持久化）
 */
async function candidatesToItems(candidates, { keyword = '', region = '' } = {}) {
  // 2. 并行抓详情页
  const pages = await Promise.allSettled(candidates.map((h) => fetchPolicyText(h.url)));
  console.log(`[crawler] 详情页成功 ${pages.filter((p) => p.status === 'fulfilled').length}/${pages.length}`);

  // 3. 地区过滤基准（非全国时只保留目标省或全国性政策）
  const targetProv = region && region !== '全国' ? inferRegion(region, region) : '';

  // 4. 组装记录（10 类白名单过滤 + 地区过滤）
  const now = new Date().toISOString();
  let items = [];
  for (let i = 0; i < candidates.length; i++) {
    const hit = candidates[i];
    const page = pages[i].status === 'fulfilled' ? pages[i].value : null;
    const title = (page?.title || hit.title || '').slice(0, 80);
    if (!title) continue;
    const bodyText = page?.text || hit.snippet || '';
    const category = classifyCategory(`${title} ${keyword} ${bodyText.slice(0, 300)}`);
    if (!category || category === '薪酬月刊') continue; // 非 10 类白名单丢弃

    const provRaw = inferRegion(`${title} ${bodyText.slice(0, 500)}`, '');
    if (targetProv && provRaw && provRaw !== targetProv) { console.log(`[crawler] 丢弃(非目标省 ${provRaw}): ${title.slice(0, 30)}`); continue; }
    // 无省份归属的按全国性政策保留（正式库也有「省份：全国」的记录形态）
    const prov = provRaw || '全国';

    const ex = llm.aiExtractFromText(`${title}\n${bodyText.slice(0, 2000)}`);
    const amountM = /(\d{3,5})\s*元[/.]?\s*(月|小时|日|天)?/.exec(bodyText);
    // 生效日期：优先匹配「自X年X月X日起施行/执行」
    const effM = /自\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*起/.exec(bodyText);
    const effectiveDate = effM
      ? `${effM[1]}-${String(Number(effM[2])).padStart(2, '0')}-${String(Number(effM[3])).padStart(2, '0')}`
      : '';

    const fullTitle = `${prov ? prov.replace(/[省市壮族回族维吾尔自治区]+$/g, '') + ' ' : ''}${title}`.slice(0, 80);

    // ── 入池质量闸门：丢弃一眼假噪音，存疑条目标记 quality 供审批台折叠 ──
    const gate = judge({
      title: fullTitle,
      url: hit.url,
      category,
      summary: hit.snippet || '',
      content: bodyText,
      valuesSuggest: ex.valuesSuggest || [],
    });
    if (gate.level === 'drop') {
      console.log(`[gate] 丢弃「${fullTitle.slice(0, 34)}」→ ${gate.reasons.join('；')}`);
      continue;
    }

    items.push({
      id: uid(),
      status: 'pending',
      createdAt: now,
      title: gate.title, // 已清洗站点名尾缀
      region: prov,
      summary: (hit.snippet || bodyText.slice(0, 200)).slice(0, 200),
      content: bodyText.slice(0, 4000),
      releaseDate: page?.publishDate || hit.publishDate || ex.releaseDate || '',
      effectiveDate,
      url: hit.url,
      org: /gov\.cn/.test(hit.url) ? (ex.org || hit.org || '政府部门官网') : '',
      source: /gov\.cn/.test(hit.url) ? '' : '网络检索',
      category,
      amount: amountM ? amountM[0] : '',
      documentNumber: ex.documentNumber || hit.docNumber || '',
      quality: gate.level, // 'pass' | 'suspect'（默认 pass，前端折叠时按 !== 'pass' 判断）
      qualityReasons: gate.reasons,
      crawledBy: 'online-crawler',
    });
  }
  // 4.3 标题近义去重：同一文件常有多入口（新闻稿/通知原文/转载页），
  //     只保留同地区同标题（相似度>0.95）里正文最长的版本。
  {
    const deduped = [];
    for (const it of items) {
      const idx = deduped.findIndex(
        (o) => o.region === it.region && llm.similarity(o.title, it.title) > 0.95,
      );
      if (idx >= 0) {
        if ((it.content || '').length > (deduped[idx].content || '').length) deduped[idx] = it;
      } else {
        deduped.push(it);
      }
    }
    if (deduped.length !== items.length) {
      console.log(`[crawler] 标题近义去重：${items.length} → ${deduped.length} 条`);
      items = deduped;
    }
  }

  // 4.5 可选 AI 精提取补全（LLM 配置后才启用）：补正则抓不到/抓不准的文号、机关、
  //     生效日期、金额、摘要。原则：只填空、必校验格式，绝不覆盖正则已确认的关键字段。
  if (items.length && llm.llmEnabled()) {
    const aiResults = await Promise.allSettled(
      items.map((it) => llm.aiExtractCrawl(`${it.title || ''}\n${(it.content || '').slice(0, 2500)}`)),
    );
    let filled = 0;
    aiResults.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value || typeof r.value !== 'object') return;
      const ai = r.value;
      const it = items[i];
      if (!it.documentNumber && /〔\d{4}〕\s*\d+\s*号/.test(String(ai.documentNumber || ''))) {
        it.documentNumber = String(ai.documentNumber).trim();
      }
      if (!it.org && ai.org) it.org = String(ai.org).slice(0, 40);
      if (!it.releaseDate && /^20\d{2}-\d{2}-\d{2}/.test(String(ai.releaseDate || ''))) {
        it.releaseDate = String(ai.releaseDate).slice(0, 10);
      }
      if (!it.effectiveDate && /^20\d{2}-\d{2}-\d{2}/.test(String(ai.effectiveDate || ''))) {
        it.effectiveDate = String(ai.effectiveDate).slice(0, 10);
      }
      if (!it.amount && /^\d{3,5}\s*元/.test(String(ai.amount || ''))) it.amount = String(ai.amount).trim();
      if (!it.summary && ai.summary) it.summary = String(ai.summary).slice(0, 150);
      filled += 1;
    });
    console.log(`[crawler] AI 精提取补全 ${filled}/${items.length} 条（LLM 已启用）`);
  }

  // 4.7 表字段候选：把每条 item 映射到「目标专题表列」的结构化数值/日期候选。
  //     值存两处：valuesSuggest（全候选，供审批页行预览展示）+ values（规则闸后的
  //     最佳值映射，confirm 时由 buildWriteFields 真实写入对应数值/日期列）。
  if (items.length) {
    let withSuggest = 0;
    const enriched = await Promise.allSettled(
      items.map(async (it) => {
        const src = POLICY_SOURCES.find((s) => s.category === it.category);
        if (!src) return null;
        const cols = [
          ...(src.valueFields || []).map((n) => ({ name: n, kind: 'number' })),
          ...(src.dateFields || []).map((n) => ({ name: n, kind: 'date' })),
        ];
        if (!cols.length) return null;
        const text = `${it.title || ''}\n${(it.content || '').slice(0, 4000)}`;
        const suggs = await llm.suggestTableValues(text, cols);
        if (!suggs.length) return null;
        const vmap = {};
        for (const s of suggs) {
          if (!s || s.value === '' || s.value === undefined) continue;
          let ok = true;
          let finalVal = s.value;
          if (s.colType === 'date') {
            ok = /^20\d{2}-\d{2}-\d{2}$/.test(String(s.value));
          } else if (s.colType === 'number' && s.unit === '%') {
            const n = parseFloat(String(s.value).replace(/[^\d.]/g, ''));
            ok = Number.isFinite(n) && n >= 0 && n <= 100;
            if (ok) finalVal = n;
          } else if (s.colType === 'number') {
            const n = parseFloat(String(s.value).replace(/[^\d.]/g, ''));
            ok = Number.isFinite(n) && n >= 0 && n <= 2000000;
            if (ok) finalVal = n;
          }
          if (ok && vmap[s.col] === undefined) vmap[s.col] = finalVal;
        }
        it.srcTableId = src.tableId;
        it.valuesSuggest = suggs;
        it.values = vmap;
        withSuggest += 1;
        return it;
      }),
    );
    void enriched;
    console.log(`[crawler] 表字段候选 ${withSuggest}/${items.length} 条`);
  }
  return items;
}

/** 真爬取主流程（搜索模式，兼容原调用方语义） */
async function crawlPolicies({ keyword, region }) {
  const candidates = await discoverBySearch({ keyword, region });
  return candidatesToItems(candidates, { keyword, region });
}

module.exports = {
  crawlPolicies,
  discoverBySearch,
  candidatesToItems,
  bingSearch,
  baiduSearch,
  fetchPolicyText,
};
