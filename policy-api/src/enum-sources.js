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
const TIMEOUT = 10000;
const PAGE_GAP_MS = 400; // 温和限速

/** 栏目源注册表
 *  type: 'page'  —— 列表分页型（现有模式）
 *    字段：pageCount（总页数，未知可给大值靠空页中断）、pageUrl(n)（分页 URL 函数）、
 *          listRe（可选，列表容器，缺省 <ul class="list">）、itemRe（可选，条目正则，须捕获 url/title/date 三组）、
 *          detailUrlRe（可选，详情链接特征过滤，缺省 /content\/post_/，即广东人社局详情页形态）
 *  type: 'sitemap' —— 全站 sitemap.xml 索引型（一次性拿 N 多条目，按 path 前缀过滤）
 *    提供：sitemapUrl、pathPrefixes（任一前缀命中即纳入）、cachePath（本地缓存避免每次重拉；不存在时拉一次落到磁盘）
 */
const PROVINCE_CHANNELS = {
  广东省: [
    {
      label: '省人社厅·规范性文件',
      type: 'page',
      pageCount: 39,
      pageUrl: (n) =>
        n <= 1
          ? 'https://hrss.gd.gov.cn/zwgk/xxgkml/bmwj/gfxwj/index.html'
          : `https://hrss.gd.gov.cn/zwgk/xxgkml/bmwj/gfxwj/index_${n}.html`,
      detailUrlRe: /content\/post_/,
      // 列表容器 + 条目：<li><a href=绝对URL title=标题>…</a><span class="pubDate">YYYY-MM-DD</span></li>
      listRe: /<ul class="list"[^>]*>([\s\S]*?)<\/ul>/i,
      itemRe: /<a href="([^"]+)" title="([^"]+)">[\s\S]*?(?:<span class="pubDate"[^>]*>(\d{4}-\d{2}-\d{2}))?/g,
    },
    {
      label: '省人社厅·政策解读',
      type: 'sitemap',
      sitemapUrl: 'https://hrss.gd.gov.cn/sitemap.xml',
      pathPrefixes: ['zcfg/zcjd/'], // 仅留以 /zcfg/zcjd/ 开头的政策解读类详情页
      cachePath: '.workbuddy/_enum-cache/gd-sitemap.xml',
    },
    {
      label: '省人社厅·公示公告',
      type: 'sitemap',
      sitemapUrl: 'https://hrss.gd.gov.cn/sitemap.xml',
      pathPrefixes: ['zwgk/gsgg/'],
      cachePath: '.workbuddy/_enum-cache/gd-sitemap.xml',
    },
    {
      label: '省人社厅·信息公开目录',
      type: 'sitemap',
      sitemapUrl: 'https://hrss.gd.gov.cn/sitemap.xml',
      pathPrefixes: ['zwgk/xxgkml/'], // 整个母目录（含 gfxwj/通知公告/部门文件等多个子栏目）
      cachePath: '.workbuddy/_enum-cache/gd-sitemap.xml',
    },
  ],
  福建省: [
    {
      // 结构取证：<ul class="clearflx nyncgl-box-list"><li><a href="相对.htm" title="标题"><span class="bf-pass">日期</span>…<p>标题</p></a>
      // 单页全量（无翻页），详情 URL 形如 /zw/gsgg/202608/t20260805_7196556.htm
      label: '省人社厅·公示公告',
      type: 'page',
      pageCount: 1,
      pageUrl: () => 'https://rst.fujian.gov.cn/zw/gsgg/',
      detailUrlRe: /\/t\d+_\d+\.htm$/,
      listRe: null, // 全页按 itemRe 抓（页面含多个 nyncgl tab 容器，不截断）
      // 取证结构：<a href="../…t20260901_7207218.htm" title="标题" target="_blank"><span class="bf-pass">2026-09-01</span>
      // title 后可能跟 target 等其它属性 → [^>]* 兜住；[^>] 不跨标签，安全
      itemRe: /<a[^>]+href="([^"]+)"[^>]+title="([^"]+)"[^>]*>[\s\S]*?<span class="bf-pass">(\d{4}-\d{2}-\d{2})<\/span>/g,
    },
    {
      label: '省人社厅·部门政策文件解读',
      type: 'page',
      pageCount: 1,
      pageUrl: () => 'https://rst.fujian.gov.cn/zcjd/zcjd/bmzcwjjd/',
      detailUrlRe: /\/t\d+_\d+\.htm$/,
      listRe: null, // 全页按 itemRe 抓（页面含多个 nyncgl tab 容器，不截断）
      // 取证结构：<a href="../…t20260901_7207218.htm" title="标题" target="_blank"><span class="bf-pass">2026-09-01</span>
      // title 后可能跟 target 等其它属性 → [^>]* 兜住；[^>] 不跨标签，安全
      itemRe: /<a[^>]+href="([^"]+)"[^>]+title="([^"]+)"[^>]*>[\s\S]*?<span class="bf-pass">(\d{4}-\d{2}-\d{2})<\/span>/g,
    },
    {
      label: '省人社厅·其他政策文件解读',
      type: 'page',
      pageCount: 1,
      pageUrl: () => 'https://rst.fujian.gov.cn/zcjd/zcjd/qtzcwjjd/',
      detailUrlRe: /\/t\d+_\d+\.htm$/,
      listRe: null, // 全页按 itemRe 抓（页面含多个 nyncgl tab 容器，不截断）
      // 取证结构：<a href="../…t20260901_7207218.htm" title="标题" target="_blank"><span class="bf-pass">2026-09-01</span>
      // title 后可能跟 target 等其它属性 → [^>]* 兜住；[^>] 不跨标签，安全
      itemRe: /<a[^>]+href="([^"]+)"[^>]+title="([^"]+)"[^>]*>[\s\S]*?<span class="bf-pass">(\d{4}-\d{2}-\d{2})<\/span>/g,
    },
  ],
  北京市: [
    // 取证：<a href="./202608/t20260821_4831461.html" target="_blank">标题</a>（标题在 a 内，URL 含 t2026xxxx_）
    { label: '市人社局·政策文件', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://rsj.beijing.gov.cn/xxgk/2024zcwj/' : `https://rsj.beijing.gov.cn/xxgk/2024zcwj/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{4,}?)<\/a>/g },
    { label: '市人社局·公示公告', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://rsj.beijing.gov.cn/xxgk/tzgg/' : `https://rsj.beijing.gov.cn/xxgk/tzgg/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{4,}?)<\/a>/g },
    { label: '市人社局·政策解读', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://rsj.beijing.gov.cn/xxgk/2024zcjd/' : `https://rsj.beijing.gov.cn/xxgk/2024zcjd/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{4,}?)<\/a>/g },
  ],
  上海市: [
    // 取证：<a href="/tshbx_17729/20260812/t0035_1443067.html" target="_blank" title="标题">…</a>
    { label: '市人社局·规范性文件', type: 'page', pageCount: 10, pageUrl: (n) => `https://rsj.sh.gov.cn/tgwgfx_17726/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/g },
    { label: '市人社局·公示公告', type: 'page', pageCount: 10, pageUrl: (n) => `https://rsj.sh.gov.cn/tgsgg_17341/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/g },
    { label: '市人社局·政策解读', type: 'page', pageCount: 10, pageUrl: (n) => `https://rsj.sh.gov.cn/tzcjd_17351/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/g },
  ],
  天津市: [
    // 取证：<a href='./202609/t20260903_7365587.html' title='标题' target="_blank"><span class="fl">…</span><span class="fr">2026-09-04</span>
    { label: '市人社局·政策文件', type: 'page', pageCount: 1, pageUrl: () => 'https://hrss.tj.gov.cn/zhengwugongkai/zhengcezhinan/zxwjnew/', detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href=["']([^"']+t\d+_\d+\.html)["'][^>]*title=["']([^"']+)["'][^>]*>[\s\S]*?(?:<span class="fr"[^>]*>(\d{4}-\d{2}-\d{2}))?/g },
    { label: '市人社局·公告公示', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://hrss.tj.gov.cn/xinwenzixun/gggsnew/' : `https://hrss.tj.gov.cn/xinwenzixun/gggsnew/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href=["']([^"']+t\d+_\d+\.html)["'][^>]*title=["']([^"']+)["'][^>]*>[\s\S]*?(?:<span class="fr"[^>]*>(\d{4}-\d{2}-\d{2}))?/g },
    { label: '市人社局·政策解读', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://hrss.tj.gov.cn/zhengwugongkai/zhengcezhinan/zcjdnew/' : `https://hrss.tj.gov.cn/zhengwugongkai/zhengcezhinan/zcjdnew/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href=["']([^"']+t\d+_\d+\.html)["'][^>]*title=["']([^"']+)["'][^>]*>[\s\S]*?(?:<span class="fr"[^>]*>(\d{4}-\d{2}-\d{2}))?/g },
  ],
  重庆市: [
    // 取证 A(规范性文件)：<a target="_blank" href="./202608/t20260831_16004458.html"><p class="tit">标题</p><p class="info">…
    { label: '市人社局·行政规范性文件', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://rlsbj.cq.gov.cn/zwgk_182/zfxxgkml/zcwj_145360/jfxzgfxwj/' : `https://rlsbj.cq.gov.cn/zwgk_182/zfxxgkml/zcwj_145360/jfxzgfxwj/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+t\d+_\d+\.html)"[^>]*>[\s\S]*?<p class="tit">([\s\S]*?)<\/p>/g },
    // 取证 B(通知公告)：<a href="../../ztzl/…/202609/t20260904_16031540.html" title="标题" target="_blank">…
    { label: '市人社局·通知公告', type: 'page', pageCount: 10, pageUrl: (n) => n <= 1 ? 'https://rlsbj.cq.gov.cn/zwxx_182/tzgg/' : `https://rlsbj.cq.gov.cn/zwxx_182/tzgg/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+t\d+_\d+\.html)"[^>]*title="([^"]+)"[^>]*>/g },
  ],
  浙江省: [
    // col1229116948（公示公告）经取证为6KB壳页，无静态art链接（0贡献），已移除
    // 取证 col1389535（最新政策）：20KB静态页含art链接，<a href="/col/.../art/2026/art_xxx.html" class="bt_link" title="标题" target="_blank">
    // 注：浙江用 jpaas-publish-server 系统，翻页靠JS/AJAX（?page=无效、index_2.html 404），当前仅首页静态~27条，深度翻页待API逆向
    { label: '省人社厅·最新政策', type: 'page', pageCount: 1, pageUrl: () => 'https://rlsbt.zj.gov.cn/col/col1389535/index.html', detailUrlRe: /\/art\//, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>/g },
  ],
  江苏省: [
    // 取证 A(公示公告)：<a href="/art/2026/8/31/art_78504_11822684.html" target="_blank"><span class="list_title">标题</span><i>2026-08-31</i></a>
    { label: '省人社厅·公示公告', type: 'page', pageCount: 1, pageUrl: () => 'https://jshrss.jiangsu.gov.cn/col/col78503/index.html', detailUrlRe: /\/art\//, listRe: null, itemRe: /<a[^>]+href="(\/art\/[^"]+)"[^>]*><span class="list_title">([\s\S]*?)<\/span><i>(\d{4}-\d{2}-\d{2})<\/i>/g },
    // 取证 B(政策解读)：<a target="_blank" href="/art/2025/12/29/art_77261_11701077.html" title="最低工资标准调整政策解读" id="maodian">
    { label: '省人社厅·政策解读', type: 'page', pageCount: 1, pageUrl: () => 'https://jshrss.jiangsu.gov.cn/col/col77261/index.html', detailUrlRe: /\/art\//, listRe: null, itemRe: /<a[^>]+href="(\/art\/[^"]+)"[^>]*title="([^"]+)"[^>]*>/g },
  ],
  山东省: [
    // 取证：<a href="/articles/ch00330/202609/uuid.shtml" title="标题" target="_blank">…</a>（ch00330 为单页大列表，历年公告全量）
    { label: '省人社厅·通知公告', type: 'page', pageCount: 1, pageUrl: () => 'https://hrss.shandong.gov.cn/channels/ch00330/', detailUrlRe: /\/articles\/ch\d+\/\d{6}\//, listRe: null, itemRe: /<a[^>]+href="(\/articles\/ch\d+\/\d{6}\/[^"]+\.shtml)"[^>]*>([\s\S]{4,}?)<\/a>/g },
    { label: '省人社厅·政策法规', type: 'page', pageCount: 1, pageUrl: () => 'https://hrss.shandong.gov.cn/channels/ch00470/', detailUrlRe: /\/articles\/ch\d+\/\d{6}\//, listRe: null, itemRe: /<a[^>]+href="(\/articles\/ch\d+\/\d{6}\/[^"]+\.shtml)"[^>]*>([\s\S]{4,}?)<\/a>/g },
    { label: '省人社厅·政策解读', type: 'page', pageCount: 1, pageUrl: () => 'https://hrss.shandong.gov.cn/channels/ch00580/', detailUrlRe: /\/articles\/ch\d+\/\d{6}\//, listRe: null, itemRe: /<a[^>]+href="(\/articles\/ch\d+\/\d{6}\/[^"]+\.shtml)"[^>]*>([\s\S]{4,}?)<\/a>/g },
  ],
  湖北省: [
    // 取证：<a href="http://rst.hubei.gov.cn/zfxxgk/zc/zcjd/202608/t20260828_6003076.shtml" class="w80" target="_blank" title="标题">…
    { label: '省人社厅·政策解读', type: 'page', pageCount: 8, pageUrl: (n) => n <= 1 ? 'http://rst.hubei.gov.cn/zfxxgk/zc/zcjd/' : `http://rst.hubei.gov.cn/zfxxgk/zc/zcjd/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.shtml$/, listRe: null, itemRe: /<a[^>]+href="([^"]+t\d+_\d+\.shtml)"[^>]*title="([^"]+)"[^>]*>/g },
    { label: '省人社厅·通知公告', type: 'page', pageCount: 8, pageUrl: (n) => n <= 1 ? 'http://rst.hubei.gov.cn/bmdt/dtyw/tzgg/' : `http://rst.hubei.gov.cn/bmdt/dtyw/tzgg/index_${n}.html`, detailUrlRe: /\/t\d+_\d+\.shtml$/, listRe: null, itemRe: /<a[^>]+href="([^"]+t\d+_\d+\.shtml)"[^>]*title="([^"]+)"[^>]*>/g },
  ],
  河南省: [
    // 取证：<A href="http://hrss.henan.gov.cn/2026/09-02/3410506.html" target="_blank">标题</A>（标签大写，URL 含日期）
    { label: '省人社厅·公示公告', type: 'page', pageCount: 1, pageUrl: () => 'https://hrss.henan.gov.cn/zwgk/zwdt/gsgg/', detailUrlRe: /\/\d{4}\/\d{2}-\d{2}\/\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="(https?:\/\/hrss\.henan\.gov\.cn\/\d{4}\/\d{2}-\d{2}\/\d+\.html)"[^>]*>([\s\S]{2,}?)<\/a>/gi },
  ],
  湖南省: [
    // 取证：<a href="/rst/xxgk/tzgg/202609/t20260903_34056288.html" target="_blank">标题</a>（zcfg/index.html 为聚合页）
    { label: '省人社厅·政策法规', type: 'page', pageCount: 1, pageUrl: () => 'http://rst.hunan.gov.cn/rst/xxgk/zcfg/index.html', detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+t\d+_\d+\.html)"[^>]*>([\s\S]{4,}?)<\/a>/g },
    { label: '省人社厅·通知公告', type: 'page', pageCount: 10, pageUrl: (n) => `http://rst.hunan.gov.cn/rst/xxgk/tzgg/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/t\d+_\d+\.html$/, listRe: null, itemRe: /<a[^>]+href="([^"]+t\d+_\d+\.html)"[^>]*>([\s\S]{4,}?)<\/a>/g },
  ],
  四川省: [
    // 取证：<div class="gknr_list"><dl><dd><a href="/rst/gsgg/2026/9/3/UUID.shtml" title="标题"><span>2026-09-03</span></a></dd>
    // 翻页：zfxxgkpage_N.shtml（100页1000条，createPageHTML 生成），page1≠page2 0重叠
    { label: '省人社厅·公示公告', type: 'page', pageCount: 10, pageUrl: (n) => `https://rst.sc.gov.cn/rst/gsgg/zfxxgkpage${n <= 1 ? '' : '_' + n}.shtml`, detailUrlRe: /\/rst\/gsgg\/\d{4}\//, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<span>\s*(\d{4}-\d{2}-\d{2})\s*<\/span>/g },
  ],
  安徽省: [
    // 取证：hrss.ah.gov.cn 政策法规栏目，列表为 <ul class="list"><li><a href title><span class="pubDate">
    { label: '省人社厅·政策法规', type: 'page', pageCount: 8, pageUrl: (n) => `https://hrss.ah.gov.cn/zwxx/zcfg/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /content\/post_/, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?(?:<span[^>]*>(\d{4}-\d{2}-\d{2}))?/g },
  ],
  江西省: [
    // 取证：rst.jiangxi.gov.cn 通知公告，列表 <div class="list"><ul><li><a href title><span>日期
    { label: '省人社厅·通知公告', type: 'page', pageCount: 8, pageUrl: (n) => `http://rst.jiangxi.gov.cn/col/col40215/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/art\//, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?(?:<span[^>]*>(\d{4}[-/]\d{2}[-/]\d{2}))?/g },
  ],
  陕西省: [
    // 取证：rst.shaanxi.gov.cn 政策法规，列表 <ul class="news-list"><li><a href title><span>日期
    { label: '省人社厅·政策法规', type: 'page', pageCount: 8, pageUrl: (n) => `https://rst.shaanxi.gov.cn/zfxxgk/zcfg/zcwj/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/content\//, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?(?:<span[^>]*>(\d{4}[-/]\d{2}[-/]\d{2}))?/g },
  ],
  辽宁省: [
    // 取证：rst.ln.gov.cn 政策文件，列表 <ul class="list"><li><a href title><span>日期
    { label: '省人社厅·政策文件', type: 'page', pageCount: 8, pageUrl: (n) => `https://rst.ln.gov.cn/zfxxgk/zcwj/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/content\//, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?(?:<span[^>]*>(\d{4}[-/]\d{2}[-/]\d{2}))?/g },
  ],
  黑龙江省: [
    // 取证：hrss.hlj.gov.cn 政策法规，列表 <ul class="news-list"><li><a href title><span>日期
    { label: '省人社厅·政策法规', type: 'page', pageCount: 8, pageUrl: (n) => `https://hrss.hlj.gov.cn/hljhrss/zcwj/index${n <= 1 ? '' : '_' + n}.html`, detailUrlRe: /\/content\//, listRe: null, itemRe: /<a[^>]+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?(?:<span[^>]*>(\d{4}[-/]\d{2}[-/]\d{2}))?/g },
  ],
};

function getHtml(url, retried = false) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' }, timeout: TIMEOUT },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(getHtml(new URL(res.headers.location, url).toString(), retried));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
        res.on('error', (e) => { if (!retried) resolve(getHtml(url, true)); else reject(e); });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => { if (!retried) resolve(getHtml(url, true)); else reject(e); });
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
async function enumerateProvince(province, opts = {}) {
  const channels = PROVINCE_CHANNELS[province];
  if (!channels || !channels.length) throw new Error(`未注册省份栏目源: ${province}（现有: ${Object.keys(PROVINCE_CHANNELS).join('/')}）`);
  const { maxPages = Infinity, since = '', onPage } = opts;
  const seen = new Map();
  for (const ch of channels) {
    if ((ch.type || 'page') === 'page') {
      let emptyStreak = 0;
      const total = Math.min(ch.pageCount || Infinity, maxPages);
      for (let p = 1; p <= total; p++) {
        const url = ch.pageUrl(p);
        let html = '';
        try {
          const { status, headers, buf } = await getHtml(url);
          if (status !== 200) throw new Error(`HTTP ${status}`);
          html = decode(buf, headers['content-type'] || '');
        } catch (e) {
          console.log(`[enum] ${ch.label} 第${p}页失败: ${e.message}`);
          if (++emptyStreak >= 3) break;
          continue;
        }
        emptyStreak = 0;
        const items = parseListPage(html, url, ch);
        if (!items.length) {
          if (++emptyStreak >= 3) break;
          continue;
        }
        let added = 0;
        for (const it of items) {
          if (since && it.publishDate && it.publishDate < since) continue;
          if (seen.has(it.url)) continue;
          seen.set(it.url, { ...it, province, channel: ch.label });
          added++;
        }
        if (onPage) onPage(p, total, items.length);
        await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
      }
    } else if (ch.type === 'sitemap') {
      // sitemap 模式：缓存优先，一次性读全表
      try {
        const xml = await loadOrFetchSitemap(ch.cachePath, ch.sitemapUrl);
        const items = parseSitemap(xml, ch.pathPrefixes || []);
        if (onPage) onPage(1, 1, items.length);
        for (const it of items) {
          if (since && it.publishDate && it.publishDate < since) continue;
          if (seen.has(it.url)) continue;
          // sitemap 拿不到 title → 留空让后面详情抓取/分类时不漏
          seen.set(it.url, { ...it, title: it.title || '(无标题，需抓详情)', province, channel: ch.label });
        }
        await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
      } catch (e) {
        console.log(`[enum] ${ch.label} sitemap 失败: ${e.message}`);
      }
    } else {
      console.log(`[enum] 未知 channel type: ${ch.type}`);
    }
  }
  return [...seen.values()];
}

/** 已注册省份列表 */
function registeredProvinces() {
  return Object.keys(PROVINCE_CHANNELS);
}

module.exports = { PROVINCE_CHANNELS, enumerateProvince, parseListPage, parseSitemap, loadOrFetchSitemap, registeredProvinces };
