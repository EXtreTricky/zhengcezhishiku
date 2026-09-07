'use strict';
/**
 * 入池质量闸门（Quality Gate）
 * ─────────────────────────────────────────────────────────────
 * 目标：在候选入池（db.crawlQueue）之前把「一眼假 / 入库不了」的噪音挡掉，
 *       避免审批台被海量低质条目淹没。
 *
 * 设计原则：宁可存疑（suspect）也不误杀（drop）真政策。
 *   - drop    硬丢弃：不入池。商业域名、站名/导航页、空标题。
 *   - suspect  存疑：入池但在审批台折叠到「存疑」分组，不占主列表。
 *   - pass    通过：正常入池。
 *
 * 规则全部集中在此文件，便于审计与调参。
 */

// ─── 1. 域名规则 ─────────────────────────────────────────────
/** 明确商业 / 自媒体 / 门户转载源：直接丢弃 */
const HOST_BLACKLIST = [
  'toutiao.com', 'jwview.com', 'china.com', 'sohu.com', 'sina.com',
  '163.com', 'baidu.com', 'qq.com', 'weixin', 'csdn.net', 'zhihu.com',
  'xueqiu.com', '36kr.com', 'ithome.com', 'jiemian.com', 'caixin.com',
  'thepaper.cn', 'bjnews.com.cn', 'stcn.com', 'yicai.com', 'nbd.com.cn',
  'ifeng.com', 'people.com.cn', 'xinhuanet.com', 'chinanews.com.cn',
];

/** 政府域名后缀（白名单）：.gov.cn 及其子域 */
const isGovHost = (host) => /(^|\.)gov\.cn$/.test(host) || /(^|\.)mohrss\.gov\.cn$/.test(host);

