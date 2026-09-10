#!/usr/bin/env node
'use strict';

const { provinceByKey } = require('../policy-api/src/crawl-regions');
const { enumerateProvinceDetailed } = require('../policy-api/src/enum-sources');

function parseArgs() {
  const argv = process.argv.slice(2);
  let region = '';
  let maxPages = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--region') region = argv[++i] || '';
    else if (argv[i] === '--max-pages') maxPages = Math.max(1, Math.min(3, parseInt(argv[++i], 10) || 1));
  }
  return { region, maxPages };
}

(async () => {
  try {
    const { region, maxPages } = parseArgs();
    const p = provinceByKey(region);
    if (!p) throw new Error(`地区无效: ${region}`);
    const started = Date.now();
    const result = await enumerateProvinceDetailed(p.name, { maxPages });
    const payload = {
      ok: result.ok,
      region: p.key,
      province: p.name,
      root: p.root,
      elapsedMs: Date.now() - started,
      itemCount: result.items.length,
      diagnostics: result.diagnostics,
      samples: result.items.slice(0, 12),
    };
    process.stdout.write('\n__RESULT__' + JSON.stringify(payload));
    process.exitCode = result.ok ? 0 : 2;
  } catch (e) {
    process.stdout.write('\n__RESULT__' + JSON.stringify({ ok:false, error:e.message || String(e) }));
    process.exitCode = 1;
  }
})();
