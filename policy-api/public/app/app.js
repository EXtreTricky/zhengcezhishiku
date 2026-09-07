/* 政策知识库 UI v2 · 总览首页逻辑
   数据源：policy-api 只读接口（直连飞书多维表格）
   浏览数据公开；入库/元数据等需登录的能力自动降级并引导登录 */
'use strict';

const S = {
  page: 1,
  pageSize: 20,
  kw: '',
  region: '',
  status: '',
  category: '',
  total: 0,
  auth: false,
  catMeta: new Map(),   // category -> {label, appToken, tableId, viewId}
  baseOrigin: '',
  lastList: null,       // 最近一次列表数据（细节显示用）
};

const $ = (id) => document.getElementById(id);

/* ── 请求：401 视为「未登录」置 auth=false，不阻断浏览 ── */
async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', headers: opts && opts.body ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  } catch (e) {
    throw new Error('网络错误：' + e.message);
  }
  if (res.status === 401) {
    S.auth = false;
    throw new ApiAuthError((await safeJson(res))?.message || 'unauthorized');
  }
  if (!res.ok) {
    const d = await safeJson(res);
    throw new Error((d && (d.message || d.error)) || `HTTP ${res.status}`);
  }
  return res.json();
}
class ApiAuthError extends Error {}
async function safeJson(res) { try { return await res.json(); } catch (_) { return null; } }

/* ── 工具 ── */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function short(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function isUrl(s) { return typeof s === 'string' && /^https?:\/\//i.test(s.trim()); }
const CAT_COLORS = ['', 'g', 'v', 'a'];
function catColorClass(name) {
  if (!name) return '';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CAT_COLORS[h % CAT_COLORS.length] || '';
}
function catLabel(cat) {
  const meta = S.catMeta.get(cat);
  return meta && meta.label ? meta.label : cat;
}
function statusTag(st, clsFor) {
  const s = String(st == null ? '' : st);
  if (!s) return '<span class="tag gray"><i></i>未明确</span>';
  if (s.includes('失效')) return `<span class="tag err"><i></i>${esc(s)}</span>`;
  if (s.includes('有效')) return `<span class="tag ok"><i></i>${esc(s)}</span>`;
  return `<span class="tag gray"><i></i>${esc(s)}</span>`;
}

/* ── 主题 ── */
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  try { localStorage.setItem('pk-theme', cur); } catch (_) {}
}

/* ── 初始化 ── */
function bindEvents() {
  $('btnTheme').onclick = toggleTheme;
  $('btnClose').onclick = closeDrawer;
  $('drawerMask').onclick = closeDrawer;
  $('kwTop').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      S.page = 1;
      S.kw = $('kwTop').value.trim();
      loadList();
      const br = document.querySelector('.browse');
      if (br) br.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelector('.browse').classList.add('flash');
      setTimeout(() => document.querySelector('.browse').classList.remove('flash'), 900);
    }
  });
  $('selRegion').onchange = () => { S.page = 1; S.region = $('selRegion').value; loadList(); };
  $('selStatus').onchange = () => { S.page = 1; S.status = $('selStatus').value; loadList(); };
  $('btnReset').onclick = resetFilters;
  $('btnEmptyReset').onclick = resetFilters;
  $('loginBarClose').onclick = () => $('loginBar').classList.add('hidden');
  $('btnPrev').onclick = () => { if (S.page > 1) { S.page--; loadList(); } };
  $('btnNext').onclick = () => {
    const pages = Math.max(1, Math.ceil(S.total / S.pageSize));
    if (S.page < pages) { S.page++; loadList(); }
  };
}

async function boot() {
  bindEvents();
  try {
    const me = await api('/api/me');
    S.auth = !!(me && me.authenticated);
    if (S.auth) renderWho(me);
  } catch (e) {
    S.auth = false;
    if (!(e instanceof ApiAuthError)) setConn(false, '服务未连接');
  }
  if (!S.auth) {
    $('loginBar').classList.remove('hidden');
    $('connPill').classList.add('off');
    $('connTxt').textContent = '未登录 · 浏览模式';
  }
  bootstrap();
}

function renderWho(me) {
  const name = (me && (me.name || me.sub)) || '';
  $('whoBox').innerHTML = `<span class="who-name" title="${esc(name)}">${esc(name)}</span>`;
  $('heroSrc').textContent = '已登录 · 可审批入库';
}

