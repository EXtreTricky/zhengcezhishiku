'use strict';

const MODES = Object.freeze({ INITIAL: 'initial', DAILY: 'daily' });

function normalizeCrawlMode(value) {
  return String(value || '').toLowerCase() === MODES.INITIAL ? MODES.INITIAL : MODES.DAILY;
}

function shanghaiDate(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((x) => x.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizePublishedDate(value) {
  const raw = String(value || '').trim();
  const match = /^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(raw);
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  return '';
}

function queueDecision(item, mode = MODES.DAILY, now = Date.now()) {
  const normalizedMode = normalizeCrawlMode(mode);
  if (normalizedMode === MODES.INITIAL) return { accept: true, reason: 'initial_history_allowed' };
  const published = normalizePublishedDate(item?.releaseDate || item?.publishDate);
  if (!published) return { accept: false, reason: 'missing_publish_date' };
  const today = shanghaiDate(now);
  return published === today
    ? { accept: true, reason: 'published_today', published, today }
    : { accept: false, reason: 'not_published_today', published, today };
}

function taskState(status) {
  const value = String(status || 'todo');
  if (value === 'done') return 'done';
  if (value === 'error' || value === 'failed') return 'failed';
  if (value === 'paused') return 'paused';
  if (value === 'running') return 'running';
  return 'pending';
}

function summarizeTasks(tasks = []) {
  const summary = { total: tasks.length, running: 0, done: 0, failed: 0, pending: 0, paused: 0 };
  for (const task of tasks) summary[taskState(task.status)] += 1;
  return summary;
}

module.exports = { MODES, normalizeCrawlMode, shanghaiDate, normalizePublishedDate, queueDecision, taskState, summarizeTasks };
