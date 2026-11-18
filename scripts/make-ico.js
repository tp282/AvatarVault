'use strict';
// 把 256x256 的 PNG 包成单帧 ICO（Vista+ 支持 PNG 压缩帧），供 Windows 打包写 icon
const fs = require('fs');
const path = require('path');

const png = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
// ICONDIR
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // type = icon
header.writeUInt16LE(1, 4);   // count
// ICONDIRENTRY
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);       // width 0 = 256
entry.writeUInt8(0, 1);       // height 0 = 256
entry.writeUInt8(0, 2);       // palette
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // planes
entry.writeUInt16LE(32, 6);   // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12); // offset

fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), Buffer.concat([header, entry, png]));
console.log('assets/icon.ico 已生成');
