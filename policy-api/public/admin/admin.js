'use strict';
/* 政策采集审批工作台 UI v2 —— 行级审批入库（/admin/）
   数据直连同源 /api/crawl/* ；本地 MOCK 登录态与飞书 OAuth 均可用 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
// 防御性 DOM 写入：元素缺失（旧缓存/不同渲染）时静默忽略，避免单点 null 拖垮整个 startRun/pollRun
function setText(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }
function setStyle(id, prop, val) { const e = document.getElementById(id); if (e) e.style[prop] = val; }
function toggleClass(id, cls, on) { const e = document.getElementById(id); if (e) e.classList.toggle(cls, on); }
function addClass(id, cls) { const e = document.getElementById(id); if (e) e.classList.add(cls); }
function rmClass(id, cls) { const e = document.getElementById(id); if (e) e.classList.remove(cls); }

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
  filter: 'all', // 默认显示所有待审批条目，而不是只显示待处理       // todo(new+needs_update) / exists / all
  sort: 'added',        // added(入池时间) | date(发布日期) | relevance
  sortDir: 'desc',      // desc | asc
  catFilter: 'all',     // all | 具体分类
  health: null,
  healthFilter: '',
  batch: 'all',
  crawlMode: 'daily',
  liveRefreshStarted: false,
  checked: new Set(),   // 勾选的 bitableRecordId
};

const KIND_LABEL = { date: '日期', number: '数字', url: '链接', select: '单选', multiselect: '多选', text: '文本' };
const STATUS_LABEL = { new: '新发现', exists: '库中已有', needs_update: '需更新', unknown: '待比对' };
const STATUS_CLS = { new: 'chip ok', exists: 'chip info', needs_update: 'chip warn', unknown: 'chip gray' };
let REGION_LIST = ['全国'];
const CATEGORY_LIST = ['最低工资', '平均工资', '公积金', '年金', '大病医疗', '高温津贴', '残疾职工', '婚育相关', '病假工资'];

/* ── 请求封装 ─────────────────────────────── */
async function safeMe() {
  try { return await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()); }
  catch (_) { return null; }
}

async function api(url, opt = {}) {
  return apiAttempt(url, opt, 0);
}

