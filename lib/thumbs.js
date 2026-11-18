'use strict';
/**
 * 多档缩略图缓存。
 * - 原图永远不动，只生成派生图；
 * - 优先 sharp（WebP，质量/体积最好）；打包环境里 sharp 不可用时退回 Electron nativeImage（JPEG/PNG）；
 * - 缓存按“库根 + 条目 + 文件名 + 源 mtime + 档位”命名，源图变了自动换新文件；
 * - 并发限制 2，避免一次滚动把 CPU 打满。
 */
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* 走 nativeImage 兜底 */ }
let nativeImage = null;
try { nativeImage = require('electron').nativeImage; } catch (_) { /* 纯 Node 测试环境 */ }

const VARIANTS = {
  micro: 32,
  grid320: 320,
  grid640: 640,
  detail: 1280,
};

const MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

const queue = { active: 0, limit: 2, tasks: [] };
const inflight = new Map();

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.tasks.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (queue.active < queue.limit && queue.tasks.length) {
    const job = queue.tasks.shift();
    queue.active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        queue.active -= 1;
        pump();
      });
  }
}

function libKey(root) {
  return crypto.createHash('sha1').update(String(root || '')).digest('hex').slice(0, 16);
}

function safeBase(name) {
  const base = path.basename(String(name || 'thumb'));
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(0, 60);
  return cleaned || 'thumb';
}

function extFor(variant, src) {
  if (sharp) return '.webp';
  // nativeImage 兜底：PNG 保留透明，其余用 JPEG
  const srcExt = path.extname(String(src || '')).toLowerCase();
  return srcExt === '.png' ? '.png' : '.jpg';
}

function mimeFor(file) {
  return MIME[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

function variantWidth(variant) {
  return VARIANTS[variant] || VARIANTS.grid640;
}

async function variantTarget(src, opts, variant) {
  const st = await fsp.stat(src);
  const dir = path.join(String(opts.userData), 'thumb-cache', libKey(opts.root), String(opts.id));
  const base = safeBase(opts.name || src);
  const ext = extFor(variant, src);
  const file = path.join(dir, `${base}_${Math.round(st.mtimeMs)}_${variant}${ext}`);
  return { st, dir, file };
}

async function generate(src, dest, variant) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  const width = variantWidth(variant);
  if (sharp) {
    const buf = await sharp(src, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: variant === 'micro' ? 50 : (variant === 'detail' ? 84 : 80), effort: 4 })
      .toBuffer();
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
    return;
  }
  if (nativeImage) {
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('图片解码失败');
    const size = img.getSize();
    const scale = Math.min(1, width / Math.max(size.width || 1, size.height || 1));
    const resized = scale < 1
      ? img.resize({ width: Math.max(1, Math.round(size.width * scale)), quality: 'good' })
      : img;
    const buf = dest.toLowerCase().endsWith('.png') ? resized.toPNG() : resized.toJPEG(82);
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
    return;
  }
  throw new Error('没有可用的图片处理后端');
}

/** 返回 { file, mime, original? }；variant 为 orig 时直接返回源文件。 */
async function ensureVariant(src, opts, variant) {
  const v = String(variant || 'grid640');
  if (v === 'orig') return { file: src, mime: mimeFor(src), original: true };
  if (!VARIANTS[v]) return ensureVariant(src, opts, 'grid640');

  const target = await variantTarget(src, opts, v);
  try {
    await fsp.access(target.file);
    return { file: target.file, mime: mimeFor(target.file) };
  } catch (_) { /* 需要生成 */ }

  const key = `${target.file}|${target.st.mtimeMs}|${target.st.size}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = enqueue(async () => {
    try {
      await fsp.access(target.file);
    } catch (_) {
      await generate(src, target.file, v);
    }
    return { file: target.file, mime: mimeFor(target.file) };
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 新图入库后预热三档，不阻塞调用方。 */
function prefetch(src, opts) {
  if (!src) return;
  for (const v of ['micro', 'grid640', 'detail']) {
    ensureVariant(src, opts, v).catch(() => { /* ignore */ });
  }
}

/** 首次打开库时预热前 N 张卡片的网格图，首屏更快。 */
function warmup(root, userData, items, limit = 80) {
  let n = 0;
  for (const it of items || []) {
    if (n >= limit) break;
    const file = (it.customThumbs || [])[0];
    if (!file) continue;
    n += 1;
    const src = path.join(root, 'prev', it.id, path.basename(file));
    const opts = { root, userData, id: it.id, name: file };
    ensureVariant(src, opts, 'micro').catch(() => {});
    ensureVariant(src, opts, 'grid640').catch(() => {});
  }
}

/** 清理缓存目录里过旧的派生图，按 mtime 从旧到新删，直到低于上限。 */
async function trimCache(userData, maxBytes = 4 * 1024 * 1024 * 1024) {
  const root = path.join(String(userData), 'thumb-cache');
  let dirs = [];
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return; }
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let kids = [];
    try { kids = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const k of kids) {
      if (!k.isDirectory()) continue;
      const p = path.join(dir, k.name);
      let names = [];
      try { names = await fsp.readdir(p, { withFileTypes: true }); } catch (_) { continue; }
      for (const f of names) {
        if (!f.isFile()) continue;
        const full = path.join(p, f.name);
        try { files.push({ full, st: await fsp.stat(full) }); } catch (_) { /* ignore */ }
      }
    }
  }
  let total = files.reduce((a, f) => a + f.st.size, 0);
  if (total <= maxBytes) return;
  files.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  for (const f of files) {
    if (total <= maxBytes) break;
    try { await fsp.rm(f.full, { force: true }); total -= f.st.size; } catch (_) { /* ignore */ }
  }
}

module.exports = {
  VARIANTS,
  ensureVariant,
  prefetch,
  warmup,
  trimCache,
  mimeFor,
  libKey,
  hasSharp: () => !!sharp,
};
