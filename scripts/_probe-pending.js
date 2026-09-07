const http = require('http');

class AuthError extends Error { constructor(m) { super(m); this.name = 'AuthError'; } }

async function api(url) {
  const fullUrl = url.startsWith('http') ? url : 'http://localhost:4201' + url;
  return new Promise((resolve, reject) => {
    http.get(fullUrl, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 401) { reject(new AuthError('401')); return; }
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('JSON: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const S = { items: [], filter: 'todo' };

async function loadMatrix() {
  if (!S.me) { console.log('loadMatrix: needAuth=false, returning'); return undefined; }
  const m = await api('/api/crawl/matrix-status');
  console.log('loadMatrix: OK');
  return m;
}

async function loadList() {
  try {
    const d = await api('/api/crawl/crawled-pending');
    console.log('loadList: API total=', d.total, 'items_len=', d.items?.length);
    S.items = (d.items || []).slice().reverse();
    console.log('loadList: S.items set to', S.items.length);
    renderStats(d.stats || {});
    renderList();
  } catch (e) {
    console.log('loadList ERROR:', e.message);
  }
}

function renderStats(st) { console.log('renderStats:', JSON.stringify(st)); }
function visibleItems() {
  const f = S.filter;
  if (f === 'all') return S.items;
  if (f === 'exists') return S.items.filter(i => i.comparisonResult === 'exists');
  return S.items.filter(i => i.comparisonResult !== 'exists');
}
function countBy(f) {
  if (f === 'all') return S.items.length;
  if (f === 'exists') return S.items.filter(i => i.comparisonResult === 'exists').length;
  return S.items.filter(i => i.comparisonResult !== 'exists').length;
}
function renderTabs() {
  const todoN = countBy('todo');
  console.log('renderTabs: tbTodo=' + todoN);
}
function renderList() {
  console.log('renderList: S.items.length=' + S.items.length);
  if (!S.items.length) { console.log('EMPTY branch'); renderTabs(); return; }
  console.log('NORMAL branch, vis=' + visibleItems().length);
  renderTabs();
}

async function boot() {
  try {
    S.me = await api('/api/me');
    console.log('boot: authenticated');
  } catch (e) {
    S.me = null;
    console.log('boot: not authenticated (expected)');
  }
  try {
    await Promise.all([loadMatrix(), loadList()]);
    console.log('boot: settled, items=' + S.items.length);
  } catch (e) {
    console.log('boot: caught', e.message);
    console.log('boot: items after catch=' + S.items.length);
  }
}
boot();