function getHost(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch (_) {
    return String(url || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
  }
}

// ─── 2. 标题质量规则 ──────────────────────────────────────────
/** 站名 / 导航页 / 门户首页：整页不是一条政策 */
const STATION_PATTERNS = [
  /^(.*?)(人社网|人社局网|人力社保网|社保网)$/,
  /^(.*?)(住房公积金管理中心|公积金管理中心|住房管理中心)$/,
  /^(.*?)(经济信息中心|信息中心|数据中心)$/,
  /^(.*?)(政务服务平台|政府门户网站|门户网站|服务平台)$/,
  /^(.*?)(人才网|就业网|考试网|培训网)$/,
  /^(.*?)(信息网|公积金信息网|房改公积金信息网)$/,
];

/**
 * 通用站名兜底：剥离括号内容后，若标题就是「XX网 / XX中心 / XX平台」
 * 且不含任何政策文体词，判定为导航页而非政策条目。
 */
function looksLikeStation(bare) {
  const noParen = bare.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (!noParen) return false;
  if (/(网|中心|平台|门户)$/.test(noParen) && noParen.length <= 20) {
    return !POLICY_FORM_WORDS.some((w) => noParen.includes(w));
  }
  return false;
}

/** 政策文体词：出现即为「规范性文件」，是强通过信号 */
const POLICY_FORM_WORDS = [
  '办法', '规定', '条例', '实施细则', '指导意见', '实施意见', '若干意见',
  '通知', '通告', '公告', '决定', '批复', '复函', '方案', '标准', '规程',
  '政策解读', '政策问答', '解读', '问答', '须知', '指南', '目录', '清单',
];

/** 事务性噪音词：评选 / 采购 / 公示 / 信息披露 —— 不是政策本体 */
const AFFAIR_NOISE_WORDS = [
  '评选', '中标', '招标', '投标', '采购', '磋商', '成交', '询价', '遴选',
  '邀请函', '邀标', '比选', '竞争性', '框架协议',
  '会计师事务所', '审计服务', '托管银行', '归集账户', '受托机构', '受托人',
  '管理人', '投资管理人', '匹配结果', '选树', '招聘月', '招聘活动',
  '信息披露', '管理情况', '基金信息', '年度报告', '季度报告',
  '名单', '名录', '排行榜', '获奖', '表彰', '通报表扬',
  '满意度', '调查问卷', '征求意见稿', '问卷调查',
];

/** 事务性噪音（正则）：处理「新增 XX 计划」这类中间夹字的表达 */
const AFFAIR_NOISE_PATTERNS = [
  /(新增|增设|设立|推出).{0,10}(计划|品种|产品|方案)/,
  /(第一批|第二批|第三批|年度).{0,6}(入围|入选|备案)/,
];

/**
 * 类目专属负向规则：某类目下的典型误命中。
 * key = 类目，value = 该类目下出现即存疑的正则数组
 */
const CATEGORY_NEGATIVE = {
  年金: [
    /职业年金.{0,6}(评选|中标|招标|采购|磋商|成交|邀请|遴选|比选)/,
    /企业年金.{0,6}(评选|中标|招标|采购|磋商|成交|邀请)/,
    /(受托人|受托机构|托管人|托管银行|投资管理人|账户管理人)/,
    /(会计师事务所|审计服务|审计机构)/,
    /(信息披露|管理情况|基金信息|运行情况)/,
    /年金.{0,4}(招聘|选树|活动|会议|培训)/,
    /年金秋/,           // 「年金秋招聘月」被「年金」误切分
  ],
  最低工资: [
    /最低工资.{0,10}(是多少|多少钱|查询|计算器)/,
  ],
  公积金: [
    /(缴存|提取).{0,6}(查询|计算器|指南问答$)/,
  ],
};

/** 标题被截断（抓取时截断） */
const TRUNCATED = /(\.\.\.|…|更多>>|详情>>)$/;

/** 站点名后缀（抓取时把站点名拼接到了标题尾部，可清洗而非丢弃） */
const TITLE_SITE_SUFFIX = /(人民政府门户网站|政府门户网站|政府网|人社局网|人民政府)$/;

// ─── 3. 主判定函数 ────────────────────────────────────────────

/** 去掉「广东省 」这类省份前缀，返回正文标题 */
function stripRegionPrefix(title) {
  return String(title || '')
    .replace(/^(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|全国)\s+/, '')
    .trim();
}

/** 清洗标题尾部的站点名（返回清洗后的标题；不变则返回原值） */
function cleanTitle(title) {
  const t = String(title || '').trim();
  const m = t.match(TITLE_SITE_SUFFIX);
  if (!m) return t;
  const head = t.slice(0, m.index).trim();
  // 清洗后至少还要剩下 8 个字，否则认为整条无实质内容
  return head.length >= 8 ? head : t;
}

/**
 * 质量判定
 * @param {{title?:string,url?:string,category?:string,summary?:string,content?:string,valuesSuggest?:Array}} item
 * @returns {{level:'pass'|'suspect'|'drop', reasons:string[], title:string}}
 */
function judge(item) {
  const reasons = [];
  const rawTitle = String(item?.title || '').trim();
  const url = String(item?.url || '').trim();
  const category = String(item?.category || '').trim();
  const host = getHost(url);
  const body = `${rawTitle} ${item?.summary || ''} ${String(item?.content || '').slice(0, 500)}`;
  const title = cleanTitle(rawTitle);
  const bare = stripRegionPrefix(title);

  // ── L0-a 无 URL / 无标题：直接丢 ──
  if (!url) return { level: 'drop', reasons: ['无来源链接'], title };
  if (!bare || bare.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').length < 6) {
    return { level: 'drop', reasons: ['标题为空或无实质内容'], title };
  }

  // ── L0-b 商业 / 自媒体域名：直接丢 ──
  if (HOST_BLACKLIST.some((d) => host === d || host.endsWith('.' + d))) {
    return { level: 'drop', reasons: [`非政府来源（${host}）`], title };
  }
  // 非政府域名且不在白名单 → 存疑（不完全否定，可能是事业单位）
  if (host && !isGovHost(host)) reasons.push(`来源非 .gov.cn（${host}）`);

  // ── L0-c 站名 / 导航页：直接丢 ──
  for (const re of STATION_PATTERNS) {
    if (re.test(bare)) {
      return { level: 'drop', reasons: ['标题是站点名/导航页，非政策条目'], title };
    }
  }
  if (looksLikeStation(bare)) {
    return { level: 'drop', reasons: ['标题是站点名/导航页，非政策条目'], title };
  }

  // ── L1-a 事务性噪音（评选/采购/公示/信息披露）──
  let affairHit = '';
  for (const w of AFFAIR_NOISE_WORDS) {
    if (bare.includes(w) || stripRegionPrefix(rawTitle).includes(w)) { affairHit = w; break; }
  }
  if (!affairHit) {
    for (const re of AFFAIR_NOISE_PATTERNS) {
      if (re.test(bare)) { affairHit = re.source.slice(0, 20); break; }
    }
  }
  // ── L1-b 类目专属负向规则 ──
  let catNegHit = '';
  const negRules = CATEGORY_NEGATIVE[category];
  if (negRules) {
    for (const re of negRules) {
      if (re.test(bare)) { catNegHit = re.source.slice(0, 24); break; }
    }
  }

  const hasPolicyForm = POLICY_FORM_WORDS.some((w) => bare.includes(w));

  if (affairHit && !hasPolicyForm) {
    reasons.push(`事务性公告而非政策（命中「${affairHit}」）`);
  } else if (affairHit && hasPolicyForm) {
    // 既有文体词又有噪音词：多为「XX评选办法」这类，仍算政策，降级提示
    reasons.push(`含事务词但同时是规范性文件（「${affairHit}」），需人工确认`);
  }
  if (catNegHit) reasons.push(`「${category}」类目负向规则命中（/${catNegHit}/）`);

  // ── L1-c 标题被截断 ──
  if (TRUNCATED.test(bare)) reasons.push('标题被截断，信息不完整');

  // ── L1-d 无抽取建议值 且 无明显文体词 → 抽不出数，大概率入库也为空 ──
  const hasSuggest = Array.isArray(item?.valuesSuggest) && item.valuesSuggest.length > 0;
  if (!hasSuggest && !hasPolicyForm) {
    reasons.push('未抽取到任何字段建议值，且无政策文体特征');
  }

  if (reasons.length) return { level: 'suspect', reasons, title };
  return { level: 'pass', reasons: [], title };
}

/** 批量判定，返回统计 + 分组 */
function judgeAll(items) {
  const out = { pass: [], suspect: [], drop: [] };
  for (const it of items || []) {
    const r = judge(it);
    out[r.level].push({ item: it, ...r });
  }
  return {
    ...out,
    stat: { total: (items || []).length, pass: out.pass.length, suspect: out.suspect.length, drop: out.drop.length },
  };
}

module.exports = {
  judge,
  judgeAll,
  cleanTitle,
  stripRegionPrefix,
  getHost,
  isGovHost,
  HOST_BLACKLIST,
  STATION_PATTERNS,
  AFFAIR_NOISE_WORDS,
  POLICY_FORM_WORDS,
  CATEGORY_NEGATIVE,
};
