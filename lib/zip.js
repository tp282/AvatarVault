'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');
const path = require('path');
const { imageDimensions, vramBytes } = require('./png');
const { extOf, TEXTURE_EXT, MODEL_EXT } = require('./unitypackage');

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_Z64_LOC = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

function u64(buf, off) {
  return Number(buf.readBigUInt64LE(off));
}

/** 读 EOCD；遇到 ZIP64 时改读 ZIP64 EOCD。 */
async function readEnd(fh, stat) {
  const tailLen = Math.min(stat.size, 66000);
  const tail = await readAt(fh, stat.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  let entryCount = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // ZIP64：EOCD 字段被填成上限，真实值在 ZIP64 EOCD 里
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === SIG_Z64_LOC) {
      const z64Off = u64(tail, loc + 8);
      const z64 = await readAt(fh, z64Off, 56);
      if (z64.length >= 56 && z64.readUInt32LE(0) === SIG_Z64_EOCD) {
        entryCount = u64(z64, 32);
        cdSize = u64(z64, 40);
        cdOffset = u64(z64, 48);
      }
    }
  }
  return { entryCount, cdSize, cdOffset };
}

/** 在中央目录条目的 extra 里找 ZIP64 扩展（0x0001）。 */
function findZip64Extra(cd, start, len) {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = cd.readUInt16LE(p);
    const size = cd.readUInt16LE(p + 2);
    if (p + 4 + size > end) break;
    if (id === 0x0001) return { off: p + 4, size };
    p += 4 + size;
  }
  return null;
}

/** 读一个中央目录条目；ZIP64 的尺寸/偏移从 extra 还原。 */
function readCdEntry(cd, off) {
  if (off + 46 > cd.length || cd.readUInt32LE(off) !== SIG_CD) return null;
  const method = cd.readUInt16LE(off + 10);
  let compSize = cd.readUInt32LE(off + 20);
  let uncompSize = cd.readUInt32LE(off + 24);
  const nameLen = cd.readUInt16LE(off + 28);
  const extraLen = cd.readUInt16LE(off + 30);
  const commentLen = cd.readUInt16LE(off + 32);
  let localOff = cd.readUInt32LE(off + 42);
  const name = cd.toString('utf8', off + 46, off + 46 + nameLen);

  if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
    const z = findZip64Extra(cd, off + 46 + nameLen, extraLen);
    if (z) {
      let p = z.off;
      const end = z.off + z.size;
      // ZIP64 extra 顺序：未压缩大小、压缩大小、本地头偏移、磁盘号
      if (uncompSize === 0xffffffff && p + 8 <= end) { uncompSize = u64(cd, p); p += 8; }
      if (compSize === 0xffffffff && p + 8 <= end) { compSize = u64(cd, p); p += 8; }
      if (localOff === 0xffffffff && p + 8 <= end) { localOff = u64(cd, p); p += 8; }
    }
  }

  return {
    name,
    method,
    compSize,
    uncompSize,
    localOff,
    next: off + 46 + nameLen + extraLen + commentLen,
  };
}

async function readDirectory(fh, stat) {
  const end = await readEnd(fh, stat);
  const cd = await readAt(fh, end.cdOffset, Math.min(end.cdSize, 128 * 1024 * 1024));
  return { cd, entryCount: end.entryCount, cdSize: end.cdSize };
}

