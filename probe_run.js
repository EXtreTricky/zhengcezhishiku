const http = require('http');

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({
      host: 'localhost', port: 4201, path, method, headers,
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        setCookie: res.headers['set-cookie'],
        body: b
      }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // POST login
  const lg = await req('POST', '/auth/login', null, '');
  console.log('login status:', lg.statusCode);
  const ck = (lg.setCookie || []).map(c => c.split(';')[0]).join('; ');
  console.log('cookie length:', ck.length);

  // GET matrix-status
  const m = await req('GET', '/api/crawl/matrix-status', null, ck);
  console.log('matrix-status:', m.statusCode);
  try {
    const j = JSON.parse(m.body);
    console.log('running:', j.running);
    console.log('remaining:', j.remaining);
  } catch(e) {
    console.log('body:', m.body.slice(0, 300));
  }

  // Try starting a new run
  console.log('\n--- trying to start new run ---');
  const r = await req('POST', '/api/crawl/matrix-run', { limit: 2 }, ck);
  console.log('start status:', r.statusCode);
  console.log('body:', r.body.slice(0, 200));
})();
