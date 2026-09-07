'use strict';
/**
 * scripts/probe-write.js —— 飞书写权限实探（自建应用身份）
 *
 * 用 BitableClient.batchCreate 对「最低工资」专题表写一条 __PROBE__<ts> 临时记录，
 * 拿到 record_id 后立即 batchDelete 清理。绝不污染 578 条正式数据。
 *
 * 跑法： node scripts/probe-write.js
 * 退出码：0=可写；非 0=不可写（看 stdout 的 code 决定是 91403 缺协作权限/1254045 缺 API 权限/其它）
 */
// 简易 .env 加载（不依赖 dotenv 包；.env 已存在于项目根）
(function loadEnv() {
  const fs = require('fs');
  const p = require('path').join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
})();

const { BitableClient, fromEnv } = require('../src/bitable');

const APP_TOKEN = 'PTRkbDSiWa4Xmts0rStcaS2Ynbe';
const TABLE_ID = 'tbl6zo6GH73o7HCo'; // 最低工资
const PROBE_TITLE = `__PROBE__${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  const client = fromEnv(process.env);
  console.log('======================================================');
  console.log('飞书写权限实探（policy-webapp · Bitable）');
  console.log('  App :', process.env.FEISHU_APP_ID);
  console.log('  Tbl :', `${APP_TOKEN} / ${TABLE_ID}（最低工资）`);
  console.log('  Tag :', PROBE_TITLE);
  console.log('======================================================');

  // 0) token 获取
  let token;
  try {
    const data = await client._ensureToken();
    token = data;
    console.log('[0] tenant_access_token OK，长度 =', token.length, ' 预览:', token.slice(0, 12) + '...');
  } catch (err) {
    console.error('[0] ❌ token 获取失败：', err.message);
    process.exit(2);
  }

  // 1) 列出表字段（拿一个能写的列名）
  let fields;
  try {
    fields = await client.listFields(APP_TOKEN, TABLE_ID);
    console.log(`[1] 读字段 OK，共 ${fields.length} 列：`, fields.map((f) => f.name).join(' / '));
  } catch (err) {
    console.error('[1] ❌ 读字段失败 code=' + err.code, err.message);
    if (err.code === 91403) {
      console.error('    → 解读：表对当前应用凭证不可访问（多半是「协作者」未加或权限未发布）');
    } else if (err.code === 1254045) {
      console.error('    → 解读：应用未开通 bitable:app 写权限（需在开发者后台「权限管理」开通并发布版本）');
    }
    process.exit(3);
  }

  // 2) 写一条临时记录
  const writeFields = {};
  // 找一个文本列写探针标题
  const titleField = fields.find((f) => /标题|政策名|名称|题目|^title$/i.test(f.name));
  if (titleField) writeFields[titleField.name] = PROBE_TITLE;
  else writeFields[fields.find((f) => f.type === 1 || /text/i.test(f.ui_type || '')).name] = PROBE_TITLE;

  // 再写个省份（单选）让结构尽量完整
  const provField = fields.find((f) => /省份|地区|地域|区域|province/i.test(f.name));
  if (provField && provField.type === 3) {
    // 单选：直接给选项名（用表里第一个选项）
    const opts = (provField.property && provField.property.options) || [];
    if (opts[0]) writeFields[provField.name] = opts[0].name;
  } else if (provField) {
    writeFields[provField.name] = '北京市';
  }

  console.log('[2] 准备 batchCreate，fields =', JSON.stringify(writeFields));

  let created;
  try {
    const res = await client.batchCreate(APP_TOKEN, TABLE_ID, [{ fields: writeFields }]);
    created = res.records || [];
    console.log('[2] ✅ batchCreate 200 OK，写入条数 =', res.created);
    if (created[0]) console.log('    record_id =', created[0].record_id);
  } catch (err) {
    console.error('[2] ❌ batchCreate 失败 code=' + err.code, 'msg:', err.message);
    if (err.code === 91403) {
      console.error('    → 解读：写入被拒。无写权限。最常见两种情况：');
      console.error('      (a) 飞书后台「权限管理」未给该应用添加 bitable:app:write 权限（或 bitable:app 但未发布）');
      console.error('      (b) 最低工资表的「协作者」未把该应用加为「可编辑」');
    } else if (err.code === 1254045) {
      console.error('    → 解读：API 未授权（bitable:app 权限没勾/未发布）');
    } else if (err.code === 1254042) {
      console.error('    → 解读：被租户禁用或该 base 的安全设置禁止应用访问');
    }
    process.exit(4);
  }

  // 3) 立刻删掉（清理探针，绝不污染正式库）
  const ids = created.map((r) => r.record_id).filter(Boolean);
  if (ids.length) {
    try {
      const del = await client.batchDelete(APP_TOKEN, TABLE_ID, ids);
      console.log('[3] ✅ 清理 batchDelete OK，删除条数 =', del.deleted);
    } catch (err) {
      console.error('[3] ⚠️  清理失败（写权限 OK 但删失败）code=' + err.code, err.message);
      console.error('    请手动去飞书后台删除 __PROBE__ 开头的那行');
    }
  }

  console.log('======================================================');
  console.log('结论：写权限 ✅ 可用。batchCreate/batchDelete 都通。');
  console.log('======================================================');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