async function inspectZip(filePath, { onProgress } = {}) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const { cd, entryCount } = await readDirectory(fh, stat);

    const entries = [];
    let off = 0;
    for (let i = 0; i < entryCount; i++) {
      const e = readCdEntry(cd, off);
      if (!e) break;
      entries.push(e);
      off = e.next;
    }

    const names = entries.map((e) => e.name.replace(/\\/g, '/')).filter((n) => !n.endsWith('/'));

    let materials = 0, fbx = 0, textures = 0, prefabs = 0, animations = 0, vram = 0;
    for (const n of names) {
      const ext = extOf(n);
      if (ext === '.mat') materials++;
      else if (ext === '.prefab') prefabs++;
      else if (ext === '.anim' || ext === '.controller') animations++;
      else if (ext === '.fbx') fbx++;
      else if (MODEL_EXT.includes(ext)) { /* 其他模型格式 */ }
      if (TEXTURE_EXT.includes(ext)) textures++;
    }

    // 挑缩略图：优先 preview/thumb/封面，其次最大的图片
    const images = entries.filter((e) => /\.(png|jpg|jpeg|webp)$/i.test(e.name) && e.uncompSize > 0 && e.uncompSize < 12 * 1024 * 1024);
    images.sort((a, b) => {
      const score = (e) => (/preview|thumb|icon|cover|main|封面|预览/i.test(e.name) ? 1000000 : 0) + e.uncompSize;
      return score(b) - score(a);
    });

    const previews = [];
    // 显存要统计全部贴图，不能只统计前 8 张；只把排在最前的 6 张留作预览。
    for (const e of images.slice(0, 300)) {
      try {
        const data = await extractEntry(fh, e);
        if (!data) continue;
        const ext = extOf(e.name) || '.png';
        const dims = imageDimensions(data, ext === '.jpeg' ? '.jpg' : ext);
        if (dims) vram += vramBytes(dims.width, dims.height);
        if (previews.length < 6) previews.push(data);
      } catch (_) { /* 单个条目失败忽略 */ }
      if (onProgress) onProgress({ phase: 'scan' });
    }

    return {
      pathnames: names,
      previews,
      stats: {
        assetCount: names.length,
        materials,
        fbx,
        textures,
        prefabs,
        animations,
        vramMB: Math.round((vram / 1048576) * 10) / 10,
      },
    };
  } finally {
    await fh.close();
  }
}

async function extractEntry(fh, e) {
  const lh = await readAt(fh, e.localOff, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== SIG_LOCAL) return null;
  const nameLen = lh.readUInt16LE(26);
  const extraLen = lh.readUInt16LE(28);
  const dataStart = e.localOff + 30 + nameLen + extraLen;
  const raw = await readAt(fh, dataStart, e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  return null;
}

/** Windows 不允许的字符 / 保留名 / 结尾点空格，统一换成下划线。 */
function safeComponent(s) {
  let out = String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!out || out === '.' || out === '..') out = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) out = '_' + out;
  if (out.length > 100) {
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : '';
    out = out.slice(0, Math.max(1, 100 - ext.length)) + ext;
  }
  return out;
}

/** 解压整个 zip 到目录（用于导入备份）。nameMap 会记录被清洗过的路径。 */
async function extractZipAll(filePath, outDir, onProgress, nameMap) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const { cd, entryCount } = await readDirectory(fh, stat);

    let off = 0;
    for (let i = 0; i < entryCount; i++) {
      const e = readCdEntry(cd, off);
      if (!e) break;
      off = e.next;
      let name = e.name.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
      if (name.endsWith('/')) continue;
      const parts = name.split('/');
      if (parts.some((p) => p === '..')) continue;

      const safeParts = parts.map(safeComponent);
      const safeName = safeParts.join('/');
      if (nameMap && safeName !== name) nameMap.set(name, safeName);

      const target = path.join(outDir, ...safeParts);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const data = await extractEntry(fh, e);
      if (data) await fsp.writeFile(target, data);
      if (onProgress) onProgress({ name, index: i + 1, total: entryCount });
    }
  } finally {
    await fh.close();
  }
}

/** 只读取条目名，用于判断一个 zip 是不是 AvatarVault 备份 */
async function listZipNames(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const { cd, entryCount } = await readDirectory(fh, stat);
    const names = [];
    let off = 0;
    for (let i = 0; i < entryCount; i++) {
      const e = readCdEntry(cd, off);
      if (!e) break;
      names.push(e.name);
      off = e.next;
    }
    return names;
  } catch (_) {
    return [];
  } finally {
    await fh.close();
  }
}

module.exports = { inspectZip, extractZipAll, listZipNames };
