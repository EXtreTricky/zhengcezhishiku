'use strict';

/**
 * 归一化层 —— 1:1 复刻 policy-kb 的多维表格记录 → 前端展示模型的转换。
 *
 * 原实现分布在 policy-kb server/modules/bitable/bitable.service.ts：
 *   - KEYWORDS 关键词表 → detectFieldRoles 列角色识别
 *   - mapRecord：标题兜底拼接「地区 城市 类别语义名 金额/标准 日期 生效」
 *   - policies.service.ts 的 toListItem / toDetail / cleanSourceFields / splitTags
 *
 * 与原版差异（因数据通道从平台插件换成 OpenAPI 直连）：
 *   1) 原始字段 key 本来就是中文列名（原版是 field_id + idToName 反查），角色识别走同一套关键词即可命中；
 *   2) 日期字段在 OpenAPI 里是毫秒时间戳，读取时预先格式化为 YYYY-MM-DD 文本；
 *   3) 记录 ID 统一由调用方在聚合时加 `${tableId}__` 前缀。
 */

const { cellToText, msToDateText } = require('../../src/bitable');

// ─── extractText：cellToText 即原版 extractText 的等价实现（数组逗号连接 / {text} / {name} / users）───
const extractText = cellToText;

// 列角色关键词表（逐字复刻原版 KEYWORDS，顺序敏感：先命中的列优先）
const KEYWORDS = {
  title: ['标题', '题目', '名称', 'title', 'name', '政策名', '目录'],
  content: ['正文', '内容', '详情', '政策内容', 'body', 'content', '全文', '原文', '概述', 'AI概述', '说明', '其他不包含项'],
  category: ['政策类别', '分类', '类别', 'category', 'type', '类型', '数据表', '变更类型'],
  date: ['发布日期', '发布时间', '日期', 'date', 'publish', '发文日期', '执行日期', '创建时间'],
  docNumber: ['文号', '发文字号', 'docnumber', 'number', '编号', '政策来源', '政策来源1', '政策来源2', '政策来源3'],
  summary: ['摘要', '简介', 'summary', 'abstract', '备注', '人工审核备注', 'AI校验结论'],
  tags: ['标签', '关键词', 'tags', 'keywords'],
  authority: ['发文机关', '发布机关', '发布单位', 'authority', 'issuing'],
  status: ['状态', '效力状态', 'status', 'effectiveness', '有效期限', '有效性', '审批进度', '确认通过'],
  region: ['地区', '省份', '地域', '区域', 'region', 'province'],
  city: ['城市', 'city', '市'],
  url: ['来源链接', '政策来源', '数据来源', '来源', '链接', 'url', 'sourceurl', 'link', '政策来源1', '政策来源2', '政策来源3'],
  effectiveDate: ['生效日期', '施行日期', 'effectivedate', '生效月'],
  value: ['标准', '金额', '上限', '下限', '比例', '基数', '免税', '扣除', '津贴', '工资', '补偿金', '数值', 'value', 'amount', 'limit', '最低工资', '就高标准'],
};

const URL_RE = /^https?:\/\//i;

/** 标题识别命中这些列时不能当标题（内容只是数字/二值状态） */
const TITLE_FALLBACK_EXCLUDE_NAMES = [
  '是否', '确认', '审批', '有效性', '含社保', '含公积金', '通过',
  '最低工资', '就高标准', '金额', '上限', '下限', '津贴', '天数', '比例', '限额',
];

/**
 * 按「中文列名关键词」识别各角色对应的列。
 * 原版另有基于样本内容特征的兜底（应对 field_id 键名）；OpenAPI 直连的 key 已是中文列名，
 * 关键词命中率足够，不再引入内容采样。
 */