/* ── 数据装配 ── */
async function bootstrap() {
  let stats = null;
  try {
    const [s, cats] = await Promise.all([
      api('/api/dashboard/stats'),
      api('/api/policies/categories').catch(() => []),
    ]);
    stats = s;
    const catList = cats && cats.length ? cats : (s.byCategory || []).map((c) => c.name);
    renderKpis(s);
    renderChips(catList, s);
    fillRegions((s.byRegion || []).map((r) => r.name));
    renderBars($('catBars'), s.byCategory || [], '分类分布', true);
    renderBars($('regBars'), s.byRegion || [], '地区分布', true);
    setConn(true, S.auth ? '已连接飞书多维表格' : '已连接 · 浏览模式');
  } catch (e) {
    if (!(e instanceof ApiAuthError)) {
      setConn(false, '数据加载失败');
      $('tbRes').innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
    }
  }

  // 元数据（表结构 / 多维表格定位）—— 需登录，失败自动降级
  try {
    const [{ tables }, { url }] = await Promise.all([
      api('/api/crawl/tables'),
      api('/api/settings/feishu/bitable-url'),
    ]);
    for (const t of tables) S.catMeta.set(t.category, t);
    S.baseOrigin = new URL(url).origin;
    const kt = $('kTables');
    if (tables && tables.length) kt.textContent = tables.length;
    const tag = $('catTotalTag');
    if (tag) tag.textContent = tables.length ? `共 ${tables.length} 类` : tag.textContent;
  } catch (e) { /* 游客：元数据缺失，仅隐藏多维表格深链 */ }

  // 审批队列角标 + 巡检实时进度（登录后增强，游客自动隐藏）
  try {
    const m = await api('/api/crawl/matrix-status');
    S.matrix = m;
    renderLiveRun(m);
    if (m && m.queue) {
      const p = m.queue.pending || 0;
      $('kPending').textContent = p;
      const dot = $('navDot');
      if (p > 0) { dot.textContent = p > 99 ? '99+' : p; dot.classList.remove('hidden'); }
      if (m.outboxPending > 0) $('kPendingFoot').textContent = `审批池 ${p} · 待同步 ${m.outboxPending}`;
    }
    startLivePoll();
  } catch (e) { /* 游客或未启用：维持 stats 口径 */ }

  loadList();
}

/* ── 巡检实时进度（矩阵任务 done/total，6s 轮询）───────────────── */
function startLivePoll() {
  let t = null;
  const tick = async () => {
    try {
      const m = await api('/api/crawl/matrix-status');
      renderLiveRun(m);
    } catch (e) { /* 网络抖动忽略，下轮再试 */ }
  };
  t = setInterval(tick, 6000);
}

function renderLiveRun(m) {
  const box = $('liveRun');
  if (!box) return;
  if (!m || !m.total) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const total = m.total || 1;
  const done = m.done || 0;
  const err = m.error || 0;
  const okPct = Math.round((done / total) * 100);
  const errPct = Math.round((err / total) * 100);
  $('lrPct').textContent = okPct + '%';
  $('lrNums').textContent = `${done} / ${total} 格`;
  $('lrOk').style.width = Math.min(100, okPct) + '%';
  $('lrErr').style.width = Math.min(100, errPct) + '%';
  const running = m.running && m.running.length;
  const stateEl = $('lrState');
  const dotEl = $('lrDot');
  if (running) {
    stateEl.textContent = '巡检运行中… 新命中自动进待审批池';
    stateEl.classList.remove('idle');
    stateEl.classList.add('busy');
    dotEl.classList.add('busy');
  } else {
    stateEl.textContent = total - done > 0 ? `空闲 · 还剩 ${total - done} 格待跑` : '本轮矩阵已全部完成';
    stateEl.classList.remove('busy');
    stateEl.classList.add('idle');
    dotEl.classList.remove('busy');
  }
  $('lrPending').textContent = (m.queue && m.queue.pending) || 0;
  $('lrOutbox').textContent = m.outboxPending || 0;
  const errTxt = $('lrErrTxt');
  if (err > 0 && m.recentErrors && m.recentErrors.length) {
    errTxt.textContent = '· 最近失败: ' + m.recentErrors.map((e) => e.id).join(', ');
    errTxt.classList.remove('hidden');
  } else errTxt.classList.add('hidden');
  const now = new Date();
  $('lrUpdated').textContent = '更新于 ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
}

function setConn(ok, txt) {
  const pill = $('connPill');
  pill.classList.toggle('off', !ok);
  $('connTxt').textContent = txt;
}

/* ── KPI ── */
function renderKpis(s) {
  $('kTotal').textContent = s.totalPolicies ?? 0;
  $('kValid').textContent = s.publishedPolicies ?? 0;
  $('kPending').textContent = s.pendingReviews ?? 0;
  const byCat = s.byCategory || [];
  if (!$('kTables').textContent || $('kTables').textContent === '–') {
    $('kTables').textContent = byCat.length || '–';
  }
  $('catTotalTag').textContent = byCat.length ? `共 ${byCat.length} 类` : '–';
  if (s.source === 'bitable') $('heroSrc').textContent = '直连多维表格 · 5 分钟缓存';
}

