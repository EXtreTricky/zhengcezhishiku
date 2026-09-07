'use strict';
/* 政策采集审批工作台 UI v2 —— 行级审批入库（/admin/）
   数据直连同源 /api/crawl/* ；本地 MOCK 登录态与飞书 OAuth 均可用 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const S = {
  me: null,
  matrix: null,
  items: [],
  activeId: null,
  preview: null,
  edits: {},
  runBusy: false,
  confirmBusy: false,
  filter: 'todo',       // todo(new+needs_update) / exists / all
  checked: new Set(),   // 勾选的 bitableRecordId
};

const KIND_LABEL = { date: '日期', number: '数字', url: '链接', select: '单选', multiselect: '多选', text: '文本' };
const STATUS_LABEL = { new: '新发现', exists: '库中已有', needs_update: '需更新' };
const STATUS_CLS = { new: 'chip ok', exists: 'chip info', needs_update: 'chip warn' };
const REGION_LIST = ['全国', '北京', '上海', '广东', '江苏', '浙江', '山东', '四川', '湖北', '河南', '福建', '湖南', '河北', '天津', '重庆'];
const CATEGORY_LIST = ['最低工资', '平均工资', '公积金', '年金', '大病医疗', '高温津贴', '残疾职工', '婚育相关', '病假工资'];

/* ── 请求封装 ─────────────────────────────── */
async function api(url, opt = {}) {
  let res;
  try {
    res = await fetch(url, {
      credentials: 'same-origin',
      headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
      ...opt,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
  } catch (e) {
    throw new Error('网络错误：' + e.message);
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401) throw new AuthError((data && data.message) || '未登录');
    throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  }
  return data;
}
class AuthError extends Error {}

function showLoginBanner() { $('#login-banner').classList.remove('hidden'); }
function needAuth() {
  if (S.me) return true;
  showLoginBanner();
  return false;
}

/* ── 主题 ── */
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  try { localStorage.setItem('pk-theme', cur); } catch (_) {}
}

/* ── 登录态 ── */
async function boot() {
  $('#btnTheme').addEventListener('click', toggleTheme);
  try {
    S.me = await api('/api/me');
  } catch (e) {
    S.me = null;
  }
  // MOCK 模式且未登录 → 自动走 /auth/login 拿模拟 cookie（免手动点登录）
  if (!S.me || !S.me.authenticated) {
    if (S.me && S.me.mock) {
      location.assign('/auth/login');
      return;
    }
    S.me = null;
    showLoginBanner();
    return;
  }
  $('#who').textContent = S.me.name || S.me.sub || '';
  try {
    await Promise.all([loadMatrix(), loadList()]);
  } catch (e) {
    if (e instanceof AuthError) showLoginBanner();
    else console.error(e);
  }
}

/* ── 引擎徽章 ── */
function setEngineBadge(llmEnabled) {
  const b = $('#llm-badge');
  if (llmEnabled) {
    b.className = 'pill mode-on';
    $('#llm-txt').textContent = 'LLM 精提取已启用';
  } else {
    b.className = 'pill mode-off';
    $('#llm-txt').textContent = '本地规则模式';
  }
}

