/**
 * url-utils.js —— URL 规范化工具
 *
 * 搜索结果和官方枚举结果在进入审批队列前统一 canonicalize，
 * 避免同一政策因 tracking 参数、hash、大小写等差异被重复入队。
 *
 * 处理：
 *   - hash 片段（#section）
 *   - utm_* 跟踪参数
 *   - 常见 tracking 参数（spm, from, source, channel 等）
 *   - hostname 大小写
 *   - 默认端口（http:80, https:443）
 *   - 重复斜杠（//path → /path）
 *   - 尾部斜杠标准化
 */

/** 需要移除的 tracking 参数名（小写匹配） */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'spm', 'from', 'source', 'channel', 'ref', 'referer', 'referrer',
  'track', 'tracking', 'clickid', 'click_id', 'sid', 'uuid',
  'timestamp', 't', '_t', 'cb', 'cache', 'rand', 'random',
]);

/**
 * 规范化 URL
 * @param {string} raw - 原始 URL
 * @returns {string} 规范化后的 URL，无效输入返回空字符串
 */
function canonicalUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    // 尝试补全协议
    try {
      url = new URL('https://' + raw.trim());
    } catch {
      return '';
    }
  }

  // 只处理 http/https
  if (!['http:', 'https:'].includes(url.protocol)) return '';

  // hostname 小写
  url.hostname = url.hostname.toLowerCase();

  // 移除默认端口
  if ((url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  // 移除 hash
  url.hash = '';

  // 移除 tracking 参数
  const params = url.searchParams;
  const toDelete = [];
  for (const key of params.keys()) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) {
    params.delete(key);
  }

  // 重建 URL（排序参数，消除重复斜杠）
  let result = url.origin + url.pathname.replace(/\/\/+/g, '/');

  // 标准化尾部斜杠（首页保留 /，其他去掉）
  if (result.endsWith('/') && url.pathname !== '/') {
    result = result.slice(0, -1);
  }

  // 拼接剩余参数
  const remaining = url.search;
  if (remaining) {
    result += remaining;
  }

  return result;
}

/**
 * 从 URL 中提取用于去重的指纹
 * 优先用规范化 URL，降级用去掉查询参数的路径
 * @param {string} raw
 * @returns {string}
 */
function urlFingerprint(raw) {
  const canonical = canonicalUrl(raw);
  if (canonical) return canonical;
  // 降级：取路径部分
  try {
    const u = new URL(raw.includes('://') ? raw : 'https://' + raw);
    return u.pathname.replace(/\/\/+/g, '/').replace(/\/$/, '') || '/';
  } catch {
    return '';
  }
}

module.exports = { canonicalUrl, canonicalizeUrl: canonicalUrl, urlFingerprint, TRACKING_PARAMS };
