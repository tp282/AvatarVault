const fs = require('fs');
const path = require('path');
const { encodePNG } = require('./pngwrite');

function rounded(x, y, w, h, r) {
  const dx = Math.min(x - r, 0, w - r - x);
  const dy = Math.min(y - r, 0, h - r - y);
  if (dx >= 0 || dy >= 0) return true;
  return dx * dx + dy * dy <= r * r;
}

function icon(size, file) {
  const buf = encodePNG(size, size, (x, y) => {
    if (!rounded(x + 0.5, y + 0.5, size, size, size * 0.22)) return [0, 0, 0, 0];
    const t = (x + y) / (size * 2);
    const r = Math.round(0x39 + (0x1f - 0x39) * t);
    const g = Math.round(0xd3 + (0x8f - 0xd3) * t);
    const b = Math.round(0xc8 + (0x8e - 0xc8) * t);
    // 中间一个 "盒子" + 向上箭头
    const cx = size / 2, cy = size / 2, s = size * 0.30, th = size * 0.055;
    const inBox = Math.abs(x - cx) < s && Math.abs(y - cy - size * 0.02) < s * 0.72;
    const border = inBox && (Math.abs(Math.abs(x - cx) - s) < th || Math.abs(Math.abs(y - cy - size * 0.02) - s * 0.72) < th);
    const arrowV = Math.abs(x - cx) < th && y > cy - size * 0.18 && y < cy + size * 0.20;
    const arrowH = Math.abs(y - (cy - size * 0.16)) < th && Math.abs(x - cx) < size * 0.14;
    if (border || arrowV || arrowH) return [255, 255, 255, 235];
    return [r, g, b, 255];
  });
  fs.writeFileSync(file, buf);
  console.log('written', file, buf.length);
}

icon(96, path.join(__dirname, '..', 'assets', 'drag-icon.png'));
icon(256, path.join(__dirname, '..', 'assets', 'icon.png'));
