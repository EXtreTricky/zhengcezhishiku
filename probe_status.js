const http = require('http');
const https = require('https');

function req(path, method, ck, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: 'localhost', port: 4201, path,
      method: method || 'GET',
      headers: Object.assign({ Cookie: ck || '' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ code: x.statusCode, body: b })); });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // login
  const lg = await req('/auth/login');
  console.log('login:', lg.code);
  const ck = (lg.setCookie || []).map(c => c.split(';')[0]).join('; ');
  console.log('cookie_len:', ck.length);

  // matrix-status
  const m = await req('/api/crawl/matrix-status', 'GET', ck);
  console.log('\n=== matrix-status ===');
  console.log('status:', m.code);
  try {
    const j = JSON.parse(m.body);
    console.log('running:', JSON.stringify(j.running));
    console.log('remaining:', j.remaining);
  } catch(e) {
    console.log('body:', m.body.slice(0, 300));
  }

  // try new run
  console.log('\n=== trying new matrix-run ===');
  const r = await req('/api/crawl/matrix-run', 'POST', ck, { limit: 2 });
  console.log('status:', r.code);
  console.log('body:', r.body.slice(0, 200));
})();
