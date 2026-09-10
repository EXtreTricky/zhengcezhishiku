'use strict';

/**
 * 飞书多维表格（Bitable）OpenAPI 直连客户端
 *
 * 背景：policy-kb 原通过秒搭平台插件（@official-plugins/feishu-bitable）读写多维表格；
 * 迁到自建服务器后改为「自建应用身份」直连飞书 OpenAPI。本模块提供与 policy-kb
 * BitableService 对齐的原子能力（listFields / listAllRecords / batchCreate /
 * batchUpdate / testConnection），后续可作为其 drop-in 数据通道。
 *
 * 鉴权：tenant_access_token（POST /open-apis/auth/v3/tenant_access_token/internal），
 * 内存缓存至过期前 120s 自动刷新。
 *
 * 依赖环境变量（与 SSO 同一自建应用即可，需在飞书后台开通多维表格权限）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET
 *   权限范围至少含：bitable:app（读文档）、按需 bitable:app:readonly；
 *   并在多维表格「协作者」里把该应用加为「可编辑」，否则 91403/权限类报错。
 *
 * 说明（字段/值形态）：
 *   - records 接口返回的 fields 以「中文列名」为 key（区别于平台插件返回 fldxxx）。
 *   - 单元格值：文本/数字为原始量；单选=字符串；多选/人员/附件=对象数组；
 *     日期(datetime/date)为毫秒时间戳（number）；公式=计算后的值。
 *   - 写入时（batchCreate/batchUpdate）fields 用中文列名：文本/数字直接给；
 *     单选给选项名；多选给字符串数组；日期给毫秒时间戳。
 */

const FEISHU_BASE = 'https://open.feishu.cn';

const FEISHU_HTTP_TIMEOUT_MS = Math.max(3000, parseInt(process.env.FEISHU_HTTP_TIMEOUT_MS || '12000', 10) || 12000);

