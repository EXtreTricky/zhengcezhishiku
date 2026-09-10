#!/usr/bin/env node
'use strict';

/**
 * preflight.js —— 生产部署自检
 *
 * 在「重启服务之前」把会让人抓狂的坑一次性体检完：
 *   环境变量 / 密钥强度 / MOCK 泄漏 / 回调地址 / 磁盘可写 / 自建前端
 *   / 飞书凭据 / IP 白名单 / 10 张表的读权限 / 写权限 / 线上连通性
 *
 * 用法：
 *   node scripts/preflight.js                 # 全量（含联网与线上探活）
 *   node scripts/preflight.js --local         # 只做本地检查（deploy.sh 在重启前调用）
 *   node scripts/preflight.js --no-write-test # 跳过往表里写一条再删除的写权限探测
 *   node scripts/preflight.js --url https://policy.example.com
 *
 * 退出码：0=通过（允许警告）  1=存在致命问题，不要上线
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const LOCAL_ONLY = has('--local');
const DO_WRITE_TEST = !has('--no-write-test');
const urlArgIdx = argv.indexOf('--url');
const BASE_URL = urlArgIdx >= 0 ? argv[urlArgIdx + 1] : '';

// ── 输出 ────────────────────────────────────────────────────────────────
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[36m', x: '\x1b[0m' };
let fatal = 0;
let warned = 0;

function ok(msg, extra) {
  console.log(`  ${C.g}✓${C.x} ${msg}${extra ? ` ${C.d}${extra}${C.x}` : ''}`);
}
function bad(msg, fix) {
  fatal++;
  console.log(`  ${C.r}✗ ${msg}${C.x}`);
  if (fix) console.log(`      ${C.d}→ ${fix}${C.x}`);
}
function warn(msg, fix) {
  warned++;
  console.log(`  ${C.y}! ${msg}${C.x}`);
  if (fix) console.log(`      ${C.d}→ ${fix}${C.x}`);
}
function section(title) {
  console.log(`\n${C.b}${title}${C.x}`);
}

// ── 1. 环境变量 ─────────────────────────────────────────────────────────
const {
  FEISHU_APP_ID: APP_ID,
  FEISHU_APP_SECRET: APP_SECRET,
  FEISHU_REDIRECT_URI: REDIRECT_URI,
  SESSION_SECRET,
  NODE_ENV,
  MOCK_LOGIN,
  FEISHU_CRAWL_APP_TOKEN: CRAWL_TOKEN,
  FEISHU_CRAWL_TABLE_ID: CRAWL_TABLE,
} = process.env;

section('① 环境变量');
const REQUIRED = [
  ['FEISHU_APP_ID', APP_ID, '飞书开放平台 → 凭证与基础信息'],
  ['FEISHU_APP_SECRET', APP_SECRET, '同上，注意不要带空格或换行'],
  ['SESSION_SECRET', SESSION_SECRET, 'openssl rand -hex 32 生成'],
];
for (const [k, v, hint] of REQUIRED) {
  if (v && String(v).trim()) ok(`${k} 已设置`);
  else bad(`${k} 缺失`, hint);
}

const PLACEHOLDER = [
  'cli_xxxxxxxxxxxxxxxx',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  '请替换为32字节随机十六进制串',
  'please_change_me_to_a_random_32_byte_hex',
  'your.domain.com',
];
for (const [k, v] of REQUIRED) {
  if (v && PLACEHOLDER.includes(String(v).trim())) {
    bad(`${k} 仍是示例占位值`, '把 .env.production.example 里的假值替换成真实值');
  }
}

// SESSION_SECRET 强度
if (SESSION_SECRET) {
  const s = String(SESSION_SECRET).trim();
  if (s.length < 32) bad('SESSION_SECRET 长度不足 32 字符', 'openssl rand -hex 32');
  else if (!/^[0-9a-fA-F]{32,}$/.test(s)) warn('SESSION_SECRET 不是十六进制串（长度够也能用，但建议换成 hex）');
  else ok('SESSION_SECRET 强度合格');
}

// NODE_ENV
if (NODE_ENV === 'production') ok('NODE_ENV=production');
else warn(`NODE_ENV=${NODE_ENV || '(未设置)'}`, '生产环境请设 NODE_ENV=production，否则 Cookie 不带 Secure');

// MOCK_LOGIN —— 生产绝不能开
if (NODE_ENV === 'production' && String(MOCK_LOGIN).toLowerCase() === 'true') {
  bad('MOCK_LOGIN=true 且 NODE_ENV=production：服务会拒绝启动', '在 .env 里删除或改为 false');
} else if (String(MOCK_LOGIN).toLowerCase() === 'true') {
  warn('MOCK_LOGIN=true（当前非 production，服务将绕过飞书登录）', '上线前务必改为 false');
} else {
  ok('MOCK_LOGIN 未开启');
}

// ── 2. 回调地址 ─────────────────────────────────────────────────────────
section('② OAuth 回调地址');
let siteOrigin = BASE_URL.replace(/\/+$/, '');
if (!REDIRECT_URI) {
  if (LOCAL_ONLY || MOCK_LOGIN === 'true') {
    warn('FEISHU_REDIRECT_URI 未配置（本地 mock 模式，不影响运行）', '生产必须设置 https://正式域名/auth/callback');
  } else {
    bad('FEISHU_REDIRECT_URI 缺失', '填 https://你的域名/auth/callback');
  }
} else {
  let u = null;
  try {
    u = new URL(REDIRECT_URI);
  } catch {
    bad('FEISHU_REDIRECT_URI 不是合法 URL', REDIRECT_URI);
  }
  if (u) {
    if (u.protocol !== 'https:') bad('回调地址不是 https', '飞书强制要求 HTTPS 回调');
    else ok('回调地址使用 HTTPS');
    if (!u.pathname.endsWith('/auth/callback')) {
      warn(`回调路径是 ${u.pathname}，非 /auth/callback`, '确认与飞书后台登记的完全一致');
    } else ok('回调路径为 /auth/callback');
    if (u.search || u.hash) warn('回调地址带 query/hash', '飞书后台登记时必须逐字符一致');
    if (!siteOrigin) siteOrigin = u.origin;
  }
  console.log(`      ${C.d}当前值：${REDIRECT_URI}${C.x}`);
  console.log(`      ${C.d}飞书后台 → 安全设置 → 重定向 URL 必须与上面完全一致${C.x}`);
}

// ── 3. 本地磁盘 ─────────────────────────────────────────────────────────
section('③ 本地文件与目录');
const DATA_DIR = path.join(__dirname, '..', 'data');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, '.preflight-probe');
  fs.writeFileSync(probe, 'ok');
  // 只验证「能写且能读回」即可；清理失败不判致命（某些环境会拦截删除）
  const back = fs.readFileSync(probe, 'utf8');
  ok('data/ 目录可读写（db.json 落盘正常）');
  if (back !== 'ok') bad('data/ 写入后读回内容不一致');
  try {
    fs.unlinkSync(probe);
  } catch {
    /* 忽略：残留一个隐藏探针文件不影响服务 */
  }
} catch (err) {
  bad(`data/ 目录不可写：${err.message}`, '检查运行用户对 data/ 的权限（systemd 里配了 ReadWritePaths）');
}
if (fs.existsSync(path.join(DATA_DIR, 'db.json'))) {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
    const db = JSON.parse(raw);
    const pending = (db.syncOutbox || []).length;
    ok(`db.json 可解析（${(raw.length / 1024).toFixed(1)} KB）`);
    if (pending > 0) {
      warn(`syncOutbox 积压 ${pending} 条待同步写操作`, '说明多维表格写权限曾失效，须授权后调用 POST /api/bitable/sync-out 补推');
    }
  } catch (err) {
    bad(`db.json 解析失败：${err.message}`, '从备份恢复，或删除让它重建（会丢本地写操作）');
  }
} else {
  warn('data/db.json 不存在（首次启动会自动创建）');
}

