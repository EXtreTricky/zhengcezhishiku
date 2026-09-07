'use strict';

/**
 * Bitable 直连通道 · 最小链路验证脚本
 *
 * 用途：验证「自建应用身份 → 飞书 OpenAPI → 多维表格」整条链路可用，
 * 对应迁移路线图「阶段 1」。跑通即证明数据层直连方案成立。
 *
 * 用法：
 *   cd feishu-webapp
 *   cp .env.example .env   # 填入 FEISHU_APP_ID / FEISHU_APP_SECRET
 *   node scripts/probe-bitable.js               # 默认读「最低工资」表，打印前 5 条
 *   node scripts/probe-bitable.js --table 公积金 # 指定语义表名（见 POLICY_SOURCES）
 *   node scripts/probe-bitable.js --all          # 遍历十类专题表，每张只报连接与总数
 *   node scripts/probe-bitable.js --limit 10     # 调整打印条数
 *
 * 前置条件（缺少会在此给出明确指引）：
 *   1) 自建应用已开通多维表格权限（权限管理搜索「多维表格」勾选 bitable:app）；
 *   2) 该应用已加入目标多维表格的协作者（表格右上角 分享 → 添加文档应用/协作者，
 *      身份填应用名或 app_id，授予「可编辑」）。
 */

const path = require('path');
const fs = require('fs');

// 加载 .env（存在才加载，脚本会给更友好的提示）
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  // dotenv 未加载时手动读一次也行，这里直接交给下方检测逻辑提示
}

const { BitableClient, POLICY_SOURCES, msToDateText, cellToText } = require('../src/bitable');

function parseArgs(argv) {
  const args = { table: null, all: false, limit: 5 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--table') args.table = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]) || 5;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/** 不同专题表「展示关键列」各不相同，取表内实际存在的列打印 */
function pickColumns(fields, preferred) {
  const names = new Set(fields.map((f) => f.name));
  return preferred.filter((n) => names.has(n));
}

async function probeOne(client, src, { printRecords, limit }) {
  const { category, appToken, tableId, viewId } = src;
  const conn = await client.testConnection(appToken, tableId);
  const line = [`[${category}] ${tableId}`, conn.success ? `记录数=${conn.recordCount}` : conn.message].join('  ');
  if (!conn.success) {
    console.log(`✗ ${line}`);
    return { ok: false, category, total: 0 };
  }
  console.log(`✓ ${line}`);
  if (!printRecords || conn.recordCount === 0) return { ok: true, category, total: conn.recordCount };

  const records = await client.listAllRecords(appToken, tableId, { viewId });
  const fields = await client.listFields(appToken, tableId);
  const preferred = ['省份', '城市', '地区', '最低工资', '就高标准', '平均工资', '生效日期', '有效期至', '发文日期', '生效月', '政策来源1', '政策来源链接', '有效性', '审批进度', 'AI核查结论'];
  const cols = pickColumns(fields, preferred);
  // 日期型列（毫秒时间戳 -> YYYY-MM-DD）
  const dateCols = new Set(['生效日期', '有效期至', '发文日期']);

  console.log(`  列: ${cols.join('、') || '(无匹配展示列)'}`);
  const slice = records.slice(0, limit);
  for (const r of slice) {
    const parts = cols.map((c) => {
      let v = r.fields ? r.fields[c] : undefined;
      v = dateCols.has(c) ? msToDateText(v) : cellToText(v);
      if (typeof v === 'string' && v.length > 60) v = `${v.slice(0, 60)}…`;
      return `${c}=${v}`;
    });
    console.log(`  - ${r.record_id}  ${parts.join('  ')}`);
  }
  return { ok: true, category, total: conn.recordCount };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 26).join('\n'));
    return;
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('\n缺少 FEISHU_APP_ID / FEISHU_APP_SECRET。\n');
    console.error('步骤：');
    console.error('  1) 飞书开发者后台 → 你的自建应用 → 「凭证与基础信息」，复制 App ID / App Secret');
    console.error('  2) 「权限管理」搜索「多维表格」，开通 bitable:app（如需只读验证可先开 bitable:app:readonly）');
    console.error('  3) 创建应用版本并发布（新加权限必须发版才生效）');
    console.error('  4) 打开多维表格 → 右上角「分享」→ 添加协作者 → 输入应用名称/App ID，授「可编辑」');
    console.error('  5) 把两个值填进 feishu-webapp/.env（cp .env.example .env）后重跑本脚本\n');
    process.exit(2);
  }

  const client = new BitableClient({ appId, appSecret });

  if (args.all) {
    let okCount = 0;
    for (const src of POLICY_SOURCES) {
      const r = await probeOne(client, src, { printRecords: false });
      if (r.ok) okCount += 1;
    }
    console.log(`\n汇总：${okCount}/${POLICY_SOURCES.length} 张表直连成功`);
    process.exit(okCount === POLICY_SOURCES.length ? 0 : 1);
  }

  let target;
  if (args.table) {
    target = POLICY_SOURCES.find((s) => s.category === args.table);
    if (!target) {
      console.error(`未找到语义表「${args.table}」，可选：${POLICY_SOURCES.map((s) => s.category).join(' / ')}`);
      process.exit(2);
    }
  } else {
    target = POLICY_SOURCES[0]; // 默认最低工资
  }

  const r = await probeOne(client, target, { printRecords: true, limit: args.limit });
  if (!r.ok) {
    const msg = client.lastError ? client.lastError.message : '';
    if (/91403|125404|no permission|permission/i.test(msg)) {
      console.error('\n提示：疑似应用未加入表格协作者或权限未发版，见脚本头部「前置条件」。');
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n验证失败：', err.message || err);
  process.exit(1);
});
