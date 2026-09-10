'use strict';
const fs=require('fs');
const path=require('path');
process.env.FEISHU_APP_ID='x';
process.env.FEISHU_APP_SECRET='y';
process.env.SESSION_SECRET='12345678901234567890123456789012';
process.env.MOCK_LOGIN='true';
process.env.NODE_ENV='development';
process.env.CRON_ENABLED='false';
const { buildMatrix } = require('../policy-api/src/crawl-regions');
const db=require('../src/db');
const crawler=require('../policy-api/src/crawler');
const { registerCrawlRoutes }=require('../policy-api/src/crawl-api');

function shDay(offset=0){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+offset*86400000));
}
const today=shDay();
const yesterday=shDay(-1);
const tasks=buildMatrix();
for(const t of tasks){t.enabled=true;t.priority=0;}
const sh=tasks.find(t=>t.region==='上海'&&t.keyword==='最低工资标准'); sh.dailyDate=today;sh.dailyStatus='done';sh.dailyLastRun=new Date().toISOString();sh.lastFlow={mode:'daily',discovered:3,filtered:1,dateFiltered:1,qualityDropped:0,duplicates:0,queued:2,at:new Date().toISOString()};
const js=tasks.find(t=>t.region==='江苏'&&t.keyword==='最低工资标准'); js.dailyDate=today;js.dailyStatus='error';js.error='timeout';js.dailyLastRun=new Date().toISOString();
const zj=tasks.find(t=>t.region==='浙江'&&t.keyword==='最低工资标准'); zj.enabled=false;
const bj=tasks.find(t=>t.region==='北京'&&t.keyword==='最低工资标准'); bj.dailyDate=today;bj.dailyStatus='done';bj.dailyLastRun=new Date().toISOString();
const seed={
 meta:{version:1},seq:{policy:1,crawl:100,sync:100,cmp:100},config:{},policies:[],versions:[],intakes:[],modifications:[],feedbacks:[],reviews:[],subscriptions:[],audits:[],crawlRuns:[],
 crawlTasks:tasks,
 crawlQueue:[
  {id:'sh1',title:'上海市最低工资标准调整通知',url:'https://www.shanghai.gov.cn/x1',region:'上海',category:'最低工资',releaseDate:today,status:'pending',quality:'pass',sourceTaskId:sh.id,discoveredAt:new Date().toISOString()},
  {id:'shold',title:'上海市最低工资历史通知',url:'https://www.shanghai.gov.cn/xold',region:'上海',category:'最低工资',releaseDate:yesterday,status:'pending',quality:'pass',sourceTaskId:sh.id,discoveredAt:new Date(Date.now()-86400000).toISOString()},
  {id:'bj1',title:'北京市最低工资标准通知',url:'https://www.beijing.gov.cn/x1',region:'北京',category:'最低工资',releaseDate:today,status:'pending',quality:'pass',sourceTaskId:bj.id,discoveredAt:new Date().toISOString()},
  {id:'shsync',title:'上海平均工资标准通知',url:'https://www.shanghai.gov.cn/x2',region:'上海',category:'平均工资',releaseDate:today,status:'pending_sync',quality:'pass'},
 ],
 syncOutbox:[{id:'ob1',sourceItemId:'shsync',category:'平均工资',synced:false,lastError:'403 Forbidden',createdAt:new Date().toISOString()}],
 sourceHealth:[
  {region:'上海',status:'healthy',reason:'ok',lastRunAt:new Date().toISOString(),lastHits:3,lastAdded:2,endpoints:[{lastHttpOk:true}],searchItems:2,enumItems:1},
  {region:'江苏',status:'degraded',reason:'partial_endpoint_failure',lastRunAt:new Date().toISOString(),lastHits:0,lastAdded:0,endpoints:[{lastHttpOk:true},{lastHttpOk:false,lastError:'404'}]},
  {region:'全国',status:'healthy',reason:'ok',lastRunAt:new Date().toISOString(),lastHits:1,lastAdded:1,endpoints:[{lastHttpOk:true}],searchItems:1,enumItems:0}
 ],
 compensationQueue:[{id:'cmp1',region:'江苏',mode:'endpoint-retry',status:'queued',priority:10,attempts:0,createdAt:new Date().toISOString(),nextRunAt:new Date().toISOString()}]
};
fs.mkdirSync(path.join(__dirname,'../data'),{recursive:true});
fs.writeFileSync(path.join(__dirname,'../data/db.json'),JSON.stringify(seed,null,2));
db.reload();

