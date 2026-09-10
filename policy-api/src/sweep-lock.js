'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_PATH = path.join(__dirname, '..', '..', 'data', '.sweep.lock');
const STOP_PATH = path.join(__dirname, '..', '..', 'data', '.sweep.stop.json');
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    const data = JSON.parse(raw);
    return { ...data, path: LOCK_PATH };
  } catch (_) {
    return null;
  }
}

function clearStaleLock(staleMs = DEFAULT_STALE_MS) {
  const lock = readLock();
  if (!lock) return false;
  const started = Date.parse(lock.startedAt || '');
  const staleByAge = Number.isFinite(started) && Date.now() - started > staleMs;
  const staleByPid = !pidAlive(lock.pid);
  if (!staleByAge && !staleByPid) return false;
  try { fs.unlinkSync(LOCK_PATH); return true; } catch (_) { return false; }
}

function clearStopRequest() {
  try { fs.unlinkSync(STOP_PATH); return true; } catch (_) { return false; }
}

function requestSweepStop(meta = {}) {
  fs.mkdirSync(path.dirname(STOP_PATH), { recursive: true });
  const lock = readLock();
  const payload = {
    pid: Number(meta.pid || lock?.pid || 0) || 0,
    requestedAt: new Date().toISOString(),
    requestedBy: meta.requestedBy || 'api',
    reason: meta.reason || 'manual_stop',
  };
  fs.writeFileSync(STOP_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function isSweepStopRequested(pid = process.pid) {
  try {
    const data = JSON.parse(fs.readFileSync(STOP_PATH, 'utf8'));
    return !data.pid || Number(data.pid) === Number(pid) ? data : null;
  } catch (_) { return null; }
}

function acquireSweepLock(meta = {}) {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  clearStaleLock();
  // 新一轮开始前清理旧的停止请求，避免上一次 stop 误伤新任务。
  clearStopRequest();
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    owner: meta.owner || 'sweep',
    region: meta.region || '',
    category: meta.category || '',
  };
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
    fs.closeSync(fd);
    let released = false;
    return {
      ok: true,
      payload,
      release() {
        if (released) return;
        released = true;
        try {
          const cur = readLock();
          if (!cur || Number(cur.pid) === process.pid) fs.unlinkSync(LOCK_PATH);
        } catch (_) {}
        clearStopRequest();
      },
    };
  } catch (e) {
    if (e && e.code === 'EEXIST') return { ok: false, lock: readLock() };
    throw e;
  }
}

function getSweepLockStatus() {
  clearStaleLock();
  const lock = readLock();
  return { locked: !!lock, lock };
}

module.exports = { LOCK_PATH, STOP_PATH, acquireSweepLock, getSweepLockStatus, clearStaleLock, pidAlive, requestSweepStop, isSweepStopRequested, clearStopRequest };
