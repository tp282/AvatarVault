'use strict';
// 轻量图片头解析：只读文件头拿尺寸，不做解码

function pngDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function jpegDimensions(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 8 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0x01) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      if (width && height) return { width, height };
    }
    off += 2 + len;
  }
  return null;
}

function imageDimensions(buf, ext) {
  if (ext === '.png') return pngDimensions(buf);
  if (ext === '.jpg' || ext === '.jpeg') return jpegDimensions(buf);
  // 兜底：先按 png 试，再按 jpg 试
  return pngDimensions(buf) || jpegDimensions(buf);
}

// 估算显存：RGBA32 + mipmap 链
function vramBytes(width, height) {
  return Math.round(width * height * 4 * 1.3333);
}

module.exports = { pngDimensions, jpegDimensions, imageDimensions, vramBytes };
