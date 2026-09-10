'use strict';
const assert=require('assert');
const fs=require('fs');
const {PROVINCES,REGIONS,CATEGORY_KEYWORDS,REGION_BATCHES,provinceByKey}=require('../policy-api/src/crawl-regions');
const {queueDecision,summarizeTasks}=require('../policy-api/src/crawl-mode');
const enums=require('../policy-api/src/enum-sources');
const {canonicalizeUrl}=require('../policy-api/src/url-utils');
const {evaluateSourceHealth,buildCompensationPlan,recoverExpiredCompensations}=require('../policy-api/src/source-health');
const {classifyBitableFailure}=require('../policy-api/src/bitable-failure');
const {judge}=require('../policy-api/src/quality-gate');

let n=0; function t(name,fn){fn();n++;console.log('✓',name);}
t('31省配置完整',()=>assert.equal(PROVINCES.length,31));
t('全国+31省=32地区',()=>assert.equal(REGIONS.length,32));
t('13个矩阵搜索词',()=>assert.equal(CATEGORY_KEYWORDS.length,13));
t('区域批次数量固定且完整',()=>{
  const counts=Object.fromEntries(REGION_BATCHES.map(x=>[x.id,x.regions.length*13]));
  assert.deepEqual(counts,{all:416,national:13,north:65,northeast:39,east:91,central:39,south:39,southwest:65,northwest:65});
});
t('地区查找函数可用',()=>assert.equal(provinceByKey('云南').name,'云南省'));
t('每日增量只接收上海时区当天且缺日期拒绝',()=>{
  const now=new Date('2026-09-09T02:00:00.000Z');
  assert.equal(queueDecision({releaseDate:'2026-09-09'},'daily',now).accept,true);
  assert.equal(queueDecision({releaseDate:'2026-09-08'},'daily',now).accept,false);
  assert.equal(queueDecision({},'daily',now).accept,false);
  assert.equal(queueDecision({releaseDate:'2020-01-01'},'initial',now).accept,true);
});
t('任务统计互斥',()=>assert.deepEqual(summarizeTasks([{status:'done'},{status:'error'},{status:'running'},{status:'paused'},{status:'todo'}]),{total:5,done:1,failed:1,running:1,paused:1,pending:1}));
t('枚举源注册31/31',()=>assert.equal(enums.registeredProvinces().length,31));
t('31省都有自动发现兜底',()=>{
  for (const p of PROVINCES) {
    const channels=enums.PROVINCE_CHANNELS[p.name]||[];
    assert.ok(channels.some(x=>x.type==='discover'),`${p.name} 缺少 discover fallback`);
  }
});
t('详细枚举诊断接口已导出',()=>assert.equal(typeof enums.enumerateProvinceDetailed,'function'));
t('来源诊断结构化保留入口URL',()=>{
  const src=enums.PROVINCE_CHANNELS['云南省'][0];
  assert.ok(src.pageUrl || src.rootUrl || src.sitemapUrl);
  const sweep=fs.readFileSync('scripts/sweep-crawl.js','utf8');
  assert.ok(sweep.includes("url:(x.urls || [])[0] || ''"));
});
t('URL规范化去跟踪参数',()=>assert.equal(canonicalizeUrl('https://A.com//x?utm_source=a&id=2#x'),'https://a.com/x?id=2'));
t('长期零新增判 suspicious',()=>assert.equal(evaluateSourceHealth({expectedUpdateDays:3},{endpoints:[{lastHttpOk:true}],consecutiveZeroNewRuns:4,lastDiscoveredAt:'2020-01-01',latestPrimaryPublishedAt:new Date().toISOString()}).status,'suspicious'));
t('首次成功但无发布日期不会误判 stale',()=>assert.equal(evaluateSourceHealth({expectedUpdateDays:3},{endpoints:[{lastHttpOk:true}],consecutiveZeroNewRuns:0}).status,'healthy'));
t('部分入口失败判 degraded',()=>assert.equal(evaluateSourceHealth({expectedUpdateDays:3},{endpoints:[{lastHttpOk:true},{lastHttpOk:false}],consecutiveZeroNewRuns:0}).status,'degraded'));
t('补偿计划能产生任务',()=>assert.ok(buildCompensationPlan({key:'吉林'},{status:'suspicious',reason:'abnormal_zero_updates'}).length>=2));
t('崩溃遗留 running 补偿会按 lease 恢复 retry',()=>{
  const q=[{status:'running',runId:'old',lastRunAt:'2020-01-01T00:00:00.000Z'}];
  assert.equal(recoverExpiredCompensations(q,Date.parse('2020-01-02T00:00:00.000Z'),60000),1);
  assert.equal(q[0].status,'retry'); assert.ok(!q[0].runId);
});
t('飞书错误正确区分可重试与数据校验失败',()=>{
  assert.equal(classifyBitableFailure(new Error('fetch failed: timeout')).retryable,true);
  assert.equal(classifyBitableFailure({statusCode:403,message:'Forbidden'}).kind,'permission');
  assert.equal(classifyBitableFailure({statusCode:400,message:'invalid field type'}).retryable,false);
});
t('搜狐转载不会进入待审批池',()=>{
  assert.equal(judge({title:'最低工资标准调整通知',url:'https://www.sohu.com/a/1',category:'最低工资'}).level,'drop');
});
const adminJs=fs.readFileSync('policy-api/public/admin/admin.js','utf8');
const crawlApiJs=fs.readFileSync('policy-api/src/crawl-api.js','utf8');
const sweepJs=fs.readFileSync('scripts/sweep-crawl.js','utf8');
t('审批列表按采集模式传参并在切换时刷新',()=>{
  assert.ok(adminJs.includes("'&mode=' + encodeURIComponent(S.crawlMode)"));
  assert.ok(crawlApiJs.includes("listMode === 'initial' || normalizePublishedDate"));
});
t('后台只使用区域批次且无旧15组合选择器',()=>{
  const html=fs.readFileSync('policy-api/public/admin/index.html','utf8');
  assert.ok(html.includes('region-tabs'));
  assert.ok(!html.includes('run-limit'));
  assert.ok(adminJs.includes('batch:S.batch'));
  assert.ok(!adminJs.includes('setInterval('));
});
t('手动巡检跑完不自动开启新周期',()=>{
  assert.ok(sweepJs.includes('if (!tasks.length && !region && !category && newCycle)'));
  assert.ok(sweepJs.includes("else if (argv[i] === '--new-cycle') args.newCycle = true"));
});
t('结束按钮使用全局停止接口，刷新后仍可停',()=>{
  assert.ok(adminJs.includes("/api/crawl/sweep-stop"));
  assert.ok(!adminJs.includes("if (!runId || S.runBusy === false) return;"));
});
t('Windows停止会杀整个巡检进程树',()=>{
  assert.ok(crawlApiJs.includes("'taskkill'"));
  assert.ok(crawlApiJs.includes("'/T', '/F'"));
  assert.ok(crawlApiJs.includes("['running','stopping']"));
});
t('全量巡检禁用AI逐格放大，异常再走deep补偿',()=>{
  assert.ok(crawlApiJs.includes("childEnv.SWEEP_AI_FALLBACK = 'false'"));
  assert.ok(crawlApiJs.includes("childEnv.CRAWL_SEARCH_DEPTH = 'deep'"));
  assert.ok(crawlApiJs.includes("deep:true"));
});
t('补偿巡检使用独立锁owner',()=>assert.ok(crawlApiJs.includes("owner:'compensation'")));
t('补偿 mode/lookback 传入 sweep 并改变回溯行为',()=>{
  assert.ok(crawlApiJs.includes('compensationMode:q.mode'));
  assert.ok(crawlApiJs.includes('lookbackDays:q.lookbackDays'));
  assert.ok(sweepJs.includes("'--compensation-mode'"));
  assert.ok(sweepJs.includes('enumMaxPagesForCompensation'));
});
t('local-run 不再固定返回 ok:true',()=>{
  const cronJs=fs.readFileSync('policy-api/src/cron.js','utf8');
  assert.ok(cronJs.includes('const ok = r.code === 0'));
  assert.ok(!cronJs.includes("const res = { ok: true, source: 'local_sweep' }"));
});
t('Windows启动脚本统一使用4201且不引用旧SPA',()=>{
  for(const p of ['start.bat','start-headless.bat','启动本地服务.bat']){
    const text=fs.readFileSync(p,'utf8');
    assert.ok(text.includes('PORT=4201'),`${p} 未使用4201`);
    assert.ok(!text.includes('2026-08-27-12-59-41'),`${p} 仍引用旧SPA`);
  }
});
const d=JSON.parse(fs.readFileSync('data/db.json','utf8'));
const expectedQueueMin=process.env.EXPECTED_CRAWL_QUEUE_MIN === undefined ? 150 : Number(process.env.EXPECTED_CRAWL_QUEUE_MIN);
const expectedDoneMin=process.env.EXPECTED_CRAWL_DONE_MIN === undefined ? 142 : Number(process.env.EXPECTED_CRAWL_DONE_MIN);
t(`待审批基线不回退（>=${expectedQueueMin}）`,()=>assert.ok((d.crawlQueue||[]).length>=expectedQueueMin,`crawlQueue=${(d.crawlQueue||[]).length}`));
t('矩阵416条',()=>assert.equal((d.crawlTasks||[]).length,416));
t(`旧完成进度不回退（>=${expectedDoneMin}）`,()=>assert.ok((d.crawlTasks||[]).filter(x=>x.status==='done').length>=expectedDoneMin));
console.log(`\n${n}/${n} passed`);
