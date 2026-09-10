#!/usr/bin/env node
/**
 * start-detached.js —— 独立启动包装器
 * 设置必要环境变量后启动 server.js，用于 Windows PowerShell 后台启动
 */
const path = require('path');
const fs = require('fs');

// 加载 .env
const envPath = path.join(__dirname, '.env');
try {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((l) => {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(l.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) {}

// 覆盖关键变量
process.env.MOCK_LOGIN = 'true';
process.env.NODE_ENV = 'development';
process.env.PORT = '4201';
process.env.CRON_ENABLED = 'true';
process.env.CRON_INTERVAL_HOURS = '6';

console.log(`[start-detached] PORT=${process.env.PORT} MOCK=${process.env.MOCK_LOGIN}`);
require('./policy-api/src/server');
