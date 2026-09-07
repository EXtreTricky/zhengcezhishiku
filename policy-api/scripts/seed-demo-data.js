'use strict';
/**
 * seed-demo-data.js —— 清理并重灌 P2 演示数据（feedback/review）
 * 运行：cd feishu-webapp && node policy-api/scripts/seed-demo-data.js
 */
const db = require('../../src/db');

const d = db.getDb();
const before = { fb: d.feedbacks.length, rv: d.reviews.length, sub: d.subscriptions.length, sync: d.syncOutbox.length, crawl: d.crawlQueue.length };
d.feedbacks = [];
d.reviews = [];
d.subscriptions = [];
d.syncOutbox = [];
d.crawlQueue = [];
console.log('已清空（原', JSON.stringify(before), '）');

const BEIJING = 'tbl6zo6GH73o7HCo__recvtyo2zj6e1z'; // 北京 最低工资（含 2740 脏值那条）
const LIAONING = 'tblRusUfXr3l9H3f__recvf1Di9D1sXp'; // 辽宁 大连 大病医疗扣除

const now = () => new Date().toISOString();
const hrAgo = () => new Date(Date.now() - 3600e3).toISOString();
const dayAgo = () => new Date(Date.now() - 86400e3).toISOString();

// 1) feedback：一条待处理（纠错详情页提交），一条已解决（演示回复闭环）
d.feedbacks.push(
  {
    id: 'fb_demo_pending',
    policyId: BEIJING,
    feedbackType: 'correction',
    content: '本条记录将金额与生效日期渲染为「2740 生效」，疑为录入错位：2740 应为月最低工资标准金额而非日期。请核对北京市人社局公告后修正该行字段。',
    pageRef: '基本信息',
    status: 'pending',
    createdAt: hrAgo(),
    createdBy: 'ou_ba0a6a1e0d5b2c3f4a5b6c7d8e9f0a1b',
  },
  {
    id: 'fb_demo_resolved',
    policyId: LIAONING,
    feedbackType: 'correction',
    content: '该行缺少发文机关与发布日期，建议补充来源公告信息。',
    pageRef: '来源信息',
    status: 'resolved',
    reply: '已核实来源公告并更新，感谢反馈。',
    createdAt: dayAgo(),
    createdBy: 'ou_ba0a6a1e0d5b2c3f4a5b6c7d8e9f0a1b',
    reviewedBy: 'ou_ba0a6a1e0d5b2c3f4a5b6c7d8e9f0a1b',
    updatedAt: hrAgo(),
  }
);

// 2) review：一条待人工审核（供「审核中心」展示，带机器校验报告）
d.reviews.push({
  id: 'rv_demo_pending',
  policyId: BEIJING,
  versionId: null,
  reviewType: 'manual_review',
  status: 'pending',
  machineReport: {
    passItems: ['标题完整可读', '效力状态：现行有效'],
    riskItems: [
      { field: 'releaseDate', level: 'high', message: '发布日期字段疑似为金额 2740，字段错位风险' },
      { field: 'effectiveDate', level: 'high', message: '生效日期疑似错位，需对照原文' },
      { field: 'documentNumber', level: 'warn', message: '缺少文号' },
    ],
    missingFields: ['发文机关', '发布日期', '生效日期', '来源链接'],
    conflictItems: [],
    confidenceScore: 40,
  },
  createdAt: hrAgo(),
  createdBy: 'ou_ba0a6a1e0d5b2c3f4a5b6c7d8e9f0a1b',
});

db.save();
console.log('已写入演示数据: feedbacks=', d.feedbacks.length, '| reviews=', d.reviews.length);
for (const f of d.feedbacks) console.log('  fb:', f.id, f.status, f.policyId);
for (const r of d.reviews) console.log('  rv:', r.id, r.status, r.policyId, 'score=', r.machineReport.confidenceScore);