// 自建前端（总览首页 + 审批台，随包托管，无外部产物依赖）
const FE_DIR = path.join(__dirname, '..', 'policy-api', 'public');
if (
  fs.existsSync(path.join(FE_DIR, 'index.html')) &&
  fs.existsSync(path.join(FE_DIR, 'admin', 'index.html'))
) {
  ok(`自建前端就位：${FE_DIR}（总览首页 / + 审批台 /admin/）`);
} else {
  bad('未找到自建前端页面', `检查 ${FE_DIR} 下是否有 index.html 与 admin/index.html（随代码包一起部署）`);
}

// ── 4. 定时采集配置 ─────────────────────────────────────────────────────
section('④ 每日定时采集');
if (process.env.CRON_ENABLED === 'true') {
  ok(`定时采集已启用（每天 ${process.env.CRON_HOUR || 8}:${String(process.env.CRON_MINUTE || 0).padStart(2, '0')}）`);
  if (!CRAWL_TOKEN || !CRAWL_TABLE) {
    warn('未配置 FEISHU_CRAWL_APP_TOKEN / FEISHU_CRAWL_TABLE_ID，定时任务会空跑', '填入爬虫汇总表的 appToken 与 tableId，或关闭 CRON_ENABLED');
  } else ok('爬虫汇总表已配置');
} else {
  warn('CRON_ENABLED 未开启', '需要每天自动采集比对时设为 true');
}

