#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const BASE = 'http://127.0.0.1:4201';
const originalDb = fs.readFileSync(DB_PATH);
let server;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeDb(mutator) {
  const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  mutator(data);
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error(`等待超时（${timeoutMs}ms）`);
}

async function request(pathname, { method = 'GET', body, cookie = '' } = {}) {
  const response = await fetch(BASE + pathname, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const message = data && data.message ? data.message : String(data || response.statusText);
    throw new Error(`${method} ${pathname} -> ${response.status}: ${message}`);
  }
  return { response, data };
}

async function login() {
  const response = await fetch(BASE + '/auth/login', { redirect: 'manual' });
  assert.equal(response.status, 302, 'MOCK 登录入口应返回 302');
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';', 1)[0];
  assert.ok(cookie.includes('='), 'MOCK 登录没有返回会话 Cookie');
  return cookie;
}

async function runState(runId, cookie) {
  return (await request(`/api/crawl/matrix-run/${runId}`, { cookie })).data;
}

async function waitRunEnded(runId, cookie) {
  return waitFor(async () => {
    const state = await runState(runId, cookie);
    return ['running', 'stopping'].includes(state.state) ? null : state;
  }, 20000, 200);
}

async function waitIdle(cookie) {
  return waitFor(async () => {
    const status = (await request('/api/crawl/matrix-status', { cookie })).data;
    return status.activeSweep?.busy || status.sweepLock?.locked || status.running?.length ? null : status;
  }, 20000, 200);
}