/* ── 概览 + 一键巡检 ─────────────────────── */
async function loadMatrix() {
  if (!needAuth()) return;
  try {
    const m = await api('/api/crawl/matrix-status');
    S.matrix = m;
    $('#m-total').textContent = m.total;
    $('#m-done').textContent = m.done;
    $('#m-err').textContent = m.error;
    $('#m-rest').textContent = m.remaining;
    // 分段进度条：完成(绿) + 失败(红) + 待跑(蓝)
    const total = m.total || 1;
    const pct = (n) => Math.max(0, Math.min(100, Math.round((n / total) * 100)));
    $('#pOk').style.width = pct(m.done) + '%';
    $('#pErr').style.width = pct(m.error) + '%';
    $('#pGo').style.width = pct(m.remaining) + '%';
    $('#m-pending').textContent = m.queue.pending;
    $('#m-outbox').textContent = m.outboxPending;
    const dot = $('#navDot');
    const pend = m.queue.pending || 0;
    if (pend > 0) { dot.textContent = pend > 99 ? '99+' : pend; dot.classList.remove('hidden'); }
    else dot.classList.add('hidden');
    setEngineBadge(!!m.llmEnabled);
    const errDetail = $('#m-err-detail');
    if (m.error && m.recentErrors && m.recentErrors.length) {
      errDetail.classList.remove('hidden');
      errDetail.textContent = '最近失败: ' + m.recentErrors.map((e) => e.id + ' → ' + (e.error || '')).join('；');
    } else errDetail.classList.add('hidden');
    if (m.running && m.running.length) {
      $('#run-state').textContent = '运行中…';
      $('#btn-run').disabled = true;
    }
    // 填充定向下拉（首次）
    if ($('#run-region').options.length === 1) {
      for (const r of REGION_LIST) $('#run-region').add(new Option(r, r));
      for (const c of CATEGORY_LIST) $('#run-category').add(new Option(c, c));
    }
  } catch (e) {
    if (!(e instanceof AuthError)) console.error('matrix-status 失败', e);
  }
}

async function startRun() {
  if (S.runBusy || !needAuth()) return;
  const limitSel = $('#run-limit');
  const region = $('#run-region').value;
  const category = $('#run-category').value;
  const body = {};
  if (limitSel.value === '99999') body.all = true;
  else body.limit = Number(limitSel.value);
  if (region) body.region = region;
  if (category) body.category = category;

  S.runBusy = true;
  $('#btn-run').disabled = true;
  $('#run-state').textContent = '启动中…';
  const logEl = $('#run-log');
  logEl.classList.remove('hidden');
  logEl.textContent = '';
  try {
    const r = await api('/api/crawl/matrix-run', { method: 'POST', body });
    pollRun(r.runId);
  } catch (e) {
    $('#run-state').textContent = e.message;
    logEl.textContent = '启动失败：' + e.message;
    S.runBusy = false;
    $('#btn-run').disabled = false;
    if (e instanceof AuthError) showLoginBanner();
  }
}

function pollRun(runId) {
  $('#run-state').textContent = '运行中…（每批约 1–3 分钟，可离开稍后刷新）';
  let timer = setInterval(async () => {
    try {
      const r = await api('/api/crawl/matrix-run/' + runId);
      const logEl = $('#run-log');
      logEl.textContent = (r.log || []).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
      if (r.state !== 'running') {
        clearInterval(timer);
        S.runBusy = false;
        $('#btn-run').disabled = false;
        const res = r.result || {};
        if (res.ok) {
          $('#run-state').textContent = `✓ 完成：命中 ${res.hits ?? 0}，新入池 ${res.added ?? 0}，失败 ${res.failed ?? 0}，剩 ${res.remaining ?? '?'}`;
        } else {
          $('#run-state').textContent = '✗ ' + (res.error || '未知错误');
        }
        await Promise.all([loadMatrix(), loadList()]);
      }
    } catch (e) {
      clearInterval(timer);
      S.runBusy = false;
      $('#btn-run').disabled = false;
      $('#run-state').textContent = '轮询失败：' + e.message;
      if (e instanceof AuthError) showLoginBanner();
    }
  }, 1500);
}

/* ── 待审批列表 ───────────────────────────── */
async function loadList() {
  try {
    const d = await api('/api/crawl/crawled-pending');
    S.items = (d.items || []).slice().reverse(); // 新的在前
    renderStats(d.stats || {});
    renderList();
  } catch (e) {
    if (!(e instanceof AuthError)) console.error('crawled-pending 失败', e);
  }
}

function renderStats(st) {
  const wrap = $('#list-stats');
  const suspect = st.suspect || 0;
  const clean = Math.max(0, (st.new || 0) + (st.needs_update || 0) - suspect);
  wrap.innerHTML =
    (clean ? `<b class="c-new">可入库 ${clean}</b>` : '') +
    (suspect ? `<b class="c-suspect">存疑 ${suspect}</b>` : '') +
    (st.exists ? `<b class="c-exists">已有 ${st.exists}</b>` : '');
}

