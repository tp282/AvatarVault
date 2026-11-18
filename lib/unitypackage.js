'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { scanTar } = require('./tar');
const { imageDimensions, vramBytes } = require('./png');

const TEXTURE_EXT = ['.png', '.tga', '.jpg', '.jpeg', '.psd', '.exr', '.tif', '.tiff'];
const MODEL_EXT = ['.fbx', '.obj', '.blend', '.dae'];

/**
 * 解析 .unitypackage（gzip tar），不依赖 Unity
 * 返回：pathnames / 统计 / 可用作缩略图的图片
 */
async function inspectUnityPackage(filePath, { onProgress } = {}) {
  const guids = new Map(); // guid -> { pathname, size, preview: Buffer|null, textureDims }
  let previewCount = 0;

  const getSlot = (guid) => {
    let s = guids.get(guid);
    if (!s) { s = { pathname: '', size: 0, preview: null, texture: null, isAsset: false }; guids.set(guid, s); }
    return s;
  };

  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));

  try {
    await scanTar(
      stream,
      (name, size) => {
        const parts = name.split('/');
        if (parts.length < 2) return 'skip';
        const guid = parts[0];
        const leaf = parts[1];
        if (leaf === 'pathname' && size < 4096) return 'data';
        if (leaf === 'preview.png' && size < 6 * 1024 * 1024) return 'data';
        if (leaf === 'asset' && size > 0) return 'head';
        return 'skip';
      },
      (name, buf) => {
        const [guid, leaf] = name.split('/');
        const slot = getSlot(guid);
        if (leaf === 'pathname') {
          slot.pathname = buf.toString('utf8').trim().split('\n')[0] || '';
        } else if (leaf === 'preview.png') {
          if (!slot.preview) { slot.preview = buf; previewCount++; }
        }
      },
      (name, headBuf) => {
        const [guid, leaf] = name.split('/');
        if (leaf !== 'asset') return;
        const slot = getSlot(guid);
        slot.isAsset = true;
        const dims = imageDimensions(headBuf, '.png');
        if (dims) slot.texture = dims;
      },
      (pos) => { if (onProgress) onProgress({ phase: 'unpack', bytes: pos }); }
    );
  } finally {
    stream.destroy();
  }

  return summarize(guids);
}

function previewRank(pathname) {
  const ext = extOf(pathname || '');
  if (ext === '.prefab') return 0;
  if (ext === '.fbx') return 1;
  if (ext === '.mat') return 2;
  if (['.png', '.jpg', '.jpeg', '.tga', '.psd'].includes(ext)) return 3;
  return 4;
}

function summarize(guids) {
  const pathnames = [];
  let materials = 0, fbx = 0, textures = 0, vram = 0, prefabs = 0, animations = 0;
  const previews = [];
  const previewList = [];

  for (const slot of guids.values()) {
    const p = slot.pathname.replace(/\\/g, '/');
    if (!p) continue;
    pathnames.push(p);
    const ext = extOf(p);
    if (ext === '.mat') materials++;
    else if (ext === '.prefab') prefabs++;
    else if (ext === '.anim' || ext === '.controller') animations++;
    else if (MODEL_EXT.includes(ext)) { if (ext === '.fbx') fbx++; }
    if (TEXTURE_EXT.includes(ext)) {
      textures++;
      if (slot.texture) vram += vramBytes(slot.texture.width, slot.texture.height);
    }
    if (slot.preview) previewList.push({ rank: previewRank(p), name: p, buf: slot.preview });
  }

  previewList.sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));
  for (const item of previewList.slice(0, 6)) previews.push(item.buf);

  return {
    pathnames,
    previews,
    stats: {
      assetCount: pathnames.length,
      materials,
      fbx,
      textures,
      prefabs,
      animations,
      vramMB: Math.round((vram / 1048576) * 10) / 10,
    },
  };
}

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
}

module.exports = { inspectUnityPackage, extOf, TEXTURE_EXT, MODEL_EXT };