// 本地检查到此结束
if (LOCAL_ONLY) {
  console.log(`\n${C.d}--local 模式：已跳过联网与线上探活${C.x}`);
  report();
}

// ── 5. 飞书连通性 ───────────────────────────────────────────────────────
async function networkChecks() {
  const { BitableClient } = require('../src/bitable');
  const { POLICY_SOURCES } = require('../policy-api/src/policy-sources');
  const client = new BitableClient({ appId: APP_ID, appSecret: APP_SECRET, logger: { warn() {}, error() {} } });

  section('⑤ 飞书凭据与网络');
  if (!APP_ID || !APP_SECRET) {
    bad('凭据缺失，跳过飞书检查');
    return;
  }
  try {
    await client._ensureToken();
    ok('tenant_access_token 获取成功（App ID / Secret 正确）');
  } catch (err) {
    bad(`获取 tenant_access_token 失败：${err.message}`, '检查凭据；若提示 IP 不在白名单，把服务器出口 IP 加到飞书后台 → 安全设置 → IP 白名单');
    return;
  }

  section('⑥ 多维表格读权限（10 张专题表）');
  let readOk = 0;
  for (const src of POLICY_SOURCES) {
    try {
      const d = await client.listRecordsPage(src.appToken, src.tableId, { pageSize: 1 });
      const total = typeof d.total === 'number' ? d.total : (d.items || []).length;
      ok(`${src.category.padEnd(6, '　')} ${String(total).padStart(4)} 条`);
      readOk++;
    } catch (err) {
      bad(`${src.category} 读取失败：${err.message}`, '飞书后台开通 bitable:app 权限，并到 Base 里「添加文档应用」把本应用加为可编辑');
    }
  }
  if (readOk === POLICY_SOURCES.length) ok('全部 10 张表可读');

  // ── 7. 写权限探测 ──
  section('⑦ 多维表格写权限（决定「确认入库」能否真实写入）');
  if (!DO_WRITE_TEST) {
    warn('已跳过写权限探测（--no-write-test）', '强烈建议跑一次：写权限缺失时「确认入库」只会进待同步队列，不会真正写入');
  } else {
    const probe = POLICY_SOURCES[0];
    let createdId = null;
    try {
      const res = await client.batchCreate(probe.appToken, probe.tableId, [
        { fields: { 省份: '__preflight_probe__' } },
      ]);
      createdId = (res.records || [])[0] && (res.records || [])[0].record_id;
      ok(`写入探测成功（在「${probe.category}」表建了一条测试记录）`);
    } catch (err) {
      bad(`写入被拒：${err.message}`,
        '打开 Base → 右上「…」→ 更多 → 添加文档应用 → 搜索本应用 → 授予【可编辑】。未授权时写操作会降级进 syncOutbox 队列');
    }
    if (createdId) {
      try {
        await client.batchDelete(probe.appToken, probe.tableId, [createdId]);
        ok('测试记录已清理');
      } catch (err) {
        warn(`测试记录删除失败，请手动删除 record_id=${createdId}`, `表：${probe.category}`);
      }
    }
  }

  // ── 8. 线上探活 ──
  section('⑧ 线上服务探活');
  if (!siteOrigin) {
    warn('无法确定站点地址（未设 FEISHU_REDIRECT_URI 也未传 --url）', 'node scripts/preflight.js --url https://你的域名');
  } else {
    const target = siteOrigin.replace(/\/+$/, '');
    for (const [label, p, expect] of [
      ['/healthz', '/healthz', (r, body) => r.status === 200 && /"ok"\s*:\s*true/.test(body)],
      ['/api/me（未登录应返回 401）', '/api/me', (r, body) => r.status === 401 && body.includes('loginUrl')],
      ['/ （应返回自建总览首页）', '/', (r, body) => r.status === 200 && /政策知识库/.test(body) && /statCards/.test(body)],
    ]) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(target + p, { redirect: 'manual', signal: ctrl.signal });
        clearTimeout(timer);
        const body = await res.text();
        if (expect(res, body)) ok(`${label} → ${res.status}`);
        else bad(`${label} 返回异常 → ${res.status}`, `响应片段：${body.slice(0, 120).replace(/\n/g, ' ')}`);
      } catch (err) {
        bad(`${label} 请求失败：${err.message}`, '检查 Nginx 是否在运行、证书是否有效、DNS 是否解析到本机');
      }
    }
  }
}

