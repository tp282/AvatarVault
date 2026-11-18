'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { inspectUnityPackage } = require('./unitypackage');
const { inspectZip } = require('./zip');
const { classify, CATEGORY_LABEL } = require('./classify');
const { imageDimensions, vramBytes } = require('./png');
const { extOf, TEXTURE_EXT, MODEL_EXT } = require('./unitypackage');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function detectImageExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}

async function hashFile(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let read = 0;
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => {
      h.update(chunk);
      read += chunk.length;
      if (onProgress && read % (8 * 1048576) < chunk.length) onProgress({ phase: 'hash', bytes: read });
    });
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

async function hashFolder(dir) {
  const names = [];
  async function walk(d, depth) {
    if (depth > 6) return;
    let list;
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else {
        try {
          const st = await fsp.stat(full);
          names.push(path.relative(dir, full).replace(/\\/g, '/') + ':' + st.size);
        } catch (_) { /* ignore */ }
      }
    }
  }
  await walk(dir, 0);
  names.sort();
  return crypto.createHash('sha256').update(names.join('\n')).digest('hex');
}

async function writeThumbs(prevDir, buffers) {
  await fsp.mkdir(prevDir, { recursive: true });
  const out = [];
  for (let i = 0; i < buffers.length && i < 6; i++) {
    const ext = detectImageExt(buffers[i]);
    const name = `${i + 1}${ext}`;
    await fsp.writeFile(path.join(prevDir, name), buffers[i]);
    out.push(name); // 只存文件名，便于整库搬迁
  }
  return out;
}

async function scanFolder(dirPath, onProgress) {
  const pathnames = [];
  const images = [];
  let totalSize = 0;
  const counters = { materials: 0, fbx: 0, textures: 0, prefabs: 0, animations: 0 };
  let vram = 0;
  let fileCount = 0;

  async function walk(d, depth) {
    if (depth > 6) return;
    let list;
    try { list = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      const rel = path.relative(dirPath, full).replace(/\\/g, '/');
      pathnames.push(rel);
      fileCount++;
      let st = null;
      try { st = await fsp.stat(full); } catch (_) { continue; }
      totalSize += st.size;
      const ext = extOf(rel);
      if (ext === '.mat') counters.materials++;
      else if (ext === '.prefab') counters.prefabs++;
      else if (ext === '.anim' || ext === '.controller') counters.animations++;
      else if (ext === '.fbx') counters.fbx++;
      if (TEXTURE_EXT.includes(ext)) counters.textures++;
      if (IMAGE_EXT.includes(ext) && st.size < MAX_IMAGE_BYTES) {
        images.push({ full, rel, size: st.size, name: e.name });
        if (images.length > 200 && !/preview|thumb|icon|cover|封面/i.test(e.name)) { images.pop(); }
      }
      if (onProgress && fileCount % 50 === 0) onProgress({ phase: 'scan', files: fileCount });
    }
  }
  await walk(dirPath, 0);

  // 统计显存：只读文件头
  for (const img of images.slice(0, 300)) {
    try {
      const fh = await fsp.open(img.full, 'r');
      const head = Buffer.alloc(64);
      const { bytesRead } = await fh.read(head, 0, 64, 0);
      await fh.close();
      const dims = imageDimensions(head.subarray(0, bytesRead), extOf(img.rel));
      if (dims) vram += vramBytes(dims.width, dims.height);
    } catch (_) { /* ignore */ }
  }

  // 缩略图候选：先按 preview 权重，再按体积
  images.sort((a, b) => {
    const w = (i) => (/preview|thumb|icon|cover|main|封面|预览/i.test(i.rel) ? 1000000 : 0) + i.size;
    return w(b) - w(a);
  });

  const previews = [];
  for (const img of images.slice(0, 6)) {
    try { previews.push(await fsp.readFile(img.full)); } catch (_) { /* ignore */ }
  }

  return {
    pathnames,
    previews,
    stats: {
      assetCount: fileCount,
      ...counters,
      vramMB: Math.round((vram / 1048576) * 10) / 10,
    },
    sizeBytes: totalSize,
  };
}