function detectRoles(fieldNames) {
  const names = fieldNames.map((n) => String(n).toLowerCase());
  const find = (role) => {
    for (const k of KEYWORDS[role]) {
      const kl = k.toLowerCase();
      const idx = names.findIndex((n) => n.includes(kl));
      if (idx >= 0) return fieldNames[idx];
    }
    return '';
  };
  return {
    title: find('title'),
    content: find('content'),
    category: find('category'),
    date: find('date'),
    docNumber: find('docNumber'),
    summary: find('summary'),
    tags: find('tags'),
    authority: find('authority'),
    status: find('status'),
    region: find('region'),
    city: find('city'),
    url: find('url'),
    effectiveDate: find('effectiveDate'),
    value: find('value'),
  };
}

function pick(fields, name) {
  if (!name) return '';
  const v = fields[name];
  if (v === undefined || v === null) return '';
  return extractText(v);
}

function pickByNames(fields, names) {
  for (const want of names) {
    if (fields[want] !== undefined) {
      const t = extractText(fields[want]);
      if (t) return t;
    }
  }
  return '';
}

/**
 * 字段内容清洗：把毫秒时间戳格式化为 YYYY-MM-DD 文本。
 * 多维表格里日期/创建/更新时间的 OpenAPI 值为 13 位毫秒（>=1e12，约 2001 年后），
 * 金额远小于该量级（不会误伤）；日期列里的小数字脏值（如 2740）也不处理，保持原样。
 * 返回新对象，不改原字段。fieldMeta 参数保留以对齐调用签名，不再参与判断。
 */
const DATE_MIN_MS = Date.UTC(2000, 0, 1);
const DATE_MAX_MS = Date.UTC(2050, 0, 1);

function formatDateCells(raw, _fieldMeta) {
  const out = { ...raw };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue;
    const num = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (Number.isFinite(num) && num >= 1e12) {
      // 闸：日期必须在 2000-2050 区间，否则视为脏数据（多档金额拼接误存日期列）
      if (num >= DATE_MIN_MS && num <= DATE_MAX_MS) {
        out[k] = msToDateText(num);
      } else {
        // 越界日期：清除为 undefined，避免脏数据流入展示层
        out[k] = undefined;
      }
    }
  }
  return out;
}

/**
 * 单条记录 → BitableRecord（等价 mapRecord）
 * @param {object} opts { id, fields(中文列名→原始值), source: PolicySource }
 */
function mapRecord(opts) {
  const { id, source } = opts;
  const fields = opts.fields;
  const roles = detectRoles(Object.keys(fields));

  const region = pick(fields, roles.region);
  const cityRaw = pick(fields, roles.city);
  const city = cityRaw || region;
  const content = pick(fields, roles.content);
  const value = pick(fields, roles.value);
  const date = pick(fields, roles.date) || pick(fields, roles.effectiveDate);

  let title = pick(fields, roles.title);
  const titleIsNumeric = !!title && /^[\d\s,，、.＋+xX×\-—]+(元)?$/.test(title.trim());
  const titleIsBad =
    !title ||
    titleIsNumeric ||
    (roles.title && TITLE_FALLBACK_EXCLUDE_NAMES.some((k) => roles.title.includes(k)));

  if (!title || titleIsBad) {
    // 标题只保留「省份 城市」：口径值（如"大病医疗扣除 否"）与生效日期在详情页字段明细中
    // 已完整展示，拼进标题会让查找列表长短不一、难以扫读。
    // 例：原「辽宁 大连 大病医疗扣除 否」→ 现「辽宁 大连」
    const parts = [region, city !== region ? city : ''].filter(Boolean);
    if (parts.length >= 1) {
      title = parts.join(' ');
    } else {
      const firstShortText = Object.entries(fields)
        .map(([, v]) => extractText(v))
        .find((t) => t && t.length > 0 && t.length < 80 && !URL_RE.test(t));
      title = firstShortText || `记录 ${id}`;
    }
  }

  const rec = {
    id,
    title,
    content: content || undefined,
    province: region,
    city: city || region,
    url: pick(fields, roles.url),
    documentNumber: pick(fields, roles.docNumber) || undefined,
    issuingAuthority: pick(fields, roles.authority) || undefined,
    releaseDate: date || undefined,
    effectiveDate: pick(fields, roles.effectiveDate) || undefined,
    effectivenessStatus: pick(fields, roles.status) || undefined,
    applicableRegion: region || undefined,
    topicCategory: (source && source.category) || undefined,
    policyType: (source && source.category) || undefined,
    summary: pick(fields, roles.summary) || value || undefined,
    keywords: pick(fields, roles.tags) || undefined,
    rawFields: fields,
  };
  return rec;
}

