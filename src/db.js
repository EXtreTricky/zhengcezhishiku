'use strict';
/**
 * db.js — 自建版政策知识库的文档型存储层（零依赖，JSON 落盘）
 *
 * 设计取舍：
 *  - 单机自部署 / 演示 / 中小规模（数千条政策）下足够，原子写盘、防并发损坏；
 *  - 后续可平滑迁移到 SQLite/Postgres（所有读写都收敛在本文件的 store 帮助函数里）。
 *  - 数据底座与飞书多维表格解耦：需要与多维表格双向同步时，另接 adapter（见 README）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let _db = null;

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}
function nowIso() {
  return new Date().toISOString();
}
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 深拷贝（结构化数据均为 JSON 安全类型） */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function emptyDb() {
  return {
    meta: { version: 1, createdAt: nowIso(), updatedAt: nowIso() },
    seq: { policy: 1 },
    config: {
      sources: [
        { name: '国家统计局', level: '中央', region: '全国', url: 'http://www.stats.gov.cn', type: '统计局', scope: '统计数据公报/平均工资', freq: '每周', enabled: true },
        { name: '人力资源社会保障部', level: '中央', region: '全国', url: 'http://www.mohrss.gov.cn', type: '人社', scope: '最低工资/假期/劳动用工', freq: '每周', enabled: true },
        { name: '住房和城乡建设部(公积金监管)', level: '中央', region: '全国', url: 'http://www.mohurd.gov.cn', type: '公积金', scope: '公积金缴存政策', freq: '每周', enabled: true },
        { name: '国家税务总局', level: '中央', region: '全国', url: 'http://www.chinatax.gov.cn', type: '税务', scope: '个税/专项附加扣除/汇算清缴', freq: '每周', enabled: true },
        { name: '国家医疗保障局', level: '中央', region: '全国', url: 'http://www.nhsa.gov.cn', type: '医保', scope: '生育保险/产假待遇', freq: '每周', enabled: true },
        { name: '北京市人力资源和社会保障局', level: '省/市', region: '北京', url: 'http://rsj.beijing.gov.cn', type: '人社', scope: '北京最低工资/平均工资', freq: '每日', enabled: true },
        { name: '上海市人力资源和社会保障局', level: '省/市', region: '上海', url: 'http://rsj.sh.gov.cn', type: '人社', scope: '上海最低工资/平均工资', freq: '每日', enabled: true },
        { name: '广东省人力资源和社会保障厅', level: '省/市', region: '广东', url: 'http://hrss.gd.gov.cn', type: '人社', scope: '广东最低工资', freq: '每日', enabled: true },
        { name: '深圳市人力资源和社会保障局', level: '省/市', region: '深圳', url: 'http://hrss.sz.gov.cn', type: '人社', scope: '深圳最低工资/社保', freq: '每日', enabled: true },
        { name: '北京市住房公积金管理中心', level: '省/市', region: '北京', url: 'http://gjj.beijing.gov.cn', type: '公积金', scope: '北京公积金缴存基数/上限', freq: '每周', enabled: true },
      ],
      crawlIntervalMin: 0, // 0=不自动，>0 则按分钟定时
      riskFieldKeywords: ['金额', '比例', '标准', '基数', '上限', '下限', '日期', '生效', '失效', '口径', '包含', '是否', '免税', '起征', '费率', '天数'],
      reviewers: [], // 飞书姓名列表，空=所有经理角色
      openai: { baseUrl: '', apiKey: '', model: '' },
    },
    policies: [],
    versions: [],
    intakes: [],
    modifications: [],
    feedbacks: [],
    reviews: [],        // 审核中心（pending→reviewing→approved/rejected/returned）
    subscriptions: [],  // 订阅偏好（登录用户维度）
    crawlQueue: [],     // 采集待确认池（原版 Bitable 汇总表 403 时的自建替代容器）
    syncOutbox: [],     // 待同步写操作（Bitable 写权限就绪后自动/手动推送）
    audits: [],
    crawlRuns: [],
  };
}

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      _db = JSON.parse(raw);
      // 防御性补全：旧版本 db.json 可能缺新集合 / config 子键
      const base = emptyDb();
      for (const k of Object.keys(base)) {
        if (!(k in _db)) _db[k] = base[k];
      }
      if (!_db.config) _db.config = base.config;
      for (const k of Object.keys(base.config)) {
        if (!(k in _db.config)) _db.config[k] = base.config[k];
      }
      return _db;
    }
  } catch (err) {
    // 损坏时重建（保留备份）
    try {
      fs.copyFileSync(DB_FILE, DB_FILE + '.bak-' + Date.now());
    } catch (_) {}
  }
  _db = emptyDb();
  save();
  return _db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db.meta.updatedAt = nowIso();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

/** 让外部模块拿到当前 db 引用（只读使用）；所有写操作后必须调 save() */
function getDb() {
  return load();
}
/**
 * 丢弃进程内快照并重新从磁盘读取。
 * 场景：长驻 server 用子进程跑 sweep-crawl（独立进程各自持有内存态、退出时全量落盘），
 * 子进程结束后必须 reload 才能看到它新增/修改的 crawlQueue / crawlTasks，
 * 否则 server 下一次 save() 会用旧内存态把子进程的写入覆盖掉。
 */
function reload() {
  _db = null;
  return load();
}
function reset() {
  _db = emptyDb();
  save();
  return _db;
}

// ─── 通用列表分页/过滤 ──────────────────────────────────────────────
function paginate(items, page = 1, pageSize = 20) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const total = items.length;
  const start = (page - 1) * pageSize;
  return {
    items: clone(items.slice(start, start + pageSize)),
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
  };
}

module.exports = { load, save, reset, reload, getDb, uid, nowIso, daysFromNow, clone, paginate };
