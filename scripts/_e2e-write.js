'use strict';
const BASE = 'http://127.0.0.1:4100';
let cookie = '';
async function req(method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
(async () => {
  await req('GET', '/auth/login');
  console.log('login cookie ok:', !!cookie);
  const list = await req('GET', '/api/policies?pageSize=1');
  const pid = list.data.items[0].id;
  console.log('pid:', pid);

  const created = await req('POST', '/api/reviews', { policyId: pid, reviewType: 'manual_review' });
  console.log('POST /reviews ->', created.status, '| id:', created.data.id, '| status:', created.data.status,
    '| machineScore:', created.data.machineReport && created.data.machineReport.confidenceScore,
    '| missing:', (created.data.machineReport && created.data.machineReport.missingFields.join(',') ) || '(none)');
  const rid = created.data.id;

  const dup = await req('POST', '/api/reviews', { policyId: pid });
  console.log('dup review ->', dup.status, '(expect 409)');

  const started = await req('POST', '/api/reviews/' + rid + '/start');
  console.log('start ->', started.status, started.data.status);

  const done = await req('POST', '/api/reviews/' + rid + '/approve', { comment: '经与官方公告核对，数据无误，通过' });
  console.log('approve ->', done.status, '|', done.data.status, '| result:', done.data.reviewResult, '| comment:', done.data.reviewerComment);

  const again = await req('POST', '/api/reviews/' + rid + '/start');
  console.log('restart after terminal ->', again.status, '(expect 409)');

  const stats = await req('GET', '/api/dashboard/stats');
  console.log('stats.pendingReviews:', stats.data.pendingReviews, '(expect 0)');

  const rvList = await req('GET', '/api/reviews?pageSize=5');
  console.log('reviews total:', rvList.data.total, '| first policyTitle:', (rvList.data.items[0] && rvList.data.items[0].policyTitle || '').slice(0, 30));

  const cal = await req('GET', '/api/calendar/events?year=2026');
  const sample = cal.data[0];
  console.log('calendar 2026 events:', cal.data.length, '| sample:', sample ? sample.id + ' | ' + sample.title.slice(0, 36) + ' | ' + sample.date : '(empty)');

  const s1 = await req('POST', '/api/subscriptions', { subType: 'category', subValue: '最低工资', subLabel: '最低工资', pushFrequency: 'weekly' });
  console.log('POST /api/subscriptions ->', s1.status, s1.data.id);
  const sid = s1.data.id;
  const dupSub = await req('POST', '/api/subscriptions', { subType: 'category', subValue: '最低工资' });
  console.log('dup subscription ->', dupSub.status, '(expect 409)');
  const my = await req('GET', '/api/subscriptions');
  console.log('my subscriptions:', my.data.length);
  const upd = await req('PATCH', '/api/subscriptions/' + sid, { pushFrequency: 'monthly', isActive: true });
  console.log('PATCH sub ->', upd.status, upd.data.pushFrequency);
  const del = await req('DELETE', '/api/subscriptions/' + sid);
  console.log('DELETE sub ->', del.status, del.data.success);
})();
