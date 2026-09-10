'use strict';
/**
 * llm.js — 「机器校验 + AI 预审」本地引擎（零外部依赖可跑），可选接入 OpenAI 兼容接口。
 *
 * 职责：
 *  1. aiReviewModification  员工「申请修改」的 AI 预审：逐字段差异分析 + 敏感字段识别 +
 *                           输出 置信分 0-100 / 风险档(高/中/低) / 证据 / 建议。
 *  2. verifyIntake          采集条目的机器校验报告（可读性/元数据完整性/日期逻辑/重复/冲突）。
 *  3. aiExtractFromText     从正文/标题启发式抽取元数据（标题、文号、机关、日期、分类）。
 *
 * 设计原则：关键字段（金额/日期/口径等）不得由模型单独决定 → 一律要求人工确认或原文证据。
 */
const db = require('./db');

// ─── 工具 ──────────────────────────────────────────────────────────────
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
/** 简单文本相似度（bigram dice），0~1 */
function similarity(a, b) {
  a = str(a); b = str(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const grams = (s) => {
    const g = new Set();
    if (s.length === 1) { g.add(s); return g; }
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}
function num(v) {
  const m = str(v).replace(/[,，\s]/g, '').match(/^-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}/.test(str(v));
}
/** 从配置 + 关键词判断字段是否敏感 */
function fieldRisk(label, cfg) {
  const kw = (cfg && cfg.riskFieldKeywords) || [];
  const t = str(label);
  if (/金额|标准|比例|基数|上限|下限|费率|天数|免税|扣除|津贴/.test(t)) return { level: 'high', why: '涉及金额/比例/标准，直接影响核算，需核原文' };
  if (/生效|失效|发布日期|有效期/.test(t)) return { level: 'high', why: '涉及日期/时效，影响政策生命周期' };
  if (/是否|口径|包含|适用|条件|范围/.test(t)) return { level: 'high', why: '涉及口径/适用范围，语义敏感' };
  if (/依据|来源|备注|说明|引用/.test(t)) return { level: 'mid', why: '引用性字段，建议核对来源' };
  return { level: 'low', why: '常规文本字段' };
}

// ─── 逐字段差异 ────────────────────────────────────────────────────────
function analyzeChange(change, cfg) {
  const label = str(change.label || change.field);
  const oldV = str(change.oldValue);
  const newV = str(change.newValue);
  const rf = fieldRisk(label, cfg);
  const ev = [];
  const reasons = [];

  if (oldV === newV) {
    return {
      field: change.field || label, label, oldValue: oldV, newValue: newV,
      riskLevel: '高', diffType: 'unchanged', confidence: 10,
      evidence: [{ type: 'no-change', severity: 'error', text: '新旧值相同，疑似无效修改' }],
      reasons: ['新旧值一致'],
    };
  }
  // 删除
  if (!newV) {
    return {
      field: change.field || label, label, oldValue: oldV, newValue: '',
      riskLevel: rf.level, diffType: 'remove', confidence: 55,
      evidence: [...(rf.level !== 'low' ? [{ type: 'risk-field', severity: 'warn', text: rf.why }] : [])],
      reasons: ['清空既有取值，需确认依据'],
    };
  }
  // 数字比较
  const nOld = num(oldV), nNew = num(newV);
  if (nOld !== null && nNew !== null) {
    const pct = Math.abs(nNew - nOld) / (Math.abs(nOld) || 1) * 100;
    const delta = nNew - nOld;
    let severity = 'info';
    if (pct > 30) severity = 'high';
    else if (pct > 5) severity = 'warn';
    ev.push({
      type: 'numeric-diff', severity,
      text: `数值由 ${nOld} 调整为 ${nNew}（变化 ${delta > 0 ? '+' : ''}${delta}，幅度 ${pct.toFixed(1)}%）`,
    });
    reasons.push(`数值变化幅度 ${pct.toFixed(1)}%`);
    if (rf.level === 'high' && pct > 5) reasons.push('金额/标准类调整需附原文依据');
  } else if (isDate(oldV) && isDate(newV)) {
    const dO = new Date(oldV).getTime(), dN = new Date(newV).getTime();
    const diffDays = Math.round((dN - dO) / 86400000);
    ev.push({ type: 'date-diff', severity: Math.abs(diffDays) > 90 ? 'warn' : 'info', text: `日期由 ${oldV} 调整为 ${newV}（相差 ${diffDays} 天）` });
    reasons.push('日期变更影响时效判断');
  } else {
    const sim = similarity(oldV, newV);
    const sev = sim > 0.92 ? 'low' : sim > 0.7 ? 'warn' : rf.level === 'high' ? 'high' : 'info';
    ev.push({ type: 'text-diff', severity: sev, text: `文本内容变更（相似度 ${(sim * 100).toFixed(0)}%）：「${oldV.slice(0, 50)}」→「${newV.slice(0, 50)}」` });
    reasons.push(`文本相似度 ${(sim * 100).toFixed(0)}%`);
    if (rf.level !== 'low' && sim < 0.7) reasons.push('关键字段内容变化大，建议核原文');
  }
  if (rf.level !== 'low') {
    ev.push({ type: 'risk-field', severity: 'warn', text: rf.why });
  }
  // 置信度：低风险文本类较高；敏感字段需要证据
  let confidence = 92;
  if (rf.level === 'high') confidence = 78;
  if (rf.level === 'high' && /证据|依据|原文|附件/.test(str(change.reason))) confidence = 88;
  if (rf.level === 'mid') confidence = 86;
  return {
    field: change.field || label, label, oldValue: oldV, newValue: newV,
    riskLevel: rf.level === 'high' ? '高' : rf.level === 'mid' ? '中' : '低',
    diffType: 'replace', confidence, evidence: ev, reasons,
  };
}

/**
 * AI 预审员工修改单
 * @param {object} param { policy, changes:[{field,label,oldValue,newValue,reason}], comment }
 * @returns  { score, riskLevel, riskScore, suggestion, summary, perField[], reviewedAt }
 */
function aiReviewModification({ policy, changes, comment }, cfg) {
  cfg = cfg || db.getDb().config;
  const list = (changes || []).filter((c) => c && (str(c.newValue) || str(c.reason)));
  if (!list.length) {
    return { score: 0, riskLevel: '高', riskScore: 100, suggestion: '无有效修改内容', summary: '未检测到实质修改', perField: [], reviewedAt: db.nowIso() };
  }
  const perField = list.map((c) => analyzeChange({ ...c, oldValue: c.oldValue ?? extractFieldValue(policy, c) }, cfg));

  let high = 0, mid = 0, low = 0, noChange = 0;
  for (const f of perField) {
    if (f.riskLevel === '高') high++;
    else if (f.riskLevel === '中') mid++;
    else low++;
    if (f.diffType === 'unchanged') noChange++;
  }
  // 评分模型：基础 100
  let score = 100;
  score -= noChange * 30;                       // 无效修改重罚
  score -= high * 8;                            // 每个高敏字段扣分（仍需人工）
  score -= mid * 3;
  score -= Math.max(0, list.length - 4) * 2;    // 批量修改谨慎
  if (/疑似|不确定|大概|可能/.test(str(comment))) score -= 15;
  // 修改理由缺失
  const noReason = list.filter((c) => !str(c.reason)).length;
  score -= noReason * 4;
  score = Math.max(5, Math.min(99, Math.round(score)));

  // 风险档 & 建议
  let riskLevel, suggestion, summary;
  const touchesSensitive = high > 0 || noChange > 0;
  if (noChange > 0) {
    riskLevel = '高'; suggestion = '需打回：存在新旧值相同的无效修改';
    summary = `共 ${list.length} 项修改，其中 ${noChange} 项新旧值相同（疑似无效）`;
  } else if (high > 0) {
    riskLevel = '高'; suggestion = score >= 90 ? '建议通过（涉敏感字段，需经理人工确认原文后放行）' : '需经理逐条人工复核';
    summary = `共 ${list.length} 项修改，涉及 ${high} 项敏感字段（金额/日期/口径等），必须人工确认`;
  } else if (score >= 90) {
    riskLevel = '低'; suggestion = '建议通过（高置信，可一键确认）';
    summary = `共 ${list.length} 项修改，均为低风险文本/说明类变更，置信度 ${score}`;
  } else {
    riskLevel = '中'; suggestion = '需人工复核（文本相似度/完整度不足）';
    summary = `共 ${list.length} 项修改，置信度 ${score}，建议复核`;
  }
  return {
    score, riskLevel, riskScore: high * 30 + mid * 10 + noChange * 40, suggestion, summary,
    perField, comment: str(comment), reviewedAt: db.nowIso(),
  };
}

function extractFieldValue(policy, change) {
  // 尝试从 policy 取值：支持 indicators.name 形式（如 indicators.月最低工资标准）
  const f = str(change.field);
  const parts = f.split('.');
  let cur = policy;
  for (const k of parts) {
    if (!cur) return '';
    if (k === 'indicators' && Array.isArray(cur.indicators)) {
      const nm = parts[parts.length - 1];
      const hit = cur.indicators.find((x) => x.name === nm);
      cur = hit ? hit.value : '';
      break;
    }
    cur = cur[k];
  }
  return cur === null || cur === undefined ? '' : String(cur);
}

// ─── 机器校验（采集条目）─────────────────────────────────────────────
function verifyIntake(intake, policies, cfg) {
  const checks = [];
  const text = str(intake.docText) || str(intake.summary);
  const hasDoc = text.length > 0;

  // 1 可读性
  if (!hasDoc) checks.push({ name: '正文可读性', result: 'fail', detail: '未获取到可解析正文' });
  else if (text.length < 80) checks.push({ name: '正文可读性', result: 'warn', detail: `正文过短(${text.length}字)，疑似页面非正文` });
  else checks.push({ name: '正文可读性', result: 'pass', detail: `正文 ${text.length} 字，可读` });

  // 2 元数据完整性
  const missing = [];
  if (!str(intake.title)) missing.push('标题');
  if (!str(intake.org)) missing.push('发文机关');
  if (!str(intake.category)) missing.push('政策类别');
  if (!str(intake.releaseDate)) missing.push('发布日期');
  if (!str(intake.region)) missing.push('适用地区');
  checks.push({ name: '元数据完整性', result: missing.length === 0 ? 'pass' : 'missing', detail: missing.length ? `缺失：${missing.join('、')}` : '必填字段齐全' });

  // 3 日期逻辑
  if (isDate(intake.releaseDate) && isDate(intake.effectiveDate)) {
    const ok = new Date(intake.effectiveDate) >= new Date(intake.releaseDate);
    checks.push({ name: '日期逻辑', result: ok ? 'pass' : 'fail', detail: ok ? '生效日期不早于发布日期' : '生效日期早于发布日期，异常' });
  } else {
    checks.push({ name: '日期逻辑', result: 'warn', detail: '发布日期/生效日期不全，无法校验' });
  }

  // 4 文号格式
  if (str(intake.documentNumber)) {
    const ok = /〔[0-9]{4}〕/.test(intake.documentNumber);
    checks.push({ name: '文号格式', result: ok ? 'pass' : 'warn', detail: ok ? '文号格式规范' : '文号格式可疑（建议含〔年份〕）' });
  }

  // 5 来源
  checks.push({ name: '来源可信度', result: /^https?:\/\//.test(str(intake.sourceUrl)) ? 'pass' : 'missing', detail: str(intake.sourceUrl) ? '有来源链接' : '缺少来源链接（人工录入需补）' });

  // 6 重复/冲突检测
  let dup = null;
  for (const p of policies || []) {
    if (p.id === intake.id) continue;
    const sameDoc = p.documentNumber && intake.documentNumber && str(p.documentNumber) === str(intake.documentNumber);
    const titleSim = similarity(p.title, intake.title);
    if (sameDoc || titleSim > 0.88) { dup = { policyId: p.id, title: p.title, reason: sameDoc ? '文号一致' : `标题相似度 ${(titleSim * 100).toFixed(0)}%` }; break; }
  }
  checks.push({ name: '重复检测', result: dup ? 'fail' : 'pass', detail: dup ? `与《${dup.title}》重复：${dup.reason}` : '未发现明显重复' });

  const fails = checks.filter((c) => c.result === 'fail').length;
  const warns = checks.filter((c) => c.result === 'warn').length;
  const missingN = checks.filter((c) => c.result === 'missing').length;
  const confidence = Math.max(20, Math.round(100 - fails * 22 - warns * 7 - missingN * 6));
  const riskLevel = fails > 0 || missingN >= 2 ? '高' : warns + missingN > 2 ? '中' : '低';
  return { checks, confidence, riskLevel, summary: `${checks.length} 项检查：${checks.filter((c) => c.result === 'pass').length} 通过 / ${warns} 警告 / ${missingN} 缺失 / ${fails} 不通过`, reviewedAt: db.nowIso() };
}

// ─── 启发式元数据抽取 ──────────────────────────────────────────────
const CATEGORY_RULES = [
  [/最低工资|月最低/, '最低工资'],
  [/平均工资|社平工资|全口径/, '平均工资'],
  [/公积金|住房公积金/, '公积金'],
  [/个税|个人所得税|专项附加|汇算/, '个税'],
  [/经济补偿|补偿金/, '经济补偿'],
  [/产假|生育|陪产假|育儿假|婚假|病假|年休假/, '假期'],
  [/高温津贴|防暑降温|低温津贴/, '高温津贴'],
  [/残疾职工|残疾人就业/, '残疾人保障'],
  [/大病医疗|医保|医疗期/, '医疗与保险'],
];
function guessCategory(text) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return cat;
  return '综合';
}
const ORG_RE = /(中华人民共和国|国家|国务院|北京市|上海市|广东省|深圳市|广州市|浙江省|江苏省|四川省|湖南省|湖北省|福建省|山东省|河南省|河北省|辽宁省|吉林省|黑龙江省|陕西省|甘肃省|青海省|云南省|贵州省|安徽省|江西省|广西壮族自治区|内蒙古自治区|新疆维吾尔自治区|宁夏回族自治区|西藏自治区)(统计局|人民政府|人力资源和社会保障局?|人力资源和社会保障厅?|住房和城乡建设委员会?|住房公积金管理中心|税务局|医疗保障局|民政厅?|财政厅?)/;
function aiExtractFromText(text) {
  const t = str(text);
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const title = lines[0] && lines[0].length <= 60 ? lines[0] : (t.slice(0, 40) || '未命名');
  const docM = t.match(/[（(]?\s*[^）)]{1,40}?〔\d{4}〕\s*\d+\s*号\s*[）)]?/);
  const dateM = t.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const orgM = t.match(ORG_RE);
  const category = guessCategory(t);
  return {
    title: title.replace(/^关于|^印发/g, '').slice(0, 80) || title,
    documentNumber: docM ? docM[0].replace(/^[（(]|[\s）)]+$/g, '') : '',
    org: orgM ? orgM[0] : '',
    category,
    releaseDate: dateM ? `${dateM[1]}-${String(Number(dateM[2])).padStart(2, '0')}-${String(Number(dateM[3])).padStart(2, '0')}` : '',
    summary: t.replace(/\s+/g, ' ').slice(0, 140),
    confidence: 60 + Math.min(30, (docM ? 10 : 0) + (orgM ? 10 : 0) + (dateM ? 10 : 0)),
  };
}

// ─── 远程 LLM 通道（采集精提取 / 语义查重 / 审核复核共用）───────────────
// 配置优先级：env（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）→ db.json config.openai。
// server.js 与 scripts/crawl-once.js 都会加载项目根 .env，因此生产把这三项写进 .env 即可。
function openAIConfig() {
  let fromDb = {};
  try {
    fromDb = (db.getDb() && db.getDb().config && db.getDb().config.openai) || {};
  } catch (_) {
    fromDb = {};
  }
  return {
    baseUrl: (process.env.LLM_BASE_URL || fromDb.baseUrl || '').trim(),
    apiKey: (process.env.LLM_API_KEY || fromDb.apiKey || '').trim(),
    model: (process.env.LLM_MODEL || fromDb.model || 'gpt-4o-mini').trim(),
  };
}
/** 是否启用真 LLM（远程通道） */
function llmEnabled() {
  const c = openAIConfig();
  return !!(c.baseUrl && c.apiKey);
}

/** OpenAI 兼容 chat/completions（JSON 模式）。任何失败返回 null，绝不抛异常。 */
async function chatJSON({ system, user, temperature = 0 }) {
  const c = openAIConfig();
  if (!c.baseUrl || !c.apiKey) return null;
  const timeoutMs = Math.max(1000, Number(process.env.LLM_TIMEOUT_MS || 12000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(c.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return null;
    const start = content.indexOf('{');
    if (start === -1) return null;
    return JSON.parse(content.slice(start, content.lastIndexOf('}') + 1));
  } catch (err) {
    if (err && err.name === 'AbortError') console.warn(`[llm] 请求超时 ${timeoutMs}ms，已降级为本地规则`);
    else console.warn(`[llm] 请求失败，已降级为本地规则: ${String(err && err.message || err).slice(0, 160)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 采集精提取（真 LLM）：标题+正文 → 结构化元数据。
 * 设计原则：金额/日期等关键字段只用于「填空补全」，由调用方与正则结果合并，
 * 模型不单独决定关键数值（与代码内既有原则一致）。失败返回 null。
 */
async function aiExtractCrawl(text) {
  if (!llmEnabled()) return null;
  const sample = String(text || '').replace(/\s+/g, ' ').slice(0, 3000);
  if (!sample) return null;
  return chatJSON({
    system:
      '你是中国政府人力资源政策采集助手。只输出 JSON，不要任何多余文字。字段全为字符串，没有则填空串 ""。',
    user:
      '从以下政策文本中提取元数据，输出 JSON，键严格为：' +
      'title(简洁标题)、documentNumber(发文字号，形如「XX〔2026〕XX号」，没有则空)、' +
      'org(发文机关)、releaseDate(发布日期 YYYY-MM-DD)、effectiveDate(生效日期 YYYY-MM-DD，没有则空)、' +
      'amount(金额标准原文片段，如"2680元/月"，没有则空)、amountUnit(单位：月/日/小时/天，没有则空)、' +
      'province(适用省份，全国性填"全国")、' +
      'category(从[最低工资,平均工资,公积金,年金,大病医疗,高温津贴,残疾职工,婚育相关,病假工资]中选，不确定填空)、' +
      'summary(120字内摘要)。\n\n文本：' + sample,
  });
}

/**
 * 语义查重（真 LLM）：待入库条目 × 存量库 → 每条判定 new / exists / needs_update。
 * 预筛存量库至多 40 条防超长；输出按 title 与输入对齐。失败返回 null。
 */
async function aiDedupCandidates(crawledItems, existingItems) {
  if (!llmEnabled()) return null;
  if (!Array.isArray(crawledItems) || crawledItems.length === 0) return null;
  const pool = (existingItems || []).filter((p) => p && p.title);
  if (pool.length === 0) return null;
  const picked = pool.slice(0, 40);
  const cur = crawledItems.slice(0, 12).map((c) => ({
    title: (c.title || '').slice(0, 80),
    province: c.region || c.province || '',
    category: c.category || '',
    amount: c.amount || '',
    documentNumber: c.documentNumber || '',
  }));
  const lib = picked.map((p) => ({
    id: p.id || '',
    title: (p.title || '').slice(0, 80),
    province: p.province || p.applicableRegion || '',
    documentNumber: p.documentNumber || '',
  }));
  const out = await chatJSON({
    system: '你是政策知识库查重员。判断每条"待入库"政策与"存量库"是否实为同一政策。只输出 JSON。',
    user:
      '待入库条目：' + JSON.stringify(cur) +
      '\n存量库（id,title,province,documentNumber）：' + JSON.stringify(lib) +
      '\n对每条待入库输出 {"results":[{"title":"待入库条目标题原文","status":"new|exists|needs_update",' +
      '"reason":"简短中文原因","matchedId":"命中存量条目的 id，判定 new 则为空","matchedTitle":"命中存量条目标题，判定 new 则为空"}]}。' +
      '判定规则：文号相同 → 同一政策；文号缺失时标题+省份语义等价视为同一政策；' +
      '同一政策但本条含更新后的金额/日期信息 → needs_update；完全找不到 → new。',
  });
  if (!out || !Array.isArray(out.results)) return null;
  return out.results
    .map((r) => ({
      title: String((r && r.title) || '').slice(0, 80),
      status: ['new', 'exists', 'needs_update'].includes(r && r.status) ? r.status : 'new',
      reason: String((r && r.reason) || '').slice(0, 120),
      matchedTitle: String((r && r.matchedTitle) || '').slice(0, 80),
      matchedId: String((r && r.matchedId) || ''),
    }))
    .filter((r) => r.title);
}

// ─── 表字段级建议（本地正则 + 真 LLM 双通道）───────────────────────────
// 目标：把「政策原文」抽取成与目标多维表格列一一对应的候选行。
// 结构约定：columns = [{ name: 中文列名, kind: number|date|text|select|url }]
// 建议值：{ col, colType, value, unit, evidence, confidence, engine }

/** 本地正则：在正文里找「列名」出现位置（全文所有出现），窗口内匹配数值/日期 */
function regexSuggestColumns(text, columns) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ').replace(/[（(]/g, '(') + ' ';
  const out = [];
  const scan = (col, win) => {
    let value = '', unit = '', evidence = '';
    if (col.kind === 'date' || /日期|生效|施行|发文/.test(col.name)) {
      const m = win.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (m) { value = `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`; }
    } else {
      const mYuan = win.match(/(\d{3,7}(?:\.\d+)?)\s*元\s*[/∕．.]?\s*(月|日|小时|天|年)?/);
      const mPct = win.match(/(\d{1,2}(?:\.\d)?)\s*(%|％)/);
      const mDays = win.match(/(\d{1,3})\s*天/);
      if (mPct && /比例|%/.test(col.name)) { value = mPct[1]; unit = '%'; }
      else if (mYuan) { value = mYuan[1]; unit = mYuan[2] || ''; }
      else if (mDays && /天|假期|婚假|产假|陪产/.test(col.name)) { value = mDays[1]; unit = '天'; }
    }
    if (value) {
      return {
        col: col.name, colType: col.kind, value, unit,
        evidence: win.slice(-60).trim(),
        confidence: /^20\d{2}-\d{2}-\d{2}$/.test(value) ? 80 : 70,
        engine: 'local-rules',
      };
    }
    return null;
  };
  for (const c of columns || []) {
    if (!c || !c.name) continue;
    let from = 0;
    let found = null;
    while (!found && from < t.length) {
      const idx = t.indexOf(c.name, from);
      if (idx < 0) break;
      const win = t.slice(Math.max(0, idx - 30), idx + 110);
      found = scan(c, win);
      from = idx + c.name.length;
    }
    if (found) out.push(found);
  }
  return out;
}

/** 真 LLM：让模型按列名逐列读原文并给出候选值（只出建议，关键列不自动落库） */
async function aiSuggestColumns(text, columns) {
  if (!llmEnabled() || !columns || !columns.length) return null;
  const sample = String(text || '').replace(/\s+/g, ' ').slice(0, 3200);
  if (!sample) return null;
  const kinds = { number: '数值', date: '日期(YYYY-MM-DD)', text: '文本', select: '单选文本', url: '链接' };
  const colList = columns.map((c) => `"${c.name}"(${kinds[c.kind] || '文本'})`).join(',');
  const out = await chatJSON({
    system:
      '你是政策数据录入员。根据给定列名清单，从政策原文中为每一列提取候选值。只输出 JSON。' +
      '拿不准的列输出 null，绝不编造；金额类保留数字和单位；日期统一 YYYY-MM-DD；比例输出纯数字。',
    user:
      '原文：\n' + sample +
      '\n\n目标列清单：' + colList +
      '\n输出格式：{"values":[{"col":"列名","value":值或null,"unit":"月/日/小时/年/%等，无则空","evidence":"该取值依据的原文片段，≤40字"}]}。' +
      'value 与 evidence 必须能从原文找到依据；找不到的列 value 为 null。',
  });
  if (!out || !Array.isArray(out.values)) return null;
  return out.values
    .filter((v) => v && typeof v.col === 'string' && v.value !== null && v.value !== undefined && String(v.value) !== '')
    .map((v) => ({
      col: String(v.col).slice(0, 40),
      colType: (columns.find((c) => c.name === v.col) || {}).kind || 'text',
      value: String(v.value).slice(0, 60),
      unit: String(v.unit || '').slice(0, 8),
      evidence: String(v.evidence || '').slice(0, 60),
      confidence: 88,
      engine: 'remote-llm',
    }));
}

/**
 * 表字段级建议（对外主入口）：本地正则候选 + LLM 候选合并去重。
 * 规则：同一列两者都有且值一致 → merged 高置信；仅 LLM → 按其置信；
 *      仅本地 → 本地置信。返回 Promise<Array<suggestion>>。
 */
async function suggestTableValues(text, columns) {
  const local = regexSuggestColumns(text, columns);
  if (!llmEnabled()) return local;
  const ai = await aiSuggestColumns(text, columns).catch(() => null);
  if (!ai || !ai.length) return local;
  const byCol = new Map();
  for (const s of [...ai, ...local]) {
    const prev = byCol.get(s.col);
    if (!prev) { byCol.set(s.col, { ...s }); continue; }
    const same = prev.value === s.value && prev.unit === s.unit;
    byCol.set(s.col, {
      ...(same ? prev : s),
      engine: same ? 'merged' : prev.engine === 'remote-llm' ? 'remote-llm' : s.engine,
      confidence: same ? Math.min(97, prev.confidence + 8) : prev.confidence,
    });
  }
  return [...byCol.values()];
}

/** 兼容旧签名 remoteReview(mode, payload) —— 基于 chatJSON 重写，语义不变 */
async function remoteReview(mode, payload) {
  if (!llmEnabled()) return null;
  return chatJSON({
    system: '你是政策知识库助手。只输出 JSON。',
    user:
      mode === 'modification'
        ? '员工提交了对政策字段的修改申请，请逐项判断每项修改是否合理、是否与政策原文冲突风险，' +
          '并给出整体置信度(0-100)与建议(通过/需人工复核/打回)。只输出 JSON。\n' + JSON.stringify(payload)
        : '请从以下文本抽取政策元数据(标题/文号/发文机关/发布日期/政策类别/摘要)并给出置信度。只输出 JSON。\n' +
          JSON.stringify(payload),
  });
}

/**
 * AI 搜索词扩展：为指定省份+政策类别生成 N 个变体搜索词
 * 用于发现层补充：当基础关键词命中为0时，用变体词重新搜索
 * 失败返回 null
 */
async function aiExpandSearchTerms({ province, category, count = 5 }) {
  if (!llmEnabled()) return null;
  if (!province || !category) return null;
  // 类别 → 政策领域中文描述映射（让 LLM 理解语义）
  const CATEGORY_MEANING = {
    '最低工资': '月最低工资标准、非全日制小时工资标准',
    '平均工资': '全口径城镇单位就业人员平均工资、社平工资',
    '公积金': '住房公积金缴存基数上下限、缴存比例',
    '年金': '企业年金、职业年金、税收优惠政策',
    '大病医疗': '大病医疗保险、医疗互助、个税专项扣除',
    '高温津贴': '高温津贴标准、防暑降温费、高温作业劳动保护',
    '残疾职工': '残疾人就业保障金、残保金、残疾人就业优惠',
    '婚育相关': '产假、陪产假、育儿假、哺乳假、婚假天数',
    '病假工资': '病假工资标准、医疗期工资、疾病休假待遇',
  };
  const meaning = CATEGORY_MEANING[category] || category;
  const sample = await chatJSON({
    system:
      '你是中国政府政策搜索引擎优化专家。只输出 JSON 数组，不要任何多余文字。',
    user:
      `省份：${province}\n政策类别：${category}（${meaning}）\n\n` +
      `请生成 ${count} 个不同的百度搜索查询词，用于在政府网站搜索最新政策文件。` +
      `要求：` +
      `1) 每个词长度 ≤ 30 字；2) 覆盖不同表达习惯（如"通知"、"标准"、"调整"、"印发"等）；` +
      `3) 优先考虑 2025-2026 年的最新政策；4) 不要与基础词 "${province} ${category}" 重复。` +
      `输出格式：{"queries":["词1", "词2", ...]}`,
  });
  if (!sample || !Array.isArray(sample.queries)) return null;
  // 过滤：去重、长度检查、去除明显无效词
  const valid = [...new Set(sample.queries)]
    .filter((q) => typeof q === 'string' && q.trim().length >= 3 && q.trim().length <= 30)
    .slice(0, count);
  return valid;
}

module.exports = {
  aiReviewModification,
  verifyIntake,
  aiExtractFromText,
  fieldRisk,
  similarity,
  remoteReview,
  openAIConfig,
  llmEnabled,
  chatJSON,
  aiExtractCrawl,
  aiDedupCandidates,
  suggestTableValues,
  regexSuggestColumns,
  aiSuggestColumns,
  aiExpandSearchTerms,
};