function cleanName(name) {
  return name.replace(/\.(unitypackage|zip|rar|7z|fbx|obj|prefab|mat|png|jpg|jpeg|webp)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '未命名资产';
}

/**
 * 把一个外部路径处理成库条目（落盘：原件 + 缩略图）
 */
async function ingestPath(root, srcPath, { onProgress = () => {}, onNotice } = {}) {
  const stat = await fsp.stat(srcPath);
  const base = path.basename(srcPath);
  const isDir = stat.isDirectory();
  const ext = isDir ? '' : path.extname(srcPath).toLowerCase();

  const hash = isDir ? await hashFolder(srcPath) : await hashFile(srcPath, onProgress);
  const short = hash.slice(0, 12);

  let inspected;
  let kind;
  if (isDir) {
    kind = 'folder';
    inspected = await scanFolder(srcPath, onProgress);
  } else if (ext === '.unitypackage') {
    kind = 'unitypackage';
    inspected = await inspectUnityPackage(srcPath, { onProgress });
  } else if (ext === '.zip') {
    kind = 'zip';
    try {
      inspected = await inspectZip(srcPath, { onProgress });
    } catch (err) {
      if (onNotice) onNotice(`${base} 解析失败，按普通文件入库：${err.message}`);
      inspected = { pathnames: [], previews: [], stats: emptyStats() };
      kind = 'file';
    }
  } else {
    kind = 'file';
    const single = emptyStats();
    single.assetCount = 1;
    if (ext === '.mat' || ext === '.shader') single.materials = 1;
    if (ext === '.fbx') single.fbx = 1;
    if (ext === '.prefab') single.prefabs = 1;
    inspected = { pathnames: [base], previews: [], stats: single };
    if (IMAGE_EXT.includes(ext) && stat.size < MAX_IMAGE_BYTES) {
      try { inspected.previews.push(await fsp.readFile(srcPath)); } catch (_) { /* ignore */ }
    }
  }

  // 原件落库（文件夹只做引用，不复制）
  let storedPath = '';
  let refOnly = false;
  if (isDir) {
    refOnly = true;
  } else {
    const origDir = path.join(root, 'orig', short);
    await fsp.mkdir(origDir, { recursive: true });
    const abs = path.join(origDir, base);
    try { await fsp.access(abs); } catch (_) {
      await fsp.copyFile(srcPath, abs);
    }
    storedPath = path.relative(root, abs).replace(/\\/g, '/');
  }

  // 包内自带的 preview.png 不入库：只保留用户自己添加的示意图
  const thumbs = [];

  const category = classify(inspected.pathnames, base);
  const entry = {
    id: short,
    hash,
    name: cleanName(base),
    category,
    kind,
    refOnly,
    originPath: refOnly ? srcPath : '',
    storedPath,
    sizeBytes: stat.isDirectory() ? (inspected.sizeBytes || 0) : stat.size,
    stats: inspected.stats,
    thumbs,
    customThumbs: [],
    tags: [],
    favorite: false,
    notes: '',
    // 自动名；用户手动改名后 main.js 会把它标成 manual，BOOTH 抓取就不会覆盖
    nameSource: 'auto',
    addedAt: Date.now(),
    lastUsed: 0,
    categorySource: 'auto',
  };
  if (onProgress) onProgress({ phase: 'done', name: entry.name });
  return entry;
}

function emptyStats() {
  return { assetCount: 0, materials: 0, fbx: 0, textures: 0, prefabs: 0, animations: 0, vramMB: 0 };
}

/**
 * 对“已经在库里的原件”做一次统计，用于修复旧备份/手机备份里缺失或为 0 的 stats。
 * 只读文件，不复制、不改名。
 */
async function inspectStored(root, entry) {
  const rel = String((entry && entry.storedPath) || '');
  if (!rel) throw new Error('条目没有原件路径');
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const st = await fsp.stat(abs);

  if (st.isDirectory()) {
    const scanned = await scanFolder(abs, () => {});
    return { stats: scanned.stats, sizeBytes: scanned.sizeBytes };
  }

  const ext = path.extname(abs).toLowerCase();
  if (ext === '.unitypackage') {
    const inspected = await inspectUnityPackage(abs);
    return { stats: inspected.stats };
  }
  if (ext === '.zip') {
    const inspected = await inspectZip(abs);
    return { stats: inspected.stats };
  }

  // 单文件：和入库时的统计口径保持一致
  const stats = emptyStats();
  stats.assetCount = 1;
  if (ext === '.mat' || ext === '.shader') stats.materials = 1;
  if (ext === '.fbx') stats.fbx = 1;
  if (ext === '.prefab') stats.prefabs = 1;
  if (ext === '.anim' || ext === '.controller') stats.animations = 1;
  if (TEXTURE_EXT.includes(ext)) stats.textures = 1;
  if (IMAGE_EXT.includes(ext)) {
    try {
      const fh = await fsp.open(abs, 'r');
      const head = Buffer.alloc(64);
      const { bytesRead } = await fh.read(head, 0, 64, 0);
      await fh.close();
      const dims = imageDimensions(head.subarray(0, bytesRead), ext);
      if (dims) stats.vramMB = Math.round((vramBytes(dims.width, dims.height) / 1048576) * 10) / 10;
    } catch (_) { /* ignore */ }
  }
  return { stats };
}

module.exports = { ingestPath, inspectStored, cleanName, IMAGE_EXT, detectImageExt, CATEGORY_LABEL };