class App{
 constructor(){this.routes={GET:[],POST:[]};}
 get(path,...hs){this.routes.GET.push({path,hs});}
 post(path,...hs){this.routes.POST.push({path,hs});}
 use(){}
}
function match(pattern,path){
 const a=pattern.split('/'),b=path.split('/'); if(a.length!==b.length)return null; const params={};
 for(let i=0;i<a.length;i++){if(a[i].startsWith(':'))params[a[i].slice(1)]=decodeURIComponent(b[i]); else if(a[i]!==b[i])return null;} return params;
}
async function invoke(app,method,url,{body={},user={sub:'u1'}}={}){
 const u=new URL('http://x'+url); let route,params;
 for(const r of app.routes[method]){const m=match(r.path,u.pathname); if(m){route=r;params=m;break;}}
 if(!route) throw new Error('route missing '+method+' '+url);
 const req={body,query:Object.fromEntries(u.searchParams),params,user,headers:{}};
 const res={statusCode:200,body:null,status(c){this.statusCode=c;return this;},json(x){this.body=x;return this;},send(x){this.body=x;return this;},append(){return this;}};
 let idx=0,err;
 const next=async(e)=>{if(e){err=e;return;} const h=route.hs[idx++]; if(h) await h(req,res,next);};
 await next(); if(err) throw err; return res;
}

const app=new App();
let batchCreateMode='ok';
const fakeFields=[
 {name:'标题',type:1,ui_type:'Text'},
 {name:'地区',type:1,ui_type:'Text'},
 {name:'发文日期',type:5,ui_type:'Date'},
 {name:'来源链接',type:15,ui_type:'Url'},
 {name:'最低工资',type:2,ui_type:'Number'},
];
let compareAvailable=true;
const bitable={
 async listFields(){return fakeFields;},
 async batchCreate(){if(batchCreateMode==='403')throw new Error('403 Forbidden');return {created:1};}
};
const store={async getAll(){if(!compareAvailable) throw new Error('compare down'); return [];}};
registerCrawlRoutes(app,{store,bitable});