async function apiAttempt(url, opt, attempt) {
  let res;
  const timeoutMs = Math.max(1000, Number(opt.timeoutMs || 20000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _dropTimeout, ...fetchOpt } = opt;
  try {
    res = await fetch(url, {
      credentials: 'same-origin',
      headers: opt.body ? { 'Content-Type': 'application/json' } : undefined,
      ...fetchOpt,
      signal: controller.signal,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs/1000)}秒）：${url}`);
    const origin = location.origin && location.origin !== 'null' ? location.origin : '';
    const openedAsFile = location.protocol === 'file:' || location.protocol === 'blob:';
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    const recovery = openedAsFile
      ? '当前打开的是独立预览文件，请访问 http://localhost:4201/admin/ 后重试'
      : isLocal
        ? `无法连接 ${origin || 'http://localhost:4201'}，请确认 4201 服务正在运行后刷新页面`
        : `无法连接当前站点 ${origin || '的后端'}，请确认页面与 API 部署在同一服务后重试`;
    throw new Error(`网络错误：${e && e.message ? e.message : '请求失败'}。${recovery}`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401) {
      // 登录态可能过期（刷新/重启后常见）：静默补登一次再重试，避免「点啥都没反应」
      if (attempt === 0) {
        try {
          await fetch('/auth/login', { method: 'GET', credentials: 'same-origin' });
          S.me = await safeMe();
        } catch (_) {}
        if (S.me && S.me.authenticated) return apiAttempt(url, opt, 1);
      }
      if (!S.me || !S.me.authenticated) showLoginBanner();
      throw new AuthError((data && data.message) || '未登录');
    }
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
  const runCard = $('#run-card');
  const runSlot = $('#run-controls-slot');
  if (runCard && runSlot) {
    const controls = runCard.querySelector('.cb');
    if (controls) runSlot.append(...controls.childNodes);
    runCard.remove();
  }
  $('#btnTheme').addEventListener('click', toggleTheme);
  try {
    S.me = await api('/api/me');
  } catch (e) {
    S.me = null;
  }
  // MOCK 模式且未登录 → 静默补登录（fetch 拿模拟 cookie，不离开 admin 页面，避免被弹到首页后回不来）
  if (!S.me || !S.me.authenticated) {
    if (S.me && S.me.mock) {
      try {
        await fetch('/auth/login', { method: 'GET', credentials: 'same-origin' });
        S.me = await api('/api/me');
      } catch (_) { /* 忽略，下面统一判 } */}
      if (S.me && S.me.authenticated) {
        // 已恢复登录，继续往下加载
      } else {
        S.me = null;
        showLoginBanner();
        return;
      }
    } else {
      S.me = null;
      showLoginBanner();
      return;
    }
  }
  $('#who').textContent = S.me.name || S.me.sub || '';
  try {
    await Promise.all([loadMatrix(), loadList(), loadHealth()]);
    startLiveRefresh();
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

function renderBatchTabs(batches) {
  const box = $('#region-tabs');
  if (!box) return;
  box.innerHTML = batches.map((b) => `<button class="${b.id === S.batch ? 'on' : ''}" data-batch="${esc(b.id)}">${esc(b.label)} <small>${b.total}</small></button>`).join('');
  box.querySelectorAll('button').forEach((button) => button.addEventListener('click', async () => {
    if (S.runBusy || button.dataset.batch === S.batch) return;
    S.batch = button.dataset.batch;
    S.checked = new Set();
    await Promise.all([loadMatrix(), loadList(), loadHealth()]);
  }));
}

function renderPipeline(flow) {
  $$('#pipeline [data-flow]').forEach((button) => {
    const key = button.dataset.flow;
    const value = Number(flow[key] || 0);
    button.querySelector('b').textContent = value;
    button.title = key === 'accepted' ? `当前批次累计实际入池 ${value} 条` : `当前批次累计 ${value} 条`;
  });
}

function renderTaskList(tasks) {
  const box = $('#task-list');
  if (!box) return;
  $('#task-count').textContent = `${tasks.length} 项`;
  box.innerHTML = tasks.map((task) => {
    const p = task.pipeline || {};
    const paused = task.state === 'paused';
    return `<div class="task-row ${esc(task.state)}"><span class="task-state">${esc(task.state)}</span><b>${esc(task.region)}</b><span>${esc(task.keyword)}</span><small>${task.lastRun ? esc(task.lastRun.slice(0,16).replace('T',' ')) : '未运行'}</small><small>发现${p.discovered||0} · 日期过滤${p.dateFiltered||0} · 质量过滤${p.qualityFiltered||0} · 去重${p.duplicates||0} · 入池${p.accepted||0}</small><span class="task-actions"><button data-task-action="${paused ? 'resume' : 'pause'}" data-task-id="${esc(task.id)}">${paused ? '恢复' : '暂停'}</button><button data-task-action="priority" data-task-id="${esc(task.id)}" data-priority="${Number(task.priority)||0}">优先 +10</button></span>${task.error ? `<small class="err">${esc(task.error)}</small>` : ''}</div>`;
  }).join('') || '<span class="hint">当前批次没有任务</span>';
  box.querySelectorAll('[data-task-action]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    const action = button.dataset.taskAction;
    const body = action === 'priority' ? { action, priority:Math.min(100, Number(button.dataset.priority || 0) + 10) } : { action };
    try {
      await api('/api/crawl/tasks/' + encodeURIComponent(button.dataset.taskId), { method:'PATCH', body });
      await loadMatrix();
    } catch (e) {
      setText('run-state', '任务更新失败：' + e.message);
      button.disabled = false;
    }
  }));
}

function updateRegionOptions(regions) {
  const select = $('#run-region');
  const previous = select.value;
  select.innerHTML = '<option value="">（当前批次全部地区）</option>';
  for (const region of regions || []) select.add(new Option(region, region));
  if ([...select.options].some((x) => x.value === previous)) select.value = previous;
  if ($('#run-category').options.length === 1) for (const category of CATEGORY_LIST) $('#run-category').add(new Option(category, category));
  select.onchange = updateRunButtonLabel;
  updateRunButtonLabel();
}

// 主运行按钮文案实时反映「真正会跑哪一片」，避免选了批次却误以为在跑全部 416。
function updateRunButtonLabel() {
  const btn = $('#btn-run');
  if (!btn) return;
  const region = $('#run-region').value;
  const batch = S.batch || 'all';
  let label;
  if (region) label = `运行 ${region} 全部剩余`;
  else if (batch !== 'all') label = `运行 ${S.matrix?.batch?.label || batch} 批次全部剩余`;
  else label = '运行 全部 批次全部剩余';
  const svg = btn.querySelector('svg') ? btn.querySelector('svg').outerHTML : '';
  btn.innerHTML = svg + label;
}

function startLiveRefresh() {
  if (S.liveRefreshStarted) return;
  S.liveRefreshStarted = true;
  (async function loop() {
    try {
      if (!document.hidden) await Promise.all([loadMatrix(), loadList(), loadHealth()]);
    } catch (_) {}
    setTimeout(loop, S.runBusy ? 1500 : 5000);
  })();
}

/* ── 概览 + 一键巡检 ─────────────────────── */
async function loadMatrix() {
  if (!needAuth()) return;
  try {
    const m = await api('/api/crawl/matrix-status?batch=' + encodeURIComponent(S.batch));
    S.matrix = m;
    updateRunButtonLabel();
    $('#m-total').textContent = m.total;
    $('#m-running').textContent = m.runningCount || 0;
    $('#m-done').textContent = m.done;
    $('#m-err').textContent = m.error;
    $('#m-rest').textContent = m.remaining;
    $('#m-paused').textContent = m.paused || 0;
    // 分段进度条：完成(绿) + 失败(红) + 待跑(蓝)
    const total = m.total || 1;
    const pct = (n) => Math.max(0, Math.min(100, Math.round((n / total) * 100)));
    $('#pOk').style.width = pct(m.done) + '%';
    $('#pErr').style.width = pct(m.error) + '%';
    $('#pGo').style.width = pct(m.remaining) + '%';
    $('#m-pending').textContent = m.queue.pending;
    $('#m-pending-today').textContent = m.queue.todayAdded || 0;
    $('#m-outbox').textContent = m.outboxPending;
    const dot = $('#navDot');
    const pend = m.queue.pending || 0;
    if (pend > 0) { dot.textContent = pend > 99 ? '99+' : pend; dot.classList.remove('hidden'); }
    else dot.classList.add('hidden');
    setEngineBadge(!!m.llmEnabled);
    renderBatchTabs(m.batches || []);
    renderPipeline(m.pipeline || {});
    renderTaskList(m.tasks || []);
    $('#batch-scope').textContent = `${m.batch?.label || '全部'} · ${m.total || 0} 组合`;
    if (Array.isArray(m.regions) && m.regions.length) REGION_LIST = m.regions;
    updateRegionOptions(m.batch?.regions || REGION_LIST);
    const errDetail = $('#m-err-detail');
    if (m.error && m.recentErrors && m.recentErrors.length) {
      errDetail.classList.remove('hidden');
      errDetail.textContent = '最近失败: ' + m.recentErrors.map((e) => e.id + ' → ' + (e.error || '')).join('；');
    } else errDetail.classList.add('hidden');
    const active = !!(m.activeSweep && m.activeSweep.busy) || !!(m.running && m.running.length) || !!m.sweepLock?.locked;
    S.runBusy = active;
    $('#btn-run').disabled = active;
    if ($('#btn-run-all')) $('#btn-run-all').disabled = active;
    $('#btn-ai-expand').disabled = active;
    if (active) {
      const runningId = (m.running && m.running[0]) || m.activeSweep?.id || '';
      const state = m.activeSweep?.state || 'running';
      const owner = m.activeSweep?.source === 'external' ? (m.activeSweep?.owner || 'cron/补偿') : '手动巡检';
      setText('run-state', state === 'stopping' ? '正在停止巡检…' : `运行中 · ${owner}`);
      $('#btn-stop').classList.remove('hidden');
      $('#btn-stop').dataset.runId = runningId;
      $('#btn-stop').title = runningId ? `停止任务 ${runningId.slice(-8)}` : '停止当前巡检';
    } else {
      $('#btn-stop').classList.add('hidden');
      $('#btn-stop').dataset.runId = '';
    }
  } catch (e) {
    if (!(e instanceof AuthError)) console.error('matrix-status 失败', e);
  }
}

async function startRun(opts = {}) {
  if (S.runBusy || !needAuth()) return;
  const region = $('#run-region').value;
  const category = $('#run-category').value;
  const batch = S.batch || 'all';
  // 定向地区为空时，尊重「当前批次」的省集合（华北/华东…）而不是全量 416；
  // 只有 batch=all 且没定向才跑全量。选了具体省就只跑该省。
  const batchRegions = (!region && batch !== 'all' && S.matrix?.batch?.regions) ? S.matrix.batch.regions : [];
  const scoped = !!(region || category || batchRegions.length);
  const all = typeof opts === 'object' && opts !== null && typeof opts.all === 'boolean' ? opts.all : !scoped;
  // 选了具体省 → 强制「初始化补全」模式，确保历史政策也能入池（daily 只抓今日增量，常显 0 让人以为没跑）
  const body = { all, batch, mode: region ? 'initial' : S.crawlMode };
  if (region) body.region = region;
  else if (batchRegions.length) body.regions = batchRegions;
  if (category) body.category = category;

  S.runBusy = true;
  $('#btn-run').disabled = true;
  setText('run-state', '启动中…');
  const logEl = $('#run-log');
  logEl.classList.remove('hidden');
  logEl.textContent = '';
  // 重置本轮专属进度条
  const rp = document.getElementById('runprog');
  if (rp) rp.classList.remove('hidden');
  $('#runprog-label').textContent = '已提交，等待子进程启动…';
  $('#runprog-pct').textContent = '0%';
  $('#rp-done').style.width = '0%';
  $('#rp-fail').style.width = '0%';
  $('#runprog-sub').textContent = region ? `目标地区：${region}` : (batchRegions.length ? `目标批次：${batchRegions.join('、')}` : '全部地区');
  // 顶部固定横幅：保证用户看到"在爬"的明确证据
  const banner = document.getElementById('run-banner');
  if (banner) {
    if (S.runBannerTimer) { clearTimeout(S.runBannerTimer); S.runBannerTimer = null; }
    banner.classList.remove('hidden', 'done', 'killed');
    document.body.classList.add('has-run-banner');
    $('#rb-done').style.width = '0%';
    $('#rb-fail').style.width = '0%';
    $('#rb-pct').textContent = '0%';
    $('#rb-label').textContent = region ? `已提交：${region}（${(S.matrix?.CATEGORY_KEYWORDS || []).length || 13} ��）` : '已提交，等待子进程启动…';
    $('#rb-cell').textContent = region ? `目标地区：${region}` : (batchRegions.length ? `目标批次：${batchRegions.join('、')}` : '全部地区');
    $('#rb-stats').textContent = '';
  }
  if (!S.runTitleOrig) S.runTitleOrig = document.title;
  try {
    const r = await api('/api/crawl/matrix-run', { method: 'POST', body });
    $('#btn-stop').classList.remove('hidden');
    $('#btn-stop').dataset.runId = r.runId || '';
    pollRun(r.runId);
  } catch (e) {
    setText('run-state', e.message);
    logEl.textContent = '启动失败：' + e.message;
    S.runBusy = false;
    $('#btn-run').disabled = false;
    if (e instanceof AuthError) showLoginBanner();
  }
}

// 解析运行日志，更新本轮专属进度条 + 顶部固定横幅；result 非空表示已结束
function updateRunProgress(log, result) {
  const lines = Array.isArray(log) ? log : [];
  let cur = 0, total = 0, cell = '', latestLine = '';
  const re = /\[(\d+)\/(\d+)\]\s*([^\n→]+)/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(re);
    if (m) { cur = +m[1]; total = +m[2]; cell = m[3].trim(); latestLine = lines[i]; break; }
  }
  const isEnd = !!result;
  let failed = 0;
  const failRe = /→\s*失败/;
  for (const ln of lines) if (failRe.test(ln)) failed++;
  if (isEnd) {
    // remaining 是「全矩阵剩余未跑格数」(如 416-95=321)，不是本轮的，不能加进 total
    // 本轮 total 从最后一条 [X/Y] 日志的 Y 读取；若日志里没有则 fallback 到 done+failed
    if (!total) total = (result.done || 0) + (result.failed || 0);
    cur = result.done || 0;
    failed = result.failed || 0;
  }
  const tot = total || 1;
  const doneCells = isEnd ? cur : Math.max(0, cur - 1); // 正在处理第 cur 格 → 已完成 cur-1
  const doneW = Math.max(0, Math.min(100, Math.round((doneCells / tot) * 100)));
  const failW = Math.min(100 - doneW, Math.max(0, Math.round((failed / tot) * 100)));
  const pct = Math.round((cur / tot) * 100);

  // 从最近一格日志解析"发现/入池"，用于实时展示
  let hits = 0, added = 0;
  if (isEnd) { hits = result.hits ?? 0; added = result.added ?? 0; }
  else {
    const hm = latestLine.match(/发现\s*(\d+)/); if (hm) hits = +hm[1];
    const am = latestLine.match(/入池\s*(\d+)/); if (am) added = +am[1];
  }

  let label, sub, stats;
  if (isEnd) {
    label = (result.stopped || result.killed) ? '已停止' : '✓ 巡检完成';
    sub = `命中 ${result.hits ?? 0} · 新入池 ${result.added ?? 0} · 失败 ${result.failed ?? 0}`;
    stats = `完成 ${result.done ?? 0}/${tot} · 入池 ${result.added ?? 0} · 失败 ${result.failed ?? 0}`;
  } else if (cur) {
    label = `第 ${cur} / ${total} 格`;
    sub = cell ? `正在爬取：${cell}` : '爬取中…';
    stats = `本次发现 ${hits} · 入池 ${added} · 失败 ${failed}`;
  } else {
    label = '启动中…';
    sub = '正在初始化子进程…';
    stats = '';
  }

  // 小进度条（按钮下方）
  $('#rp-done').style.width = doneW + '%';
  $('#rp-fail').style.width = failW + '%';
  $('#runprog-pct').textContent = pct + '%';
  $('#runprog-label').textContent = label;
  $('#runprog-sub').textContent = sub;

  // 顶部固定横幅（同一份数据驱动）+ 浏览器标题闪烁
  const banner = document.getElementById('run-banner');
  if (banner) {
    const rd = document.getElementById('rb-done');
    const rf = document.getElementById('rb-fail');
    if (rd) rd.style.width = doneW + '%';
    if (rf) rf.style.width = failW + '%';
    $('#rb-pct').textContent = pct + '%';
    $('#rb-label').textContent = label;
    $('#rb-cell').textContent = sub;
    $('#rb-stats').textContent = stats;
    banner.classList.toggle('done', isEnd && !(result && (result.stopped || result.killed)));
    banner.classList.toggle('killed', isEnd && !!(result && (result.stopped || result.killed)));
    banner.classList.remove('hidden');
  }
  if (!isEnd && cur && !S.runTitleOrig) S.runTitleOrig = document.title;
  if (!isEnd && cur) {
    document.title = `🔴 ${cur}/${total} ${cell || ''} · 审批台`;
  }
}

function pollRun(runId) {
  setText('run-state', '运行中…（每批约 1–3 分钟，可离开稍后刷新）');
  (async function poll() {
    try {
      const r = await api('/api/crawl/matrix-run/' + runId);
      const logEl = $('#run-log');
      logEl.textContent = (r.log || []).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
      // 本轮进度条：解析日志里的 [X/Y] 标记，实时反映爬到哪一格
      updateRunProgress(r.log, r.state !== 'running' ? r.result : null);
      if (r.state === 'stopping') {
        S.runBusy = true;
        $('#btn-stop').classList.remove('hidden');
        setText('run-state', '正在停止巡检…');
        setTimeout(poll, 1500);
        return;
      }
      if (r.state !== 'running') {
        S.runBusy = false;
        $('#btn-run').disabled = false;
        if ($('#btn-run-all')) $('#btn-run-all').disabled = false;
        $('#btn-ai-expand').disabled = false;
        $('#btn-stop').classList.add('hidden');
        const res = r.result || {};
        if (r.state === 'killed' || res.killed || res.stopped) {
          setText('run-state', '✓ 已停止，本轮不会自动续跑');
        } else if (res.ok) {
          setText('run-state', `✓ 本轮完成并停止：命中 ${res.hits ?? 0}，新入池 ${res.added ?? 0}，失败 ${res.failed ?? 0}，剩 ${res.remaining ?? '?'}`);
        } else {
          setText('run-state', '✗ ' + (res.error || '未知错误'));
        }
        // 恢复浏览器标题 + 8 秒后收起顶部横幅（让用户看清完成结果再消失）
        if (S.runTitleOrig) { document.title = S.runTitleOrig; S.runTitleOrig = null; }
        const _bnr = document.getElementById('run-banner');
        if (_bnr && !_bnr.classList.contains('hidden')) {
          if (S.runBannerTimer) clearTimeout(S.runBannerTimer);
          S.runBannerTimer = setTimeout(() => {
            _bnr.classList.add('hidden');
            document.body.classList.remove('has-run-banner');
            S.runBannerTimer = null;
          }, 8000);
        }
        await Promise.all([loadMatrix(), loadList(), loadHealth()]);
        return;
      }
      await Promise.all([loadMatrix(), loadList()]);
      setTimeout(poll, 1500);
    } catch (e) {
      S.runBusy = false;
      $('#btn-run').disabled = false;
      setText('run-state', '轮询失败：' + e.message);
      if (e instanceof AuthError) showLoginBanner();
    }
  })();
}


/* ── 来源健康 + 自动补偿 ───────────────────── */
async function loadHealth() {
  if (!needAuth()) return;
  try {
    const d = await api('/api/crawl/source-health?batch=' + encodeURIComponent(S.batch));
    S.health = d;
    const sum = d.summary || {};
    for (const k of ['healthy','degraded','suspicious','stale','down','unknown']) {
      const el = $('#h-' + k); if (el) el.textContent = sum[k] || 0;
    }
    const pending = (d.compensationQueue || []).filter((q) => ['queued','retry','running'].includes(q.status));
    $('#h-comp').textContent = pending.length;
    renderHealthList();
  } catch (e) {
    if (!(e instanceof AuthError)) console.error('source-health 失败', e);
  }
}

function renderHealthList() {
  const box = $('#health-list');
  if (!box || !S.health) return;
  const severity = { down:5, suspicious:4, stale:3, degraded:2, unknown:1, healthy:0 };
  let items = (S.health.items || []);
  if (!S.healthFilter) items = items.filter((x) => x.status !== 'healthy' && x.status !== 'unknown');
  else items = items.filter((x) => x.status === S.healthFilter);
  items = items.sort((a,b) => (severity[b.status]||0)-(severity[a.status]||0) || (b.failedRuns24h||0)-(a.failedRuns24h||0)).slice(0,10);
  const unknownCount = (S.health.summary?.unknown || 0);
  if (!items.length) {
    box.innerHTML = `<span class="hint">当前没有需要处理的已验证来源${unknownCount ? `；另有 ${unknownCount} 个省尚未完成首次验证` : ''}</span>`;
    return;
  }
  box.innerHTML = items.map((x) => {
    const bad = x.badEndpoints || [];
    const err = x.lastError || bad[0]?.lastError || '';
    const endpointUrl = bad[0]?.url || bad[0]?.urls?.[0] || '';
    const last = x.lastDiscoveredAt || x.lastRunAt || '';
    const comp = x.compensation ? ` · 补偿:${x.compensation.status}/${x.compensation.mode}` : '';
    const detail = `${last ? '最近成功/发现 ' + last.slice(0,16).replace('T',' ') : '暂无成功记录'} · 搜索${x.searchItems||0}/官网${x.enumItems||0}${bad.length ? ' · 失败入口'+bad.length : ''}${comp}`;
    return `<div class="health-row issue"><div class="health-main"><div class="health-head"><b>${esc(x.region)}</b><span class="health-state ${esc(x.status)}">${esc(x.status)}</span></div><small>${esc(detail)}</small><small class="health-action-text">建议：${esc(x.action || '先探测来源')}</small>${endpointUrl ? `<small class="health-endpoint">失败入口：${esc(endpointUrl)}</small>` : ''}${err ? `<small class="health-error">${esc(err)}</small>` : ''}</div><div class="health-actions"><button class="mini-action health-probe" data-region="${esc(x.region)}">探测</button><button class="mini-action health-recheck" data-region="${esc(x.region)}">修复复检</button></div></div>`;
  }).join('');
  $$('.health-probe').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const logEl = $('#run-log');
    logEl.classList.remove('hidden');
    setText('run-state', `正在探测 ${b.dataset.region} 官方来源…`);
    try {
      const r = await api('/api/crawl/source-probe/' + encodeURIComponent(b.dataset.region), { method:'POST', body:{}, timeoutMs:80000 });
      const lines = [
        `${r.region || b.dataset.region} 来源探测：${r.ok ? '可用' : '异常'}，命中 ${r.itemCount || 0} 条，耗时 ${Math.round((r.elapsedMs || 0)/1000)}s`,
        ...(r.diagnostics || []).map((d) => `${d.ok ? '✓' : '✗'} ${d.label} | ${d.type} | items=${d.itemCount || 0} | success=${d.success || 0} failed=${d.failed || 0}${d.lastError ? ' | ' + d.lastError : ''}`),
      ];
      logEl.textContent = lines.join('\n');
      setText('run-state', r.ok ? '✓ 来源探测完成' : '⚠ 来源存在异常，见日志');
      await loadHealth();
    } catch(e) { setText('run-state', '来源探测失败：' + e.message); }
    finally { b.disabled = false; }
  }));
  $$('.health-recheck').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { const r = await api('/api/crawl/source-health/' + encodeURIComponent(b.dataset.region) + '/recheck', { method:'POST', body:{} }); pollRun(r.runId); }
    catch(e){ setText('run-state', e.message); b.disabled=false; }
  }));
}

async function runNextCompensation() {
  const b=$('#btn-comp-next'); if (!b) return;
  b.disabled=true;
  try {
    const r=await api('/api/crawl/compensation/run-next',{method:'POST',body:{}});
    if (r.empty) { setText('run-state', r.message); b.disabled=false; return; }
    pollRun(r.runId);
  } catch(e) { setText('run-state', e.message); b.disabled=false; }
}

/* ── 待审批列表 ───────────────────────────── */
async function loadList() {
  try {
    // 待审批面板始终展示全量待审批池（与真实入池逻辑一致），不受"今日增量/初始化补全"切换影响
    // —— 否则 daily 模式下接口只返今日新增，会把历史待审批全部藏起来，造成"跑了却没增加"的错觉
    const d = await api('/api/crawl/crawled-pending?batch=' + encodeURIComponent(S.batch) + '&mode=initial');
    S.items = (d.items || []).slice().reverse(); // 新的在前
    S.comparisonAvailable = d.comparisonAvailable !== false;
    renderStats(d.stats || {});
    renderList();
    const state = $('#run-state');
    if (!S.comparisonAvailable && state && !S.runBusy) state.textContent = '飞书存量比对暂不可用，审批队列已使用本地数据快速加载；稍后刷新会自动重试';
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
    (st.exists ? `<b class="c-exists">已有 ${st.exists}</b>` : '') +
    (st.unknown ? `<b class="c-unknown">待比对 ${st.unknown}</b>` : '');
}

function renderList() {
  const box = $('#list');
  const empty = $('#list-empty');
  const ctrlbar = $('#ctrlbar');
  if (!S.items.length) {
    box.innerHTML = '';
    empty.classList.remove('hidden');
    ctrlbar.classList.add('hidden');
    renderTabs();
    $('#batchbar').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  ctrlbar.classList.remove('hidden');
  // 更新排序按钮状态
  $$('.ctrlbtns .ctrlbtn').forEach((b) => {
    b.classList.toggle('on', b.dataset.sort === S.sort);
  });
  const dirBtn = $('#btnSortDir');
  if (dirBtn) dirBtn.textContent = S.sortDir === 'desc' ? '↓' : '↑';
  // 更新分类选择器（如果为空则填充）
  const catSel = $('#catFilter');
  if (catSel && !catSel.options.length) {
    const cats = getCategories();
    cats.forEach((c) => {
      const opt = new Option(c, c);
      catSel.add(opt);
    });
  }
  if (catSel) catSel.value = S.catFilter;
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
            ${it.addedToday ? '<span class="chip chip-new" title="今天刚入池（非发布日期）">NEW</span>' : ''}
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
function getCategories() {
  const cats = new Set();
  S.items.forEach((i) => {
    const c = i.category;
    if (c && c !== '薪酬月刊') cats.add(c);
  });
  return Array.from(cats).sort();
}
function visibleItems() {
  let items = S.items;
  // 分组过滤
  const f = S.filter;
  if (f === 'all') {} else if (f === 'suspect') items = items.filter((i) => isSuspect(i));
  else if (f === 'exists') items = items.filter((i) => i.comparisonResult === 'exists');
  else items = items.filter((i) => i.comparisonResult !== 'exists' && !isSuspect(i));
  // 分类过滤
  if (S.catFilter !== 'all') {
    items = items.filter((i) => (i.topicCategory || i.category || i.policyDomain) === S.catFilter);
  }
  // 排序
  if (S.sort === 'added') {
    // 按入池时间排序：刚跑完入池的排最前，否则新条目发布日期旧会沉底、看起来像"没入池"
    items = [...items].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return S.sortDir === 'desc' ? tb - ta : ta - tb;
    });
  } else if (S.sort === 'date') {
    items = [...items].sort((a, b) => {
      const da = a.publishDate ? new Date(a.publishDate).getTime() : 0;
      const db = b.publishDate ? new Date(b.publishDate).getTime() : 0;
      return S.sortDir === 'desc' ? db - da : da - db;
    });
  }
  return items;
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
  if (trustBtn) {
    trustBtn.disabled = todoN === 0 || S.comparisonAvailable === false;
    trustBtn.title = S.comparisonAvailable === false ? '飞书存量比对不可用时禁止批量直入，请逐条人工确认' : '跳过逐条核对，直接写入全部待处理条目';
  }
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
  const text = String(msg || '未知错误');
  const isClassify = /无法判定目标专题表|无法归类|专题表/.test(text) && !/网络错误|Failed to fetch|请求超时|timeout/i.test(text);
  const isNetwork = /网络错误|Failed to fetch|请求超时|timeout|ECONN|EAI_AGAIN|socket/i.test(text);
  const isPermission = /403|权限|permission|forbidden/i.test(text);
  let hint = '预览失败不代表该政策应被忽略，可稍后重试。';
  if (isClassify) hint = '该条确实暂未匹配到 10 张专题表；请先核对分类，再决定是否忽略。';
  else if (isNetwork) hint = '这是预览服务/网络连接问题，不是分类失败。不要因此忽略该条；确认 4201 正常后重试。';
  else if (isPermission) hint = '这是飞书字段读取/权限问题，不代表该条无法归类；权限恢复后重试。';
  const retry = S.activeId ? '<button class="btn sm" id="pv-retry" type="button">重试预览</button>' : '';
  $('#preview-empty').innerHTML =
    `<svg><use href="#i-grid"/></svg>无法预览：${esc(text)}<span class="hint">${esc(hint)}</span>${retry}`;
  const btn = $('#pv-retry');
  if (btn) btn.onclick = () => selectItem(S.activeId);
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
  // 采用建议 → 写入当前值控件（旧版建议块残留兼容，新版已直接预填）
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
  // AI 建议已预填进写入框 → 同步计入待提交 edits，用户可就地修改或清空（清空即不提交）
  rowsBox.querySelectorAll('input.ai-filled, textarea.ai-filled').forEach((inp) => {
    const pvf = inp.closest('.pvf');
    const col = pvf && pvf.dataset.col;
    if (col && inp.value) S.edits[col] = inp.value;
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

  const hasEvidence = r.evidence && String(r.evidence).trim() !== '';

  // AI 建议不再单起一块：直接预填进「写入值」输入框，一行搞定，用户就地改或清空即可。
  const aiCls = hasSugg ? ' ai-filled' : '';
  const aiTag = hasSugg
    ? `<span class="ai-tag ${engineCls}" title="${esc((hasEvidence ? r.evidence + ' · ' : '') + 'AI 建议已预填' + (r.confidence ? '，置信度 ' + r.confidence + '%' : ''))}">${engineTxt}${r.confidence ? ' ' + r.confidence + '%' : ''}</span>`
    : '';
  // 依据只在真有内容时占第二行；没有就整块消失，不留空占位
  const evidHtml = hasEvidence
    ? `<div class="evid-line"><em class="engine ${engineCls}">${engineTxt}</em><span>${esc(r.evidence)}</span></div>`
    : '';

  // 写入值控件：有建议时用建议值预填，否则用当前值
  const pick = (kind) => (hasSugg ? normalizeForInput(kind, r.suggest) : normalizeForInput(kind, r.current));

  let valHtml;
  if (r.kind === 'multiselect' || r.kind === 'select' || r.kind === 'url') {
    let body = hasSugg ? r.suggest : r.current;
    if (r.kind === 'url' && body && /^https?:/.test(body)) {
      body = `<a href="${esc(body)}" target="_blank" rel="noopener">${esc(body)}</a>`;
    }
    valHtml = `<span class="ro${aiCls ? ' ro-ai' : ''}">${body ? esc(body) : '—'}</span>`;
  } else if (r.kind === 'date') {
    const iso = pick('date');
    const rawShown = r.current && !iso && !hasSugg ? `<span class="hint" style="flex:none">当前值「${esc(r.current)}」非标准日期</span>` : '';
    valHtml = `<input type="date" class="winput${aiCls}" data-col="${esc(r.col)}" value="${esc(iso)}" />${rawShown}`;
  } else if (r.kind === 'number') {
    valHtml = `<input type="number" step="any" class="winput${aiCls}" data-col="${esc(r.col)}" value="${esc(pick('number'))}" placeholder="仅数字" />`;
  } else {
    const v = hasSugg ? r.suggest : r.current;
    valHtml = `<input type="text" class="winput${aiCls}" data-col="${esc(r.col)}" value="${esc(v)}" placeholder="—" />`;
  }

  return `<div class="pvf${hasSugg ? ' has-ai' : ''}" data-col="${esc(r.col)}">
    <div class="pvf-head">
      <span class="fname" title="${esc(r.col)}">${esc(r.col)}</span>
      <span class="kind ${r.kind === 'url' ? 'url' : r.kind === 'date' ? 'date' : r.kind === 'number' ? 'number' : ''}">${esc(kindLabel)}</span>
      ${aiTag}
    </div>
    <div class="pvf-body">
      <div class="pvf-write"><span class="wlab">写入值</span>${valHtml}</div>
      ${evidHtml}
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
  $('#mode-switch').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button || S.runBusy) return;
    S.crawlMode = button.dataset.mode === 'initial' ? 'initial' : 'daily';
    $$('#mode-switch [data-mode]').forEach((x) => x.classList.toggle('on', x === button));
    $('#mode-help').textContent = S.crawlMode === 'daily'
      ? '仅今天发布且通过质量和去重的新政策进入待审批'
      : '允许历史有效政策通过质量和去重后进入待审批';
    await loadList();
  });
  $('#btn-run').addEventListener('click', startRun);
  if ($('#btn-run-all')) $('#btn-run-all').addEventListener('click', () => {
    if (S.runBusy) return;
    startRun({ all: true });
  });
  $('#btn-stop').addEventListener('click', async () => {
    // 不依赖浏览器里的 runId/runBusy：页面刷新后也必须能停止 cron/补偿/手动巡检。
    $('#btn-stop').disabled = true;
    setText('run-state', '正在停止当前巡检…');
    try {
      const r = await api('/api/crawl/sweep-stop', { method: 'POST', body:{} });
      if (r.empty) {
        setText('run-state', '当前没有运行中的巡检');
      } else {
        // 等后端 lock 真正释放再恢复按钮，避免“界面显示已停但进程还在”。
        const deadline = Date.now() + 12000;
        let stopped = false;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          const m = await api('/api/crawl/matrix-status');
          if (!(m.activeSweep?.busy || m.sweepLock?.locked || (m.running||[]).length)) { stopped = true; break; }
        }
        setText('run-state', stopped ? '✓ 已停止，本轮不会自动续跑' : '⚠ 停止超时，任务可能仍在运行，请再次停止或检查服务日志');
      }
    } catch (e) {
      setText('run-state', '停止失败：' + e.message);
    } finally {
      $('#btn-stop').disabled = false;
      await loadMatrix();
    }
  });
  // AI 智能发现按钮
  $('#btn-ai-expand').addEventListener('click', async () => {
    if (S.runBusy || !needAuth()) return;
    const region = $('#run-region').value || S.matrix?.batch?.regions?.[0] || '全国';
    const category = $('#run-category').value || '最低工资';
    S.runBusy = true;
    $('#btn-ai-expand').disabled = true;
    setText('run-state', 'AI 生成变体词并补搜中…');
    const logEl = $('#run-log');
    logEl.classList.remove('hidden');
    logEl.textContent = '';
    try {
      const r = await api('/api/crawl/ai-expand', {
        method: 'POST',
        body: { keyword: category, region, count: 5, mode:S.crawlMode },
      });
      const terms = (r.terms || []).join('\n');
      logEl.textContent =
        `基础词「${category}」命中 ${r.baseHits} 条\n` +
        (r.degraded ? `DeepSeek 降级：${r.degradeReason}\n` : r.aiAttempted ? `AI 生成 ${r.expandedTerms} 个变体词\n` : '基础抓取已有结果，无需调用 DeepSeek\n') +
        `变体词额外命中 ${r.extraHits} 条\n` +
        `唯一条目 ${r.totalUnique} 条，新入池 ${r.addedToQueue} 条\n\n` +
        (terms ? `变体词列表：\n${terms}` : '（未生成变体词或基础词已有命中）');
      setText('run-state', r.degraded ? '⚠ DeepSeek 不可用，已降级为基础抓取' : r.aiSucceeded ? '✓ AI 智能发现完成' : '✓ 基础抓取完成');
      await Promise.all([loadMatrix(), loadList(), loadHealth()]);
    } catch (e) {
      setText('run-state', 'AI 发现失败：' + e.message);
    }
    S.runBusy = false;
    $('#btn-ai-expand').disabled = false;
  });
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
  // 排序按钮
  $('.ctrlbtns').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.ctrlbtn');
    if (!btn) return;
    if (btn.dataset.sort) {
      S.sort = btn.dataset.sort;
      $$('.ctrlbtns .ctrlbtn').forEach((b) => b.classList.toggle('on', b.dataset.sort === S.sort));
    }
    if (btn.id === 'btnSortDir') {
      S.sortDir = S.sortDir === 'desc' ? 'asc' : 'desc';
      btn.textContent = S.sortDir === 'desc' ? '↓' : '↑';
    }
    renderList();
  });
  // 分类选择
  $('#catFilter').addEventListener('change', (ev) => {
    S.catFilter = ev.target.value;
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

if ($('#btn-comp-next')) $('#btn-comp-next').addEventListener('click', runNextCompensation);
$$('.health-k').forEach((b) => b.addEventListener('click', () => { S.healthFilter = S.healthFilter === b.dataset.health ? '' : b.dataset.health; renderHealthList(); }));
boot();

// ── 运维：右下角浮动「停止服务」按钮（下次启动自动生效）──
(function injectStopBtn() {
  const btn = document.createElement('button');
  btn.id = 'btn-stop-server';
  btn.textContent = '停止服务';
  btn.style.cssText =
    'position:fixed;right:14px;bottom:14px;z-index:9999;padding:8px 14px;' +
    'background:#c0392b;color:#fff;border:none;border-radius:8px;font-size:13px;' +
    'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  btn.addEventListener('click', async () => {
    if (!confirm('确定停止后端服务（端口 4201）吗？停止后需重新运行启动脚本才能访问。')) return;
    try {
      const r = await fetch('/api/admin/shutdown', { method: 'POST', credentials: 'same-origin' });
      if (r.ok) {
        btn.textContent = '已停止…';
        setTimeout(() => (location.href = 'about:blank'), 600);
      } else {
        alert('停止失败：' + (await r.text()));
      }
    } catch (e) {
      alert('停止请求出错：' + e.message);
    }
  });
  document.body.appendChild(btn);
})();
});