function renderList() {
  const box = $('#list');
  const empty = $('#list-empty');
  if (!S.items.length) {
    box.innerHTML = '';
    empty.classList.remove('hidden');
    renderTabs();
    $('#batchbar').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  const vis = visibleItems();
  // 清理已不存在的勾选
  S.checked = new Set([...S.checked].filter((id) => vis.some((v) => v.bitableRecordId === id)));
  box.innerHTML = vis
    .map((it) => {
      const st = STATUS_LABEL[it.comparisonResult] || it.comparisonResult;
      const stCls = STATUS_CLS[it.comparisonResult] || 'chip gray';
      const date = it.publishDate ? String(it.publishDate).slice(0, 10) : '';
      const urlHost = hostOf(it.officialUrl);
      const qTip = esc((it.qualityReasons || []).join('；'));
      return `<div class="a-item${S.activeId === it.bitableRecordId ? ' on' : ''}" data-id="${esc(it.bitableRecordId)}">
        <label class="cbx" title="勾选后可批量入库/忽略"><input type="checkbox" class="ck" data-id="${esc(it.bitableRecordId)}" /></label>
        <div class="ai-body">
          <div class="ai-top">
            <span class="ai-title" title="${esc(it.title || '')}${qTip ? '\n\n⚠ ' + qTip : ''}">${esc(it.title || '(无标题)')}</span>
            <span class="ai-more"><svg><use href="#i-arrow"/></svg></span>
          </div>
          <div class="ai-foot">
            ${it.province ? `<span class="chip chip-region">${esc(it.province)}</span>` : ''}
            <span class="${stCls}">${esc(st)}</span>
            ${it.policyDomain ? `<span class="chip gray">${esc(it.policyDomain)}</span>` : ''}
            ${isSuspect(it) ? `<span class="chip chip-suspect" title="${qTip}">存疑</span>` : ''}
            ${date ? `<span class="chip chip-date">${esc(date)}</span>` : ''}
            ${urlHost ? `<span class="ai-url" title="${esc(it.officialUrl || '')}">${esc(urlHost)}</span>` : ''}
          </div>
        </div>
      </div>`;
    })
    .join('');
  // 同步勾选态
  vis.forEach((it) => {
    const cb = box.querySelector(`.ck[data-id="${CSS.escape(it.bitableRecordId)}"]`);
    if (cb) cb.checked = S.checked.has(it.bitableRecordId);
  });
  box.onclick = (ev) => {
    const cb = ev.target.closest('.ck');
    if (cb) {
      ev.stopPropagation();
      const id = cb.dataset.id;
      if (cb.checked) S.checked.add(id);
      else S.checked.delete(id);
      renderBatchBar();
      return;
    }
    const itemEl = ev.target.closest('.a-item');
    if (!itemEl) return;
    selectItem(itemEl.dataset.id);
  };
  renderTabs();
  renderBatchBar();
}

/* ── 分组过滤 + 批量操作 ─────────────────── */
const isSuspect = (i) => i.quality === 'suspect';
function visibleItems() {
  const f = S.filter;
  if (f === 'all') return S.items;
  if (f === 'suspect') return S.items.filter((i) => isSuspect(i));
  if (f === 'exists') return S.items.filter((i) => i.comparisonResult === 'exists');
  return S.items.filter((i) => i.comparisonResult !== 'exists' && !isSuspect(i)); // todo: new + needs_update（排除存疑）
}
function countBy(f) {
  if (f === 'all') return S.items.length;
  if (f === 'suspect') return S.items.filter((i) => isSuspect(i)).length;
  if (f === 'exists') return S.items.filter((i) => i.comparisonResult === 'exists').length;
  return S.items.filter((i) => i.comparisonResult !== 'exists' && !isSuspect(i)).length;
}
function renderTabs() {
  const todoN = countBy('todo');
  const suspectN = countBy('suspect');
  const existsN = countBy('exists');
  const allN = countBy('all');
  // 直接通过 document.querySelector 设置，确保更新生效
  const tb = document.querySelector('#tbTodo');
  const ts = document.querySelector('#tbSuspect');
  const te = document.querySelector('#tbExists');
  const ta = document.querySelector('#tbAll');
  if (tb) tb.textContent = todoN;
  if (ts) ts.textContent = suspectN;
  if (te) te.textContent = existsN;
  if (ta) ta.textContent = allN;
  // bug 修复：$ 是 querySelector，必须带 #，否则查 <tbTodo> 返回 null
  $('#tbTodo').textContent = todoN;
  $('#tbSuspect').textContent = suspectN;
  $('#tbExists').textContent = existsN;
  $('#tbAll').textContent = allN;
  const trustBtn = $('#btnTrustTodo');
  const trustN = $('#trustN');
  if (trustBtn) trustBtn.disabled = todoN === 0;
  if (trustN) trustN.textContent = todoN ? `（${todoN} 条）` : '';
  // 「忽略全部存疑」按钮：当前过滤视图是存疑且无勾选时可用
  const ignSuspect = $('#btnIgnoreSuspect');
  if (ignSuspect) ignSuspect.disabled = suspectN === 0;
}
function renderBatchBar() {
  const n = S.checked.size;
  $('#ckCount').textContent = n ? `${n} 条已选` : '0 条已选';
  $('#btnBatchConfirm').disabled = n === 0;
  $('#btnBatchIgnore').disabled = n === 0;
  const bar = $('#batchbar');
  bar.classList.toggle('hidden', !S.items.length);
  if (S.items.length) {
    const vis = visibleItems();
    $('#ckAll').checked = vis.length > 0 && S.checked.size === vis.length;
  }
}

async function runSeq(ids, label, fn) {
  const msg = $('#batchMsg');
  msg.className = 'batchmsg';
  msg.classList.remove('hidden');
  let ok = 0, fail = 0, sync = 0, broke = false;
  for (let i = 0; i < ids.length; i++) {
    msg.textContent = `${label}中 ${i + 1} / ${ids.length}…`;
    try {
      const r = await fn(ids[i]);
      if (r && r.pendingSync) sync++;
      else ok++;
    } catch (e) {
      if (e instanceof AuthError) { showLoginBanner(); broke = true; break; }
      fail++;
    }
  }
  S.checked = new Set();
  if (!broke) await Promise.all([loadList(), loadMatrix()]);
  msg.className = 'batchmsg ' + (fail ? 'err' : 'ok');
  const syncTxt = sync ? `，${sync} 条写权限受限进待同步` : '';
  msg.textContent = broke
    ? `✗ ${label}中断（登录态失效）`
    : `✓ ${label}完成：成功 ${ok}，失败 ${fail}${syncTxt}`;
}

async function batchConfirm() {
  const ids = [...S.checked];
  if (!ids.length || !needAuth()) return;
  if (!confirm(`将选中的 ${ids.length} 条直接写入目标专题表？\n跳过逐条核对；无写权限时自动进入待同步队列。`)) return;
  $('#btnBatchConfirm').disabled = true;
  $('#btnBatchIgnore').disabled = true;
  await runSeq(ids, '入库', async (id) => api('/api/crawl/confirm', { method: 'POST', body: { recordId: id } }));
}

async function batchIgnore() {
  const ids = [...S.checked];
  if (!ids.length || !needAuth()) return;
  if (!confirm(`忽略选中的 ${ids.length} 条？将从待办列表移除（不写入任何专题表）。`)) return;
  $('#btnBatchConfirm').disabled = true;
  $('#btnBatchIgnore').disabled = true;
  await runSeq(ids, '忽略', async (id) => api('/api/crawl/ignore', { method: 'POST', body: { recordId: id } }));
}

async function trustAllTodo() {
  const ids = visibleItems().filter((i) => i.comparisonResult !== 'exists').map((i) => i.bitableRecordId);
  if (!ids.length || !needAuth()) return;
  if (!confirm(`跳过逐条核对，直接入库全部「待处理」条目（${ids.length} 条）？\n含新发现与需更新；写权限不足的条目会自动进入待同步队列，可在左侧「待同步」查看。`)) return;
  S.checked = new Set(ids);
  $('#btnBatchConfirm').disabled = true;
  $('#btnBatchIgnore').disabled = true;
  $('#btnTrustTodo').disabled = true;
  await runSeq(ids, '入库', async (id) => api('/api/crawl/confirm', { method: 'POST', body: { recordId: id } }));
}

async function ignoreAllSuspect() {
  const ids = S.items.filter((i) => isSuspect(i)).map((i) => i.bitableRecordId);
  if (!ids.length || !needAuth()) return;
  if (!confirm(`忽略全部「存疑」条目（${ids.length} 条）？\n这些多为评选/中标/采购/信息披露等事务性公告、站名页，入库无政策价值。将从待办移除。`)) return;
  $('#btnIgnoreSuspect').disabled = true;
  await runSeq(ids, '忽略', async (id) => api('/api/crawl/ignore', { method: 'POST', body: { recordId: id } }));
  S.filter = 'todo';
  $$('#tabbar .tab').forEach((t) => t.classList.toggle('on', t.dataset.f === 'todo'));
}
function hostOf(u) {
  if (!u) return '';
  try { return new URL(u).host.replace(/^www\./, ''); } catch (_) { return ''; }
}

/* ── 行级预览 ─────────────────────────────── */
async function selectItem(id) {
  S.activeId = id;
  S.preview = null;
  S.edits = {};
  $$('.a-item').forEach((el) => el.classList.toggle('on', el.dataset.id === id));
  showPreviewLoading();
  if (!needAuth()) return;
  try {
    const pv = await api('/api/crawl/table-preview', { method: 'POST', body: { recordId: id } });
    S.preview = pv;
    renderPreview(pv);
  } catch (e) {
    showPreviewError(e instanceof AuthError ? '未登录' : e.message);
    if (e instanceof AuthError) showLoginBanner();
  }
}

function showPreviewLoading() {
  $('#preview').classList.add('hidden');
  $('#preview-empty').classList.remove('hidden');
  $('#preview-empty').innerHTML =
    '<svg><use href="#i-grid"/></svg>加载行预览…<span class="hint">正在读取目标表字段结构</span>';
}

function showPreviewError(msg) {
  $('#preview').classList.add('hidden');
  $('#preview-empty').classList.remove('hidden');
  $('#preview-empty').innerHTML =
    `<svg><use href="#i-grid"/></svg>无法预览：${esc(msg)}<span class="hint">该条可能无法归类到 10 张专题表，可考虑「忽略」</span>`;
}

function currentItem() {
  return S.items.find((i) => i.bitableRecordId === S.activeId);
}

function renderPreview(pv) {
  const it = currentItem() || {};
  $('#preview-empty').classList.add('hidden');
  $('#preview').classList.remove('hidden');
  $('#pv-table').textContent = pv.label || pv.category;
  const catEl = $('#pv-cat');
  catEl.textContent = pv.category;
  $('#pv-count').textContent = `将写入 ${pv.willWriteCount} 个字段 · ${pv.llmEnabled ? 'LLM 精提取' : '本地规则'}`;
  const open = $('#pv-open');
  open.href = it.officialUrl || '#';
  $('#pv-msg').classList.add('hidden');
  $('#pv-msg').className = 'msg hidden';

  const rowsBox = $('#pv-rows');
  rowsBox.innerHTML = pv.rows.map((r) => rowHtml(r)).join('');
  rowsBox.scrollTop = 0;

  // 输入变化 → 记录 edits（按数据列）
  rowsBox.querySelectorAll('input,textarea').forEach((inp) => {
    inp.addEventListener('change', () => onFieldInput(inp, false));
  });
  // 采用建议 → 写入当前值控件
  rowsBox.querySelectorAll('.use-sugg').forEach((btn) => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.col;
      const raw = btn.dataset.value;
      const kind = btn.dataset.kind;
      const inp = rowsBox.querySelector(`[data-col="${CSS.escape(col)}"] .winput`);
      if (!inp) return;
      inp.value = normalizeForInput(kind, raw);
      onFieldInput(inp, true);
    });
  });
  updateChangedTip();
}

