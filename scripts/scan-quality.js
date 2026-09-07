'use strict';
/**
 * P4 数据质检扫描器 —— 遍历 10 张专题表，对每条记录做客观规则体检。
 *
 * 只读扫描（不写任何表）。输出：
 *   1) 控制台汇总（按类别/规则计数的 top 问题）
 *   2) docs/data-quality/raw.json 全量问题明细（供生成报告用）
 *
 * 规则（severity: high / medium）：
 *   blank_row           整行关键字段为空（疑似空行/占位）
 *   money_outlier       数值型金额类字段 <=0 或 > 200 万（疑似拼接/爬虫脏值）
 *   date_outlier        datetime 值越界（<2000 或 >2050，疑似 2740 这类脏年份/毫秒错置）
 *   text_garbage        文本含 U+FFFD/undefined/NaN/超长(>1500)
 *   url_bad             链接字段非 http(s)
 *   key_field_missing   表格核心字段为空（标题/首值字段/地区字段）
 *   dup_url             同表内来源链接重复（疑似同文重复入库）
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { fromEnv: bitableFromEnv, msToDateText } = require('../src/bitable');
const { POLICY_SOURCES } = require('../policy-api/src/policy-sources');

const DATE_MIN_MS = Date.UTC(2000, 0, 1);
const DATE_MAX_MS = Date.UTC(2050, 0, 1);
const MONEY_MAX = 2_000_000;
const TEXT_TOO_LONG = 1500;

// OpenAPI 字段 type 号（常见值）：1 文本 / 2 数字 / 3 单选 / 4 多选 / 5 日期 / 7 勾选 /
// 11 人员 / 13 电话 / 15 超链接 / 17 附件 / 18 双向关联 / 19 公式 / 20 创建时间 / 21 最后更新时间
const SKIP_TYPES = new Set([19, 20, 21, 22, 23, 24, 903]); // 公式/审计类
const SKIP_NAME = /^(记录ID|有效性|变更类型|检测类|创建人|最后修改人|创建时间|最后更新时间|序号)$/;

function fieldKind(name) {
  if (/链接|url|URL|来源/.test(name)) return 'url';
  if (/日期|期限|周期|执行|生效|发文/.test(name)) return 'date';
  if (/工资|标准|上限|限额|金额|补贴|基数|减免|扣除/.test(name)) return 'money';
  if (/天数|比例|年份|月份|人次|次数/.test(name)) return 'metric';
  return 'text';
}

function isAuditField(f) {
  if (SKIP_TYPES.has(f.type)) return true;
  return SKIP_NAME.test(f.name);
}

async function scan() {
  const client = bitableFromEnv();
  const issues = [];
  const summary = [];
  const outDir = path.join(__dirname, '..', 'docs', 'data-quality');
  fs.mkdirSync(outDir, { recursive: true });

  for (const src of POLICY_SOURCES) {
    let fields = [];
    try {
      fields = await client.listFields(src.appToken, src.tableId);
    } catch (e) {
      console.error(`[${src.category}] listFields 失败:`, e.message);
      continue;
    }
    const meta = fields.map((f) => ({ name: f.name, type: f.type, ui_type: f.ui_type }));
    const nonAudit = meta.filter((f) => !isAuditField(f));
    const records = await client.listAllRecords(src.appToken, src.tableId);
    const tIssues = [];
    const tSeen = { blank_row: 0, money_outlier: 0, date_outlier: 0, text_garbage: 0, url_bad: 0, key_field_missing: 0, dup_url: 0 };
    const urlMap = new Map();

    const keyValueField = src.valueFields[0];
    const regionField = nonAudit.find((f) => f.type === 3)?.name; // 首个单选字段近似地区/状态

    for (const rec of records) {
      const f = rec.fields || {};
      const rId = rec.record_id || rec.recordId || '(no id)';
      const names = Object.keys(f);
      const nonEmpty = names.filter((n) => {
        const v = f[n];
        return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
      });
      // 空行：无可审计的非空内容
      if (nonEmpty.length === 0) {
        tSeen.blank_row++;
        tIssues.push({ recordId: rId, severity: 'medium', kind: 'blank_row', note: '整行为空记录（疑似占位/残留）' });
        continue;
      }
      // 关键字段缺失
      const hasKey = keyValueField ? f[keyValueField] !== undefined && f[keyValueField] !== '' && f[keyValueField] !== null : true;
      if (!hasKey) {
        tSeen.key_field_missing++;
        tIssues.push({ recordId: rId, severity: 'high', kind: 'key_field_missing', field: keyValueField, note: `核心数值字段「${keyValueField}」为空` });
      }
      for (const name of names) {
        if (SKIP_NAME.test(name)) continue;
        const v = f[name];
        const mf = meta.find((m) => m.name === name);
        if (!mf || isAuditField(mf)) continue;
        const kind = fieldKind(name);
        // 数值类
        if (typeof v === 'number') {
          if (kind === 'money') {
            if (v <= 0) {
              tSeen.money_outlier++;
              tIssues.push({ recordId: rId, severity: 'high', kind: 'money_outlier', field: name, value: v, note: '金额类数值 <= 0' });
            } else if (v > MONEY_MAX) {
              tSeen.money_outlier++;
              tIssues.push({ recordId: rId, severity: 'high', kind: 'money_outlier', field: name, value: v, note: `金额类数值异常偏大(>${MONEY_MAX})，疑似多年拼接` });
            }
          } else if (kind === 'metric') {
            if (!Number.isFinite(v) || v < 0) {
              tSeen.money_outlier++;
              tIssues.push({ recordId: rId, severity: 'medium', kind: 'money_outlier', field: name, value: v, note: '计量字段异常' });
            }
          } else if (kind === 'date') {
            // datetime 期望毫秒：越界或毫秒错置（如 2740 → 1970）
            if (v < DATE_MIN_MS || v > DATE_MAX_MS) {
              tSeen.date_outlier++;
              tIssues.push({
                recordId: rId, severity: 'high', kind: 'date_outlier', field: name, value: v,
                note: `日期越界 raw=${v}` + (v >= 1e12 ? `(≈${msToDateText(v)})` : `(≈${new Date(v).toISOString()})`),
              });
            }
          }
        }
        // 文本类
        if (typeof v === 'string') {
          const s = v;
          if (s.length > TEXT_TOO_LONG) {
            tSeen.text_garbage++;
            tIssues.push({ recordId: rId, severity: 'medium', kind: 'text_garbage', field: name, note: `文本超长 ${s.length} 字符（疑似整页/JSON 灌入）`, snippet: s.slice(0, 80) });
          } else if (/[\uFFFD]|undefined|NaN/.test(s)) {
            tSeen.text_garbage++;
            tIssues.push({ recordId: rId, severity: 'medium', kind: 'text_garbage', field: name, note: '文本含乱码字符或 undefined/NaN', snippet: s.slice(0, 80) });
          }
          if (kind === 'url' && s.trim() && !/^https?:\/\//i.test(s.trim())) {
            tSeen.url_bad++;
            tIssues.push({ recordId: rId, severity: 'medium', kind: 'url_bad', field: name, value: s.slice(0, 120), note: '来源字段非合法 http(s) 链接' });
          }
        }
      }
      // 同表链接查重
      const urlVal = names
        .map((n) => ({ n, v: f[n] }))
        .find(({ n, v }) => /来源|链接|url/i.test(n) && typeof v === 'string' && /^https?:/i.test(v.trim()));
      if (urlVal) {
        const key = urlVal.v.trim();
        if (urlMap.has(key)) {
          tSeen.dup_url++;
          tIssues.push({ recordId: rId, severity: 'high', kind: 'dup_url', field: urlVal.n, note: `与 ${urlMap.get(key)} 来源链接重复`, snippet: key.slice(0, 100) });
        } else {
          urlMap.set(key, rId);
        }
      }
    }

    const used = Object.keys(tSeen).filter((k) => tSeen[k] > 0).map((k) => ({ kind: k, count: tSeen[k] }));
    summary.push({
      category: src.category, tableId: src.tableId, total: records.length, fields: meta.length,
      issues: tIssues.length, used,
      top: tIssues.slice(0, 6).map((x) => ({ kind: x.kind, recordId: x.recordId, field: x.field || '', note: x.note, snippet: x.snippet || (x.value !== undefined ? String(x.value).slice(0, 60) : '') })),
    });
    issues.push(...tIssues.map((x) => ({ category: src.category, tableId: src.tableId, ...x })));
    console.log(`[${src.category}] 共 ${records.length} 条，问题 ${tIssues.length} 条 | ${used.map((u) => `${u.kind}=${u.count}`).join(' ')}`);
  }

  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary, issues }, null, 2), 'utf8');
  const high = issues.filter((i) => i.severity === 'high').length;
  console.log('\n==== 汇总 ====');
  console.log(`表数=${summary.length} 总记录=${summary.reduce((a, b) => a + b.total, 0)} 问题记录=${issues.length}（high=${high} / medium=${issues.length - high}）`);
  console.log('明细已写: docs/data-quality/raw.json');
}

scan().catch((e) => { console.error('SCAN FAILED:', e); process.exit(1); });
