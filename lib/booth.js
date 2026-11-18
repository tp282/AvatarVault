'use strict';
/**
 * BOOTH 商品信息抓取（只读公开页面）。
 *
 * 思路来自 KonoAsset 的开源实现：不解析商品 HTML，而是请求 BOOTH 自己页面用的
 * /ja/items/<id>.json，拿到 name / shop / images / category，再下载首图。
 * 图片域名只允许 booth.pximg.net，避免把备注里的任意链接变成 SSRF/下载入口。
 */
const https = require('https');
const fsp = require('fs/promises');
const path = require('path');

const UA = 'AvatarVault/0.2.6';
const JSON_MAX = 4 * 1024 * 1024;
const IMAGE_MAX = 12 * 1024 * 1024;
const CACHE_MS = 60 * 1000;
const cache = new Map();

function isBoothHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'booth.pm' || h.endsWith('.booth.pm');
}

function isPximgHost(host) {
  return String(host || '').toLowerCase() === 'booth.pximg.net';
}

/**
 * 从一段备注里找第一个 BOOTH 商品链接。
 * 支持：
 *   https://booth.pm/ja/items/6641548
 *   https://booth.pm/items/6641548
 *   https://silolab.booth.pm/items/6641548
 * 只认 https，避免 http 跳转和明文请求。
 */
function extractBoothLink(text) {
  const s = String(text || '');
  const re = /https:\/\/[^\s<>"'`]+/gi;
  let m;
  while ((m = re.exec(s))) {
    let raw = m[0].replace(/[)\].,，。；;、]+$/g, '');
    let u;
    try { u = new URL(raw); } catch (_) { continue; }
    if (u.protocol !== 'https:') continue;
    if (!isBoothHost(u.hostname)) continue;
    const hit = u.pathname.match(/^\/(?:[a-z-]{2,5}\/)?items\/(\d+)(?:\/)?$/i);
    if (!hit) continue;
    return {
      itemId: Number(hit[1]),
      url: `https://booth.pm/ja/items/${Number(hit[1])}`,
    };
  }
  return null;
}

function requestBuffer(url, opts = {}) {
  const maxBytes = opts.maxBytes || JSON_MAX;
  const timeout = opts.timeout || 8000;
  const headers = {
    'User-Agent': UA,
    'Accept': opts.accept || 'application/json',
    'Accept-Encoding': 'identity',
    ...(opts.headers || {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    };

    const go = (target, redirectsLeft) => {
      let u;
      try { u = new URL(target); } catch (_) { return done(new Error('链接格式不正确')); }
      if (u.protocol !== 'https:') return done(new Error('只支持 https 链接'));

      const req = https.get(u, { headers }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return done(new Error('重定向次数过多'));
          return go(new URL(res.headers.location, u).href, redirectsLeft - 1);
        }
        if (status !== 200) {
          res.resume();
          return done(new Error(`BOOTH 返回 HTTP ${status}`));
        }
        const len = Number(res.headers['content-length'] || 0);
        if (len && len > maxBytes) {
          res.destroy();
          return done(new Error('内容超过大小限制'));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            done(new Error('内容超过大小限制'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (!settled) done(null, { buffer: Buffer.concat(chunks), headers: res.headers });
        });
        res.on('error', (err) => done(err));
      });

      req.on('error', (err) => done(err));
      req.setTimeout(timeout, () => {
        req.destroy(new Error('BOOTH 请求超时'));
      });
    };

    go(url, 3);
  });
}

function parseBoothPayload(data, fallbackId) {
  if (!data || typeof data !== 'object') throw new Error('BOOTH 返回内容不是商品数据');
  const id = Number(data.id) || Number(fallbackId) || 0;
  const name = String(data.name || '').trim();
  if (!id || !name) throw new Error('BOOTH 商品信息不完整');
  const images = Array.isArray(data.images)
    ? data.images.map((i) => String((i && i.original) || '')).filter(Boolean)
    : [];
  const category = data.category && typeof data.category === 'object'
    ? { id: Number(data.category.id) || 0, name: String(data.category.name || '') }
    : null;
  return {
    id,
    name,
    shop: String((data.shop && data.shop.name) || ''),
    images,
    category,
  };
}

async function fetchItem(itemId, opts = {}) {
  const id = Number(itemId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('BOOTH 商品 ID 不正确');

  const cached = cache.get(id);
  if (cached && cached.until > Date.now()) return cached.data;

  const res = await requestBuffer(`https://booth.pm/ja/items/${id}.json`, {
    maxBytes: JSON_MAX,
    timeout: opts.timeout || 8000,
    accept: 'application/json',
  });
  let data;
  try { data = JSON.parse(res.buffer.toString('utf8')); } catch (_) {
    throw new Error('BOOTH 返回的商品数据无法解析');
  }
  const info = parseBoothPayload(data, id);
  cache.set(id, { until: Date.now() + CACHE_MS, data: info });
  return info;
}

function imageExt(contentType, urlPath) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const byType = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[type];
  if (byType) return byType;
  const ext = path.extname(String(urlPath || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
    return ext === '.jpeg' ? '.jpg' : ext;
  }
  return '.jpg';
}

/**
 * 下载商品首图到 prev/<id>/ 下，返回写入的文件名。
 * 只允许 https://booth.pximg.net，且大小有上限。
 */
async function downloadImage(imageUrl, destDir, fileBase) {
  let u;
  try { u = new URL(imageUrl); } catch (_) { throw new Error('商品图片链接不正确'); }
  if (u.protocol !== 'https:' || !isPximgHost(u.hostname)) {
    throw new Error('商品图片域名不在允许范围内');
  }
  if (!/^booth_\d+$/.test(String(fileBase || ''))) throw new Error('图片文件名不正确');

  const res = await requestBuffer(u.href, {
    maxBytes: IMAGE_MAX,
    timeout: 12000,
    accept: 'image/*',
  });
  const type = String(res.headers['content-type'] || '').toLowerCase();
  if (type && !type.startsWith('image/')) throw new Error('返回的不是图片');
  const ext = imageExt(type, u.pathname);
  const fileName = `${fileBase}${ext}`;
  await fsp.mkdir(destDir, { recursive: true });
  const finalPath = path.join(destDir, fileName);
  const tmp = path.join(destDir, `.${fileName}.tmp`);
  await fsp.writeFile(tmp, res.buffer);
  // Windows 上目标已存在时，rename 有可能失败；先删旧文件再原子替换
  await fsp.rm(finalPath, { force: true });
  await fsp.rename(tmp, finalPath);
  return { fileName, bytes: res.buffer.length };
}

module.exports = {
  UA,
  extractBoothLink,
  parseBoothPayload,
  fetchItem,
  downloadImage,
  isBoothHost,
  isPximgHost,
};