(async()=>{
 const out=[];
 function ok(name,cond,detail){if(!cond)throw new Error('FAIL '+name+' '+JSON.stringify(detail));out.push('✓ '+name);}
 let r=await invoke(app,'GET','/api/crawl/matrix-status?batch=%E5%8D%8E%E4%B8%9C&mode=daily');
 ok('华东矩阵总数91',r.body.total===91,r.body);
 ok('done/error/paused/remaining互斥',r.body.done===1&&r.body.error===1&&r.body.paused===1&&r.body.remaining===88,r.body);
 ok('华东待确认累计2',r.body.queue.pending===2,r.body.queue);
 ok('华东今日新增待确认1',r.body.queue.todayPending===1,r.body.queue);
 ok('华东待同步1',r.body.outboxPending===1,r.body.outboxItems);
 ok('四态之和等于总数',r.body.done+r.body.error+r.body.paused+r.body.remaining===r.body.total,r.body);

 r=await invoke(app,'GET','/api/crawl/source-health?batch=%E5%85%A8%E5%9B%BD%E4%B8%93%E9%A1%B9');
 ok('全国专项来源健康可见',r.body.totalSources===1&&r.body.items[0].region==='全国',r.body);

 r=await invoke(app,'GET','/api/crawl/crawled-pending?batch=%E5%8D%8E%E4%B8%9C');
 ok('待审批按批次过滤',r.body.items.length===2&&r.body.items.every(x=>x.province==='上海'),r.body);
 r=await invoke(app,'GET','/api/crawl/crawled-pending',{user:null});
 ok('待审批读接口要求登录',r.statusCode===401,r.body);
 r=await invoke(app,'POST','/api/crawl/compare',{body:{keyword:'最低工资',region:'上海'},user:null});
 ok('在线采集接口要求登录',r.statusCode===401,r.body);

 r=await invoke(app,'POST','/api/crawl/item-update',{body:{recordId:'sh1',updates:{region:'火星'}}});
 ok('非法地区被后端拒绝',r.statusCode===400,r.body);
 r=await invoke(app,'POST','/api/crawl/item-update',{body:{recordId:'sh1',updates:{region:'江苏省',category:'最低工资',releaseDate:today,note:'人工修正'}}});
 ok('标准地区别名归一化',r.body.success&&r.body.item.region==='江苏',r.body);
 // restore to 上海 for remaining tests
 await invoke(app,'POST','/api/crawl/item-update',{body:{recordId:'sh1',updates:{region:'上海'}}});

 // AI daily: one today, one yesterday, one duplicate canonical URL
 const originalCrawl=crawler.crawlPolicies;
 crawler.crawlPolicies=async()=>[
  {title:'上海市最低工资标准最新调整通知',url:'https://www.shanghai.gov.cn/ai-new?utm_source=x',region:'上海',category:'最低工资',releaseDate:today,summary:'最低工资标准调整'},
  {title:'上海市最低工资标准历史调整通知',url:'https://www.shanghai.gov.cn/ai-old',region:'上海',category:'最低工资',releaseDate:yesterday,summary:'历史政策'},
  {title:'上海市最低工资标准调整通知',url:'https://www.shanghai.gov.cn/x1?utm_source=dup',region:'上海',category:'最低工资',releaseDate:today,summary:'重复政策'},
 ];
 r=await invoke(app,'POST','/api/crawl/ai-expand',{body:{keyword:'最低工资',region:'上海',mode:'daily',count:5}});
 ok('AI今日增量过滤历史日期',r.body.dateFiltered===1,r.body);
 ok('AI统一URL规范化去重',r.body.duplicates===1,r.body);
 ok('AI今日新政策真实入池',r.body.addedToQueue===1&&db.getDb().crawlQueue.some(x=>x.url==='https://www.shanghai.gov.cn/ai-new'&&x.status==='pending'),r.body);
 crawler.crawlPolicies=originalCrawl;

 // confirm + outbox
 batchCreateMode='ok';
 r=await invoke(app,'POST','/api/crawl/confirm',{body:{recordId:'sh1'}});
 ok('单条审批写入成功',r.body.success&&!r.body.pendingSync,r.body);
 const d=db.getDb(); d.crawlQueue.push({id:'sh2',title:'上海最低工资标准通知2',url:'https://www.shanghai.gov.cn/x3',region:'上海',category:'最低工资',releaseDate:today,status:'pending',quality:'pass'}); db.save();
 batchCreateMode='403';
 r=await invoke(app,'POST','/api/crawl/confirm',{body:{recordId:'sh2'}});
 ok('飞书403进入待同步',r.statusCode===201&&r.body.pendingSync===true,r.body);
 ok('outbox真实新增',db.getDb().syncOutbox.some(x=>x.sourceItemId==='sh2'&&!x.synced),db.getDb().syncOutbox);

 // ignore reason persistence
 const d2=db.getDb(); d2.crawlQueue.push({id:'sus1',title:'上海某采购公示',url:'https://www.shanghai.gov.cn/sus',region:'上海',category:'最低工资',releaseDate:today,status:'pending',quality:'suspect'}); db.save();
 r=await invoke(app,'POST','/api/crawl/ignore',{body:{recordId:'sus1',reason:'事务性公告'}});
 ok('忽略原因持久化',r.body.success&&db.getDb().crawlQueue.find(x=>x.id==='sus1').ignoreReason==='事务性公告',r.body);

 // comparison unavailable surfaced
 compareAvailable=false;
 r=await invoke(app,'GET','/api/crawl/crawled-pending?batch=%E5%8D%8E%E4%B8%9C');
 ok('飞书比对故障显式返回不可用状态',r.body.comparisonAvailable===false&&r.body.stats.unknown>0,r.body);

 console.log(out.join('\n'));
 console.log(`\nADMIN_FUNCTIONAL_PASS=${out.length}`);
})().catch(e=>{console.error(e.stack);process.exit(1)});