async function main() {
  const serverLog = [];
  // 给问题中心放入确定性的失败诊断。这里只修改隔离测试 DB，finally 会逐字节恢复。
  writeDb((data) => {
    data.sourceHealth = [{
      id: '云南', region: '云南', province: '云南省', status: 'down',
      reason: 'no_successful_endpoint', lastError: '官方入口全部失败',
      endpoints: [
        { kind: 'official_page', label: '政策文件', url: 'https://www.yn.gov.cn/zwgk/', lastHttpOk: false, lastError: 'HTTP 404' },
        { kind: 'official_discover', label: '自动发现', url: 'https://www.yn.gov.cn/zhengce/', lastHttpOk: false, lastError: 'timeout after 2500ms' },
        { kind: 'official_page', label: '人社政策', url: 'https://hrss.yn.gov.cn/', lastHttpOk: false, lastError: 'EAI_AGAIN DNS lookup failed' },
      ],
    }];
  });
  server = spawn(process.execPath, ['policy-api/src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${path.join(__dirname, 'no-external-network.js')}`.trim(),
      PORT: '4201',
      NODE_ENV: 'development',
      MOCK_LOGIN: 'true',
      FEISHU_APP_ID: 'local_acceptance_app',
      FEISHU_APP_SECRET: 'local_acceptance_secret',
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      FEISHU_AUTH_TIMEOUT_MS: '1000',
      BITABLE_HTTP_TIMEOUT_MS: '1000',
      ENUM_HTTP_TIMEOUT_MS: '2500',
      ENUM_HTTP_RETRIES: '0',
      SWEEP_AI_FALLBACK: 'false',
      SWEEP_TASK_DELAY_MS: '0',
      CRON_ENABLED: 'false',
      SKIP_STARTUP_PREFLIGHT: 'true',
      SWEEP_TEST_HOLD_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (chunk) => {
      serverLog.push(String(chunk));
      if (serverLog.length > 100) serverLog.shift();
    });
  }

  await waitFor(async () => {
    const { data } = await request('/api/health');
    return data?.status === 'ok' ? data : null;
  });

  const health = (await request('/api/health')).data;
  const admin = await request('/admin/');
  const home = await request('/');
  assert.equal(health.status, 'ok');
  assert.match(String(admin.data), /政策采集|审批/);
  assert.match(String(home.data), /政策/);
  console.log('✓ 4201 health/admin/home 均返回 200');

  const cookie = await login();

  // 区域批次必须按固定地区集合统计，不再暴露旧 5/15/30 组合概念。
  const eastBatch = (await request('/api/crawl/matrix-status?batch=east', { cookie })).data;
  assert.equal(eastBatch.total, 91);
  assert.deepEqual(eastBatch.batch.regions, ['上海','江苏','浙江','安徽','福建','江西','山东']);
  const taskId = eastBatch.tasks[0].id;
  const paused = (await request('/api/crawl/tasks/' + encodeURIComponent(taskId), { method:'PATCH', cookie, body:{ action:'pause', priority:20 } })).data;
  assert.equal(paused.task.state, 'paused');
  assert.equal(paused.task.priority, 20);
  const resumed = (await request('/api/crawl/tasks/' + encodeURIComponent(taskId), { method:'PATCH', cookie, body:{ action:'resume' } })).data;
  assert.equal(resumed.task.state, 'pending');
  console.log('✓ 华东批次固定为 91 组合，任务暂停/恢复/优先级生效');

  // 1. 把隔离 DB 的当前轮临时设为全部完成，真实启动一次“一键巡检”。
  // 子进程应直接结束，且不能 reset 后再开启下一轮。
  writeDb((data) => {
    for (const task of data.crawlTasks || []) task.status = 'done';
  });
  const completedStart = (await request('/api/crawl/matrix-run', {
    method: 'POST', cookie, body: { all: true },
  })).data;
  const completedRun = await waitRunEnded(completedStart.runId, cookie);
  assert.equal(completedRun.state, 'done');
  assert.equal(completedRun.result?.ok, true);
  assert.equal(completedRun.result?.done, 0);
  const afterComplete = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  assert.equal((afterComplete.crawlTasks || []).filter((task) => task.status === 'done').length, 416);
  await sleep(500);
  const noRestart = (await request('/api/crawl/matrix-status', { cookie })).data;
  assert.equal(noRestart.activeSweep?.busy, false);
  console.log('✓ 巡检跑完自动停，未开启下一轮');

  // 2. 制造一个待跑任务，启动后立即通过全局停止接口结束。
  writeDb((data) => { if (data.crawlTasks?.[0]) data.crawlTasks[0].status = 'todo'; });
  const stopStart = (await request('/api/crawl/matrix-run', {
    method: 'POST', cookie, body: { limit: 1 },
  })).data;
  const stopResponse = (await request('/api/crawl/sweep-stop', {
    method: 'POST', cookie, body: {},
  })).data;
  assert.equal(stopResponse.stopping, true);
  const stoppedRun = await waitRunEnded(stopStart.runId, cookie);
  assert.equal(stoppedRun.state, 'killed');
  await waitIdle(cookie);
  console.log('✓ 运行中停止生效，子进程结束且 sweep lock 已释放');

  // 3. 再启动一次，用全新 Cookie 模拟刷新后的页面；不使用旧 runId 发停止请求。
  writeDb((data) => { if (data.crawlTasks?.[1]) data.crawlTasks[1].status = 'todo'; });
  const refreshStart = (await request('/api/crawl/matrix-run', {
    method: 'POST', cookie, body: { limit: 1 },
  })).data;
  const refreshedCookie = await login();
  const refreshedStatus = (await request('/api/crawl/matrix-status', { cookie: refreshedCookie })).data;
  assert.equal(refreshedStatus.activeSweep?.busy, true);
  const refreshedStop = (await request('/api/crawl/sweep-stop', {
    method: 'POST', cookie: refreshedCookie, body: {},
  })).data;
  assert.equal(refreshedStop.stopping, true);
  const refreshedEnded = await waitRunEnded(refreshStart.runId, refreshedCookie);
  assert.equal(refreshedEnded.state, 'killed');
  await waitIdle(refreshedCookie);
  console.log('✓ 刷新/新会话后仍能识别并停止当前巡检');

  // 4. 验证问题中心的 31 省结构和完整错误原因。
  const issueCenter = (await request('/api/crawl/source-health', { cookie: refreshedCookie })).data;
  assert.equal(issueCenter.totalProvinces, 31);
  assert.equal(issueCenter.items.length, 32); // 全国专项 + 31省
  assert.ok(issueCenter.items.every((item) => item.region && item.status && item.action));
  const yunnan = issueCenter.items.find((item) => item.region === '云南');
  assert.equal(yunnan.status, 'down');
  assert.equal(yunnan.badEndpoints.length, 3);
  assert.match(JSON.stringify(yunnan.badEndpoints), /HTTP 404/);
  assert.match(JSON.stringify(yunnan.badEndpoints), /timeout/i);
  assert.match(JSON.stringify(yunnan.badEndpoints), /EAI_AGAIN|DNS/i);
  console.log('✓ 来源问题中心返回 31 省，并保留 URL、404、timeout、DNS 失败原因');

  if (process.env.SKIP_LIVE_PROBE !== 'true') {
    const probe = (await request('/api/crawl/source-probe/云南', {
      method: 'POST', cookie: refreshedCookie, body: {},
    })).data;
    assert.equal(probe.region, '云南');
    assert.ok(Array.isArray(probe.diagnostics) && probe.diagnostics.length > 0);
    const failedDiagnostics = probe.diagnostics.filter((item) => !item.ok);
    if (failedDiagnostics.length) {
      assert.match(JSON.stringify(failedDiagnostics), /(https?:\/\/|HTTP\s*\d+|timeout|EAI_|ENOTFOUND|ECONN|解析)/i);
    }
    console.log(`  云南 live probe: ${probe.ok ? '成功' : '失败已明确诊断'}，${probe.itemCount} 条，${probe.elapsedMs}ms`);
  }
  console.log('\n5/5 runtime acceptance passed');
}

main().catch((error) => {
  console.error('\n运行验收失败:', error.stack || error.message || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      sleep(2000),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  fs.writeFileSync(DB_PATH, originalDb);
});