function onFieldInput(inp, force) {
  const pvf = inp.closest('.pvf');
  const col = pvf && pvf.dataset.col;
  if (!col) return;
  if (inp.value) S.edits[col] = inp.value;
  else delete S.edits[col];
  if (pvf) pvf.classList.toggle('edited', inp.value !== '');
  updateChangedTip();
}

function normalizeForInput(kind, raw) {
  if (kind === 'number') {
    const n = parseFloat(String(raw).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? String(n) : '';
  }
  if (kind === 'date') {
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : '';
  }
  return String(raw ?? '');
}

function rowHtml(r) {
  const kindLabel = KIND_LABEL[r.kind] || r.kind;
  const hasSugg = r.suggest && String(r.suggest).trim() !== '';
  const engineCls = r.engine === 'remote-llm' ? 'llm' : 'rules';
  const engineTxt = r.engine === 'remote-llm' ? 'LLM' : '规则';
  const confTxt = r.confidence ? ` · ${r.confidence}%` : '';
  const showUse = hasSugg && r.editable;

  // 建议块
  let suggHtml;
  if (hasSugg) {
    suggHtml = `<div class="sugg">
      <span class="sl">建议</span>
      <span class="sbody"><span class="sv">${esc(r.suggest)}</span>${
        r.evidence ? `<div class="evid"><span><em class="engine ${engineCls}">${engineTxt}</em></span><span>${esc(r.evidence)}</span></div>` : ''
      }</span>
      ${confTxt ? `<span class="conf">${confTxt}</span>` : ''}
      ${showUse ? `<button type="button" class="use-sugg" data-col="${esc(r.col)}" data-kind="${esc(r.kind)}" data-value="${esc(r.suggest)}">采用</button>` : ''}
    </div>`;
  } else {
    suggHtml = `<div class="sugg" style="background:var(--surface-2);color:var(--ink-3)"><span class="sl" style="color:var(--ink-4)">建议</span><span class="sbody"><span class="none">无建议</span>${
      r.evidence ? `<div class="evid"><span><em class="engine rules">${engineTxt}</em></span><span>${esc(r.evidence)}</span></div>` : ''
    }</span></div>`;
  }

  // 写入值控件
  let valHtml;
  if (r.kind === 'multiselect' || r.kind === 'select' || r.kind === 'url') {
    let body = esc(r.current);
    if (r.kind === 'url' && r.current && /^https?:/.test(r.current)) {
      body = `<a href="${esc(r.current)}" target="_blank" rel="noopener">${esc(r.current)}</a>`;
    }
    valHtml = `<span class="ro">${body || '—'}</span>`;
  } else if (r.kind === 'date') {
    const iso = normalizeForInput('date', r.current);
    const rawShown = r.current && !iso ? `<span class="hint" style="flex:none">当前值「${esc(r.current)}」非标准日期</span>` : '';
    valHtml = `<input type="date" class="winput" data-col="${esc(r.col)}" value="${esc(iso)}" />${rawShown}`;
  } else if (r.kind === 'number') {
    const num = normalizeForInput('number', r.current);
    valHtml = `<input type="number" step="any" class="winput" data-col="${esc(r.col)}" value="${esc(num)}" placeholder="仅数字" />`;
  } else {
    valHtml = `<input type="text" class="winput" data-col="${esc(r.col)}" value="${esc(r.current)}" placeholder="—" />`;
  }

  return `<div class="pvf" data-col="${esc(r.col)}">
    <div class="pvf-head">
      <span class="fname" title="${esc(r.col)}">${esc(r.col)}</span>
      <span class="kind ${r.kind === 'url' ? 'url' : r.kind === 'date' ? 'date' : r.kind === 'number' ? 'number' : ''}">${esc(kindLabel)}</span>
    </div>
    <div class="pvf-body">
      ${suggHtml}
      <div class="pvf-write"><span class="wlab">写入值</span>${valHtml}</div>
    </div>
  </div>`;
}

function updateChangedTip() {
  const n = Object.keys(S.edits).length;
  $('#pv-changed').textContent = n ? `已修改 ${n} 个字段` : '';
}

/* ── 确认入库 / 忽略 ─────────────────────── */
async function confirmWrite() {
  if (S.confirmBusy || !S.preview || !needAuth()) return;
  S.confirmBusy = true;
  const btn = $('#btn-confirm');
  btn.disabled = true;
  btn.querySelector('svg').style.display = 'none';
  btn.lastChild.textContent = ' 写入中…';
  const msg = $('#pv-msg');
  msg.className = 'msg';
  msg.classList.remove('hidden');
  try {
    const body = { recordId: S.activeId };
    if (Object.keys(S.edits).length) body.updates = { ...S.edits };
    const r = await api('/api/crawl/confirm', { method: 'POST', body });
    if (r.pendingSync) {
      msg.className = 'msg warn';
      msg.textContent = r.message + (r.outboxId ? `（outbox: ${r.outboxId}）` : '');
    } else {
      msg.className = 'msg ok';
      msg.textContent = r.message || '已写入';
    }
    S.preview = null;
    S.edits = {};
    await Promise.all([loadList(), loadMatrix()]);
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = '写入失败：' + e.message;
    if (e instanceof AuthError) showLoginBanner();
  } finally {
    S.confirmBusy = false;
    btn.disabled = false;
    btn.querySelector('svg').style.display = '';
    btn.lastChild.textContent = ' 确认入库';
  }
}

async function ignoreItem() {
  if (!S.activeId || !needAuth()) return;
  if (!confirm('忽略该条目？将从待办列表移除（不写入任何专题表）。')) return;
  try {
    await api('/api/crawl/ignore', { method: 'POST', body: { recordId: S.activeId } });
    S.activeId = null;
    S.preview = null;
    S.edits = {};
    $('#preview').classList.add('hidden');
    $('#preview-empty').classList.remove('hidden');
    $('#preview-empty').innerHTML =
      '<svg><use href="#i-grid"/></svg>从左侧选择一条待审批条目<span class="hint">已忽略的条目会从待办列表移除</span>';
    await Promise.all([loadList(), loadMatrix()]);
  } catch (e) {
    alert('忽略失败：' + e.message);
    if (e instanceof AuthError) showLoginBanner();
  }
}

/* ── 初始化 ───────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  $('#btn-run').addEventListener('click', startRun);
  $('#btn-confirm').addEventListener('click', confirmWrite);
  $('#btn-ignore').addEventListener('click', ignoreItem);
  // 分组 tab
  $('#tabbar').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.tab');
    if (!tab) return;
    S.filter = tab.dataset.f;
    $$('#tabbar .tab').forEach((t) => t.classList.toggle('on', t === tab));
    S.checked = new Set();
    renderList();
  });
  // 批量
  $('#ckAll').addEventListener('change', () => {
    const vis = visibleItems();
    if ($('#ckAll').checked) vis.forEach((v) => S.checked.add(v.bitableRecordId));
    else S.checked = new Set();
    renderList();
  });
  $('#btnBatchConfirm').addEventListener('click', batchConfirm);
  $('#btnBatchIgnore').addEventListener('click', batchIgnore);
  $('#btnTrustTodo').addEventListener('click', trustAllTodo);
  const ignSuspectBtn = $('#btnIgnoreSuspect');
  if (ignSuspectBtn) ignSuspectBtn.addEventListener('click', ignoreAllSuspect);
  boot();
});