async function fetchWithTimeout(url, options = {}, timeoutMs = FEISHU_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort|timeout/i.test(String(e.message || '')))) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${String(url)}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 与 policy-kb bitable.service.ts 的 POLICY_SOURCES 对齐：十类政策专题表 */
const POLICY_SOURCES = [
  { category: '最低工资', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tbl6zo6GH73o7HCo', viewId: 'vewYtzY205' },
  { category: '平均工资', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblYOIHK197irNrU', viewId: 'vewYtzY205' },
  { category: '公积金', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblkBIk3hsAJI2f1', viewId: 'vewYtzY205' },
  { category: '年金', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblCx9McD76MMuHM', viewId: 'vewYtzY205' },
  { category: '大病医疗', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblRusUfXr3l9H3f', viewId: 'vewTypk3EJ' },
  { category: '高温津贴', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblibNKtoMEvDzLn', viewId: 'vewYtzY205' },
  { category: '残疾职工', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tbloaPh7Ibkcya1F', viewId: 'vewYtzY205' },
  { category: '婚育相关', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblrqb41cSWg5AAd', viewId: 'vewYtzY205' },
  { category: '病假工资', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblPhHiWxKkMUl28', viewId: 'vewYtzY205' },
  { category: '薪酬月刊', appToken: 'PTRkbDSiWa4Xmts0rStcaS2Ynbe', tableId: 'tblW6cBMQNXgbISR', viewId: 'vewDfXjRIJ' },
];

/** policy-crawler 爬虫汇总表（独立底座，非正式数据源，按需读取） */
const CRAWL_SUMMARY_TABLE = {
  appToken: 'CulNbDPMkaiuiNs10u8cY6Uenbd',
  tableId: 'tblWaFr1oX0Tg6tt',
};

class FeishuApiError extends Error {
  constructor(code, msg, logId, status) {
    super(`飞书接口报错 code=${code} msg=${msg || '未知'}${logId ? ` logId=${logId}` : ''}（HTTP ${status}）`);
    this.name = 'FeishuApiError';
    this.code = code;
    this.feishuMsg = msg;
    this.logId = logId;
    this.status = status;
  }
}

class BitableClient {
  constructor({ appId, appSecret, base = FEISHU_BASE, logger = console } = {}) {
    if (!appId || !appSecret) {
      throw new Error('BitableClient 需要 appId/appSecret（环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET）');
    }
    this.appId = appId;
    this.appSecret = appSecret;
    this.base = base.replace(/\/$/, '');
    this.logger = logger;
    this._token = null;
    this._tokenExpireAt = 0;
  }

  // ── 鉴权 ────────────────────────────────────────────────

  async _ensureToken() {
    // 提前 120s 视为过期，避免临界点用上刚过期的 token
    if (this._token && this._tokenExpireAt > Date.now() + 120_000) return this._token;
    const url = new URL('/open-apis/auth/v3/tenant_access_token/internal', this.base);
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`获取 tenant_access_token 失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new FeishuApiError(json.code, json.msg, json.log_id, res.status);
    }
    this._token = json.tenant_access_token;
    // expire 单位秒
    this._tokenExpireAt = Date.now() + (json.expire > 0 ? json.expire * 1000 : 7200_000);
    return this._token;
  }

  async _request(method, pathname, { query, body } = {}) {
    const token = await this._ensureToken();
    const url = new URL(pathname, this.base);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          // field_names 等可传数组 -> 重复参数
          if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
          else url.searchParams.set(k, v);
        }
      }
    }
    const res = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`飞书返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    if (json.code !== 0) {
      throw new FeishuApiError(json.code, json.msg, json.log_id, res.status);
    }
    return json.data;
  }

  // ── 字段 ────────────────────────────────────────────────

  /** 拉取某表全部字段，返回 [{ id: 'fldxxx', name: '中文列名', type, property }] */
  async listFields(appToken, tableId) {
    const all = [];
    let pageToken = '';
    do {
      const data = await this._request('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        query: { page_size: 100, page_token: pageToken },
      });
      if (data.items) all.push(...data.items);
      pageToken = data.has_more ? data.page_token : '';
    } while (pageToken);
    // 规范化为 { id, name, type, ui_type, property }（OpenAPI 原文是 field_id/field_name）
    return all.map((f) => ({
      id: f.field_id,
      name: f.field_name,
      type: f.type,
      ui_type: f.ui_type,
      property: f.property,
    }));
  }

  // ── 记录 ────────────────────────────────────────────────

  /** 单页记录。返回 { items, total, has_more, page_token } */
  async listRecordsPage(appToken, tableId, { pageSize = 500, pageToken, viewId, fieldNames } = {}) {
    const query = { page_size: pageSize, page_token: pageToken, view_id: viewId };
    if (fieldNames && fieldNames.length) query.field_names = fieldNames;
    return this._request('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, { query });
  }

  /**
   * 全量拉取某表记录（自动翻页）。
   * @param {object} [opts] { viewId, fieldNames, onPage(items, pageIndex) }
   * @returns {Promise<Array<{record_id, fields}>>}
   */
  async listAllRecords(appToken, tableId, { viewId, fieldNames, onPage } = {}) {
    const all = [];
    let pageToken = '';
    let pageIndex = 0;
    do {
      const data = await this.listRecordsPage(appToken, tableId, {
        pageSize: 500,
        pageToken,
        viewId,
        fieldNames,
      });
      const items = data.items || [];
      all.push(...items);
      if (onPage) await onPage(items, pageIndex, data.total);
      pageToken = data.has_more ? data.page_token : '';
      pageIndex += 1;
    } while (pageToken);
    return all;
  }

  /**
   * 批量新增记录。
   * @param {Array<{ fields: Record<string, unknown> }>} records fields 以中文列名为 key
   * @returns {Promise<{ created: number, records: Array<{record_id}> }>}
   */
  async batchCreate(appToken, tableId, records) {
    const data = await this._request('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
      body: { records },
    });
    return { created: (data.records || []).length, records: data.records || [] };
  }

  /**
   * 批量更新记录。
   * @param {Array<{ record_id: string, fields: Record<string, unknown> }>} records
   * @returns {Promise<{ updated: number, records: Array<{record_id}> }>}
   */
  async batchUpdate(appToken, tableId, records) {
    const data = await this._request('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`, {
      body: { records },
    });
    return { updated: (data.records || []).length, records: data.records || [] };
  }

  /**
   * 批量删除记录（部署自检的写权限探测会用到：建一条再删掉）。
   * @param {string[]} recordIds
   * @returns {Promise<{ deleted: number }>}
   */
  async batchDelete(appToken, tableId, recordIds) {
    const data = await this._request('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, {
      body: { records: recordIds },
    });
    return { deleted: (data.records || []).length };
  }

  /** 连接测试：拉 1 条记录验证表可访问，返回 { success, message, recordCount } */
  async testConnection(appToken, tableId) {
    try {
      const data = await this.listRecordsPage(appToken, tableId, { pageSize: 1 });
      const total = typeof data.total === 'number' ? data.total : (data.items || []).length;
      return { success: true, message: `连接成功，共 ${total} 条记录`, recordCount: total };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `连接失败: ${msg}` };
    }
  }
}

// ── 单元格值归一化工具 ──────────────────────────────────────

/** 毫秒时间戳 -> 'YYYY-MM-DD'（本地时区）；非数字原样返回 */
function msToDateText(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v == null ? '' : String(v);
  if (v < 10_000_000_000) return String(v); // 秒级/异常值不做猜测
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把多维表格单元格值归一化为「展示文本」 */
function cellToText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x == null) return '';
        if (typeof x === 'string' || typeof x === 'number') return String(x);
        if (typeof x === 'object') {
          // 人员 {id,name,...} / 附件 {name,url,...} / 链接 {text,link} / 关联记录等
          const parts = [];
          if (x.text != null) parts.push(String(x.text));
          if (x.name != null) parts.push(String(x.name));
          if (parts.length === 0) {
            if (x.link != null) parts.push(String(x.link));
            else if (x.url != null) parts.push(String(x.url));
          }
          return parts.join(' ');
        }
        return String(x);
      })
      .filter((s) => s.trim())
      .join(', ');
  }
  if (typeof v === 'object') {
    const parts = [];
    if (v.text != null) parts.push(String(v.text));
    if (v.name != null) parts.push(String(v.name));
    if (parts.length === 0) {
      if (v.link != null) parts.push(String(v.link));
      if (v.url != null) parts.push(String(v.url));
      if (v.record_ids != null) parts.push(String(v.record_ids.join(',')));
    }
    return parts.join(' ');
  }
  return String(v);
}

/** 便捷：构造一个已配置好的客户端（供脚本/路由复用） */
function fromEnv(env = process.env, logger = console) {
  return new BitableClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    logger,
  });
}

module.exports = {
  FEISHU_BASE,
  BitableClient,
  FeishuApiError,
  POLICY_SOURCES,
  CRAWL_SUMMARY_TABLE,
  msToDateText,
  cellToText,
  fromEnv,
};