/* ── 横向条形图 ── */
function renderBars(box, list, emptyTxt, animate) {
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = `<div class="b-empty">暂无数据</div>`;
    return;
  }
  const max = Math.max(...list.map((x) => x.count), 1);
  box.innerHTML = list
    .map((x, i) => {
      const pct = Math.max(2, Math.round((x.count / max) * 100));
      return `<div class="brow${i === 0 ? ' top' : ''}">
        <span class="bl" title="${esc(x.name)}">${esc(short(x.name, 10))}</span>
        <span class="bt"><i data-w="${pct}"></i></span>
        <span class="bc">${x.count}</span>
      </div>`;
    })
    .join('');
  if (animate) requestAnimationFrame(() => requestAnimationFrame(() => {
    box.querySelectorAll('.bt i').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  }));
}

/* ── 分类 chips ── */
function renderChips(cats, stats) {
  const countOf = new Map((stats.byCategory || []).map((c) => [c.name, c.count]));
  const box = $('chips');
  const mk = (cat, label, n, active) => {
    const b = document.createElement('button');
    b.className = 'chip' + (active ? ' on' : '');
    b.innerHTML = `${esc(label)}${n != null ? `<span class="cn">${n}</span>` : ''}`;
    b.onclick = () => {
      box.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.category = cat;
      S.page = 1;
      loadList();
    };
    return b;
  };
  box.innerHTML = '';
  box.appendChild(mk('', '全部分类', null, !S.category));
  for (const c of cats) {
    const meta = S.catMeta.get(c);
    box.appendChild(mk(c, meta && meta.label ? short(meta.label, 12) : short(c, 12), countOf.get(c), S.category === c));
  }
}

function fillRegions(regions) {
  const sel = $('selRegion');
  sel.innerHTML = '<option value="">全部地区</option>';
  for (const r of regions) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r;
    sel.appendChild(o);
  }
}

/* ── 列表 ── */
async function loadList() {
  const qs = new URLSearchParams({ page: S.page, pageSize: S.pageSize, sortBy: 'releaseDate', sortOrder: 'desc' });
  if (S.kw) qs.set('keyword', S.kw);
  if (S.category) qs.set('category', S.category);
  if (S.region) qs.set('region', S.region);
  if (S.status) qs.set('effectiveness', S.status);

  const tbody = $('tbody');
  $('empty').classList.add('hidden');
  tbody.innerHTML = `<tr><td colspan="7" class="loading-td">加载中…</td></tr>`;
  $('tbRes').innerHTML = '加载中…';
  try {
    const data = await api('/api/policies?' + qs.toString());
    S.total = data.total;
    S.lastList = data;
    renderRows(data.items || []);
    $('tbRes').innerHTML = `共 <b>${data.total}</b> 条${S.kw ? ` · 关键词「<b>${esc(S.kw)}</b>」` : ''}`;
    renderPager(data.total, data.hasMore);
  } catch (e) {
    tbody.innerHTML = '';
    if (!(e instanceof ApiAuthError)) {
      $('empty').classList.remove('hidden');
      $('empty').innerHTML = `<p>加载失败：${esc(e.message)}</p><button id="btnEmptyReset" class="btn btn-ghost">重试</button>`;
      $('btnEmptyReset').onclick = resetFilters;
    }
    renderPager(0, false);
  }
}

function renderRows(items) {
  const tbody = $('tbody');
  if (!items.length) {
    tbody.innerHTML = '';
    $('empty').classList.remove('hidden');
    $('empty').innerHTML = `<p>没有符合条件的政策</p><button id="btnEmptyReset" class="btn btn-ghost">清空筛选</button>`;
    $('btnEmptyReset').onclick = resetFilters;
    return;
  }
  tbody.innerHTML = items.map((r) => {
    const cat = r.topicCategory || r.policyType || '';
    const date = r.effectiveDate || r.releaseDate || '';
    const cc = catColorClass(cat);
    return `<tr data-id="${esc(r.id)}">
      <td>
        <div class="tt">
          <span class="tb-icon ${cc}">${esc((catLabel(cat) || '政').slice(0, 1))}</span>
          <div class="tt-main">
            <div class="tt-title" title="${esc(r.title)}">${esc(r.title)}</div>
            ${r.summary ? `<div class="tt-sub">${esc(short(r.summary, 90))}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="tcell">${cat ? `<span class="chip" title="${esc(cat)}">${esc(short(catLabel(cat), 9))}</span>` : '<span style="color:var(--ink-4)">–</span>'}</td>
      <td class="tcell">${r.applicableRegion ? `<span class="region"><i></i>${esc(r.applicableRegion)}</span>` : '<span style="color:var(--ink-4)">–</span>'}</td>
      <td><div class="t-cell-doc">${esc(r.issuingAuthority ? short(r.issuingAuthority, 22) : '–')}${r.documentNumber ? `<small>${esc(short(r.documentNumber, 26))}</small>` : ''}</div></td>
      <td class="t-time">${esc(date || '–')}</td>
      <td class="tcell">${statusTag(r.effectivenessStatus)}</td>
      <td><span class="rowact">详情<svg><use href="#i-arrow"/></svg></span></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.onclick = () => openDetail(tr.dataset.id);
  });
}