// ─── 列表项 / 详情（等价 policies.service.ts toListItem / toDetail）─────────

function splitTags(keywords) {
  if (!keywords) return [];
  return keywords
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toListItem(r) {
  const dateRef = r.releaseDate || r.effectiveDate || new Date().toISOString();
  return {
    id: r.id,
    title: r.title,
    documentNumber: r.documentNumber,
    issuingAuthority: r.issuingAuthority,
    releaseDate: r.releaseDate,
    effectiveDate: r.effectiveDate,
    expirationDate: undefined,
    effectivenessStatus: r.effectivenessStatus || '未明确',
    applicableRegion: r.applicableRegion || r.province,
    industry: undefined,
    topicCategory: r.topicCategory,
    policyType: r.policyType,
    securityLevel: 'public',
    status: 'published',
    summary: r.summary,
    keywords: r.keywords,
    viewCount: 0,
    createdAt: dateRef,
    updatedAt: dateRef,
    tags: splitTags(r.keywords),
  };
}

function cleanSourceFields(raw) {
  const out = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    const text = extractText(value).trim();
    if (text) out[key] = text;
  }
  return out;
}

function toDetail(r) {
  const base = toListItem(r);
  return {
    ...base,
    content: r.content || '',
    sourceFields: cleanSourceFields(r.rawFields),
    sourceUrl: r.url,
    sourceType: 'bitable',
    confidenceScore: undefined,
  };
}

function compareDate(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

/** 列表查询（等价 bitable.service.getRecords：筛选→排序→分页） */
function queryRecords(allRecords, options) {
  const {
    page = 1,
    pageSize = 20,
    keyword,
    category,
    region,
    effectiveness,
    policyType,
    sortBy = 'releaseDate',
    sortOrder = 'desc',
  } = options;

  let filtered = allRecords;
  if (keyword) {
    const kw = keyword.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        (r.title || '').toLowerCase().includes(kw) ||
        (r.documentNumber || '').toLowerCase().includes(kw) ||
        (r.summary || '').toLowerCase().includes(kw) ||
        (r.keywords || '').toLowerCase().includes(kw),
    );
  }
  if (category) filtered = filtered.filter((r) => r.topicCategory === category);
  if (region) filtered = filtered.filter((r) => r.applicableRegion === region || r.province === region);
  if (effectiveness) filtered = filtered.filter((r) => (r.effectivenessStatus || '') === effectiveness);
  if (policyType) filtered = filtered.filter((r) => (r.policyType || r.topicCategory || '') === policyType);

  const dir = sortOrder === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'title':
        return dir * (a.title || '').localeCompare(b.title || '', 'zh');
      case 'effectiveDate':
        return dir * compareDate(a.effectiveDate, b.effectiveDate);
      case 'createdAt':
      case 'updatedAt':
        return 0;
      default:
        return dir * compareDate(a.releaseDate, b.releaseDate);
    }
  });

  const total = filtered.length;
  const offset = (page - 1) * pageSize;
  const items = filtered.slice(offset, offset + pageSize);
  return { items, total, page, pageSize, hasMore: offset + pageSize < total };
}

module.exports = {
  extractText,
  detectRoles,
  mapRecord,
  formatDateCells,
  toListItem,
  toDetail,
  cleanSourceFields,
  splitTags,
  queryRecords,
  compareDate,
};
