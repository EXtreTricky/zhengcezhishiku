'use strict';
const STATUS = { HEALTHY:'healthy', DEGRADED:'degraded', STALE:'stale', SUSPICIOUS:'suspicious', DOWN:'down' };
function ageDays(iso, now=Date.now()) { const t=Date.parse(iso||''); return Number.isFinite(t) ? Math.max(0,(now-t)/86400000) : Infinity; }
function evaluateSourceHealth(source, t={}, now=Date.now()) {
  const expected=Math.max(1,source.expectedUpdateDays||source.expected_update_days||7);
  const eps=t.endpoints||[]; const ok=eps.filter(x=>x.lastHttpOk===true||x.last_http_ok===true); const bad=eps.filter(x=>x.lastHttpOk===false||x.last_http_ok===false);
  if (eps.length && ok.length===0) return {status:STATUS.DOWN,reason:'no_successful_endpoint'};
  const p=Date.parse(t.latestPrimaryPublishedAt||t.latest_primary_published_at||'');
  const s=Date.parse(t.latestSecondaryPublishedAt||t.latest_secondary_published_at||'');
  if (Number.isFinite(p)&&Number.isFinite(s)&&s-p>86400000) return {status:STATUS.SUSPICIOUS,reason:'secondary_newer_than_primary'};
  if ((t.consecutiveZeroNewRuns||t.consecutive_zero_new_runs||0)>=3 && ageDays(t.lastDiscoveredAt||t.last_discovered_at,now)>expected)
    return {status:STATUS.SUSPICIOUS,reason:'abnormal_zero_updates'};
  const primaryIso=t.latestPrimaryPublishedAt||t.latest_primary_published_at||'';
  if (primaryIso && ageDays(primaryIso,now)>expected*3)
    return {status:STATUS.STALE,reason:'primary_content_stale'};
  if (bad.length) return {status:STATUS.DEGRADED,reason:'partial_endpoint_failure'};
  return {status:STATUS.HEALTHY,reason:'ok'};
}
function buildCompensationPlan(source,h) {
  const out=[]; const add=(mode,priority,lookbackDays=60)=>out.push({sourceId:source.id||source.key||source.name,region:source.key||source.region||source.name,mode,priority,lookbackDays});
  if (!h || h.status==='healthy') return out;
  if (h.reason==='partial_endpoint_failure') { add('endpoint-retry',90,14); add('alternate-entrypoint',80,30); }
  if (h.reason==='secondary_newer_than_primary') { add('category-recheck',100,60); add('pagination-backtrack',95,90); add('site-search-fallback',90,90); }
  if (h.reason==='abnormal_zero_updates') { add('primary-recheck',100,45); add('normative-library-recheck',95,90); add('gazette-recheck',95,90); add('site-search-fallback',90,90); }
  if (h.status==='stale') { add('rediscover-entrypoints',100,60); add('pagination-backtrack',95,120); }
  if (h.status==='down') { add('rediscover-entrypoints',100,60); add('site-search-fallback',95,120); }
  const uniq=new Map(); for(const j of out){const old=uniq.get(j.mode); if(!old||old.priority<j.priority)uniq.set(j.mode,j);} return [...uniq.values()].sort((a,b)=>b.priority-a.priority);
}
function recoverExpiredCompensations(queue, now=Date.now(), leaseMs=30*60*1000) {
  let recovered=0;
  for (const item of Array.isArray(queue) ? queue : []) {
    if (item.status !== 'running') continue;
    const started=Date.parse(item.lastRunAt || item.startedAt || '');
    if (Number.isFinite(started) && now-started <= leaseMs) continue;
    item.status='retry';
    item.nextRunAt=new Date(now).toISOString();
    item.lastError=item.lastError || '上次补偿进程未正常结束，已自动恢复';
    delete item.runId;
    delete item.pid;
    recovered += 1;
  }
  return recovered;
}
module.exports={STATUS,evaluateSourceHealth,buildCompensationPlan,recoverExpiredCompensations,ageDays};
