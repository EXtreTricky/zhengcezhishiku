'use strict';

/**
 * seed-crawl-demo.js —— 为「采集确认链路」填充演示数据（本地 crawlQueue，幂等可重跑）
 *
 * 思路：从真实专题表里取少量真实记录，转成 crawlQueue「待确认」条目——
 *       confirm 时与存量库比对会呈现 exists / needs_update，AI 提取、确认入库、
 *       无写权限降级待同步等全链路均可真实演示，不引入任何伪造来源。
 *
 * 运行：cd feishu-webapp && node policy-api/scripts/seed-crawl-demo.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require('../../src/db');
const { BitableClient } = require('../../src/bitable');
const { POLICY_SOURCES } = require('../src/policy-sources');
const { mapRecord, formatDateCells } = require('../src/normalize');

function textOf(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? x.text || x.name || x.link || '' : x)).join(' ');
  if (typeof v === 'object') return v.text || v.name || v.link || '';
  return String(v);
}

async function main() {
  const client = new BitableClient({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET });
  const existing = db.getDb().crawlQueue.filter((c) => c.source === 'demo');
  if (existing.length) {
    console.log(`crawlQueue 已有 ${existing.length} 条 demo 条目，跳过（幂等）。`);
    return;
  }

  // 候选：最低工资表（含北京那条）+ 婚育相关表
  const candidates = [
    { src: POLICY_SOURCES[0], wantTitle: '北京', label: '北京最低工资' },
    { src: POLICY_SOURCES[7], wantTitle: '产假', label: '婚育假期' },
  ];

  const made = [];
  for (const { src, wantTitle, label } of candidates) {
    const [records, fields] = await Promise.all([
      client.listAllRecords(src.appToken, src.tableId, { viewId: src.viewId }),
      client.listFields(src.appToken, src.tableId),
    ]);
    const hit = records.find((r) => JSON.stringify(r.fields).includes(wantTitle)) || records[0];
    if (!hit) continue;
    const rec = mapRecord({ id: hit.record_id, fields: formatDateCells(hit.fields || {}, fields), source: src });
    const url = (rec.rawFields && Object.entries(rec.rawFields).find(([k, v]) => /来源链接|链接|url/i.test(k) && /^https?:/.test(textOf(v)))) || null;
    const item = {
      id: db.uid('crw'),
      source: 'demo',
      sourcePolicyId: rec.id,
      title: rec.title || `${label}（示例采集条目）`,
      content: rec.content || rec.summary || '',
      url: url ? textOf(url[1]) : '',
      region: rec.province || rec.applicableRegion || '全国',
      category: src.category,
      documentNumber: rec.documentNumber || '',
      org: rec.issuingAuthority || '',
      releaseDate: rec.releaseDate || '',
      effectiveDate: rec.effectiveDate || '',
      summary: rec.summary || '',
      status: 'pending',
      note: `演示条目：由「${src.category}」专题表真实记录生成，用于采集确认链路演示`,
      createdAt: db.nowIso(),
    };
    db.getDb().crawlQueue.push(item);
    made.push(item);
  }
  db.save();
  console.log(`已写入 ${made.length} 条演示采集条目：`);
  for (const m of made) {
    console.log(`  - [${m.category}] ${m.title}  (${m.id})`);
  }
}

main().catch((err) => {
  console.error('seed 失败:', err.message);
  process.exit(1);
});
