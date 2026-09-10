#!/usr/bin/env node
/**
 * crawl-once.js —— 单次采集进程（被 /api/crawl/compare 以子进程方式调用）
 *
 * 为什么单独起进程：搜索引擎（百度/bing/政策库）对「长驻服务器进程」的连续
 * 高频请求会降级返回垃圾结果，而对一次性新进程的首次请求正常。实测同一机器
 * 同一时刻：服务器进程 0 条 vs 独立进程 5 条。因此每次点击都起一个干净进程。
 *
 * 用法：node scripts/crawl-once.js "<keyword>" "<region>"
 * 输出：stdout 最后一行 JSON { ok, items, error }
 */
require('fs')
  .readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8')
  .split('\n')
  .forEach((l) => {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(l.trim());
    if (m) process.env[m[1]] = m[2];
  });

const [keyword, region] = process.argv.slice(2);

(async () => {
  try {
    const crawler = require('../policy-api/src/crawler');
    const items = await crawler.crawlPolicies({ keyword, region });
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: true, items }));
  } catch (err) {
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok: false, error: err.message, items: [] }));
    process.exitCode = 1;
  }
})();