function renderPager(total, hasMore) {
  const pages = Math.max(1, Math.ceil(total / S.pageSize));
  $('btnPrev').disabled = S.page <= 1;
  $('btnNext').disabled = !hasMore;
  $('pageInfo').textContent = total ? `第 ${S.page} / ${pages} 页 · ${total} 条` : '';
}

function resetFilters() {
  S.kw = '';
  S.region = '';
  S.status = '';
  S.category = '';
  S.page = 1;
  $('kwTop').value = '';
  $('selRegion').value = '';
  $('selStatus').value = '';
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x.textContent.includes('全部分类')));
  loadList();
}

/* ── 详情抽屉 ── */
async function openDetail(id) {
  const drawer = $('drawer');
  const mask = $('drawerMask');
  try {
    const d = await api('/api/policies/' + encodeURIComponent(id));
    const cat = d.topicCategory || d.policyType || '政策';
    $('dCat').textContent = catLabel(cat);
    $('dCat').className = 'tag brand';
    const st = String(d.effectivenessStatus || '');
    const stEl = $('dStatus');
    stEl.className = 'tag ' + (st.includes('失效') ? 'err' : st.includes('有效') ? 'ok' : 'gray');
    stEl.innerHTML = `<i></i>${esc(st || '未明确')}`;
    $('dTitle').textContent = d.title || '–';

    const bits = [];
    if (d.issuingAuthority) bits.push([d.issuingAuthority, '']);
    if (d.applicableRegion) bits.push([d.applicableRegion, '']);
    const dates = [d.effectiveDate && `生效 ${d.effectiveDate}`, d.releaseDate && `发布 ${d.releaseDate}`].filter(Boolean).join(' · ');
    if (dates) bits.push([dates, '']);
    if (d.documentNumber) bits.push([`文号 ${d.documentNumber}`, '']);
    $('dwMeta').innerHTML = bits.map(([b]) => `<span class="mbit">${esc(b)}</span>`).join('');

    const srcA = $('dSourceUrl');
    if (d.sourceUrl && isUrl(d.sourceUrl)) {
      srcA.href = d.sourceUrl;
      srcA.classList.remove('hidden');
    } else srcA.classList.add('hidden');

    const fsA = $('dOpenFeishu');
    const meta = S.catMeta.get(cat) || S.catMeta.get(d.topicCategory) || S.catMeta.get(d.policyType);
    if (meta && S.baseOrigin) {
      fsA.href = `${S.baseOrigin}/base/${meta.appToken}?table=${meta.tableId}${meta.viewId ? '&view=' + meta.viewId : ''}`;
      fsA.classList.remove('hidden');
    } else fsA.classList.add('hidden');

    const src = d.sourceFields || {};
    const entries = Object.entries(src).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
    const fkv = $('dFields');
    fkv.innerHTML = entries.length
      ? entries.map(([k, v]) => {
          const txt = String(v);
          const val = isUrl(txt)
            ? `<a href="${esc(txt)}" target="_blank" rel="noopener">${esc(short(txt, 90))}</a>`
            : esc(short(txt, 600));
          return `<dt>${esc(k)}</dt><dd>${val}</dd>`;
        }).join('')
      : '<dt>–</dt><dd>无明细字段</dd>';

    const cTitle = $('dContentTitle');
    const cBox = $('dContent');
    const hasContent = d.content && d.content.trim();
    cTitle.classList.toggle('hidden', !hasContent);
    cBox.textContent = hasContent ? d.content : '';

    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    mask.classList.add('on');
  } catch (e) {
    alert('加载详情失败：' + e.message);
  }
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('drawerMask').classList.remove('on');
}

document.addEventListener('DOMContentLoaded', boot);