function report() {
  section('──────── 人工核对清单（脚本无法自动校验，请逐条确认）────────');
  const manual = [
    '飞书后台 → 应用能力 → 已添加【网页应用】，PC/移动端主页都填 https://' + (siteOrigin ? siteOrigin.replace(/^https?:\/\//, '') : '你的域名'),
    '飞书后台 → 安全设置 → 重定向 URL 已登记 ' + (REDIRECT_URI || 'https://你的域名/auth/callback'),
    '飞书后台 → 权限管理 → 已开通 bitable:app（多维表格）与获取登录用户信息',
    '政策知识库 Base → 「…」→ 更多 → 添加文档应用 → 本应用已授予【可编辑】',
    '飞书后台 → 安全设置 → IP 白名单 已加入服务器公网出口 IP',
    '飞书后台 → 版本管理与发布 → 已创建版本并审批通过，可用范围包含目标用户',
    '域名证书有效且未过期（certbot 自动续期已配置）',
    'data/db.json 已纳入每日备份（deploy/backup-db.sh）',
  ];
  manual.forEach((m, i) => console.log(`  ${C.d}${String(i + 1).padStart(2)}.${C.x} ${m}`));

  console.log(`\n${C.b}════════ 体检结果 ════════${C.x}`);
  if (fatal === 0 && warned === 0) console.log(`  ${C.g}全部通过，可以上线。${C.x}`);
  else if (fatal === 0) console.log(`  ${C.y}无致命问题，但有 ${warned} 项警告，建议确认后再上线。${C.x}`);
  else console.log(`  ${C.r}发现 ${fatal} 项致命问题（另有 ${warned} 项警告），请先修复。${C.x}`);
  console.log('');
  process.exit(fatal === 0 ? 0 : 1);
}

(async () => {
  try {
    await networkChecks();
  } catch (err) {
    bad(`联网检查异常终止：${err.message}`);
  }
  report();
})();
