'use strict';

/**
 * 无状态会话：把登录态用 AES-256-GCM 加密后塞进 HttpOnly Cookie。
 * 之所以做成无状态，是为了能同时跑在「常驻服务器」和「云函数/Serverless」上——
 * 后者请求之间不保证同一实例，用内存 Map 存 session 会随机掉线。
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/** 加密并附过期时间，返回 base64url 字符串 */
function seal(obj, secret, ttlSeconds) {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const payload = Buffer.from(
    JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
    'utf8'
  );
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/** 解密并校验有效期；任何异常一律视为未登录 */
function open(token, secret) {
  if (!token || typeof token !== 'string') return null;
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length <= IV_LEN + TAG_LEN) return null;

    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const encrypted = raw.subarray(IV_LEN + TAG_LEN);

    const decipher = crypto.createDecipheriv(ALGO, deriveKey(secret), iv);
    decipher.setAuthTag(tag);

    const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const data = JSON.parse(json);

    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { seal, open };
