'use strict';

function messageOf(error) {
  return String(error?.message || error?.msg || error || '未知错误').trim();
}

function classifyBitableFailure(error) {
  const message = messageOf(error);
  const code = String(error?.code ?? error?.statusCode ?? error?.response?.status ?? '');
  const text = `${code} ${message}`.toLowerCase();

  if (/timeout|timed out|econnreset|econnrefused|enotfound|eai_again|fetch failed|network|socket|429|rate.?limit|频率|超时|网络/.test(text)) {
    return { kind: 'temporary', retryable: true, code, message };
  }
  if (/401|403|forbidden|permission|access denied|99991672|99991663|无权限|未授权|权限/.test(text)) {
    return { kind: 'permission', retryable: true, code, message };
  }
  if (/400|invalid|field|type|option|validation|schema|字段|格式|类型|选项/.test(text)) {
    return { kind: 'validation', retryable: false, code, message };
  }
  if (/404|not found|不存在/.test(text)) {
    return { kind: 'not_found', retryable: false, code, message };
  }
  // Preserve approved records on unknown upstream failures and retry them later.
  return { kind: 'unknown', retryable: true, code, message };
}

module.exports = { classifyBitableFailure };
