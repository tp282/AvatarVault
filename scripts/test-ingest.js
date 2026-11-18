'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { encodePNG } = require('./pngwrite');
const { ingestPath } = require('../lib/ingest');

/* ---------- 造一个 .unitypackage ---------- */
function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(name, size, typeflag = '0') {
  const h = Buffer.alloc(512, 0);
  Buffer.from(name, 'utf8').copy(h, 0, 0, Math.min(name.length, 99));
  Buffer.from('0000644\0', 'latin1').copy(h, 100);
  Buffer.from('0000000\0', 'latin1').copy(h, 108);
  Buffer.from('0000000\0', 'latin1').copy(h, 116);
  Buffer.from(octal(size, 12), 'latin1').copy(h, 124);
  Buffer.from(octal(0, 12), 'latin1').copy(h, 136);
  h[156] = typeflag.charCodeAt(0);
  Buffer.from('ustar\0', 'latin1').copy(h, 257);
  Buffer.from('00', 'latin1').copy(h, 263);
  // checksum
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'latin1').copy(h, 148);
  return h;
}

function tarEntry(name, data) {
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader(name, data.length), data, pad]);
}

function makeUnityPackage(file) {
  const tex = encodePNG(512, 512, () => [200, 120, 150, 255]);
  const prev = encodePNG(128, 128, (x, y) => [x * 2, y * 2, 200, 255]);
  const parts = [];
  const add = (guid, pathname, assetBuf, previewBuf) => {
    parts.push(tarEntry(`${guid}/pathname`, Buffer.from(pathname + '\n')));
    if (assetBuf) parts.push(tarEntry(`${guid}/asset`, assetBuf));
    if (previewBuf) parts.push(tarEntry(`${guid}/preview.png`, previewBuf));
  };
  add('a1', 'Assets/Kikyo/Body/Kikyo_Body.fbx', Buffer.from('fakefbx'), prev);
  add('a2', 'Assets/Kikyo/Body/Kikyo_body.mat', Buffer.from('%YAML mat'));
  add('a3', 'Assets/Kikyo/Body/tex_body.png', tex);
  add('a4', 'Assets/Kikyo/Body/tex_face.png', encodePNG(1024, 1024, () => [90, 90, 120, 255]));
  add('a5', 'Assets/Kikyo/Kikyo.prefab', Buffer.from('%YAML prefab'));
  parts.push(Buffer.alloc(1024, 0)); // 结束块
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
}

/* ---------- 造一个 .zip（store 方式） ---------- */
function makeZip(file) {
  const entries = [
    { name: 'JK/Dress.fbx', data: Buffer.from('fakefbxdata') },
    { name: 'JK/dress_mat.mat', data: Buffer.from('%YAML') },
    { name: 'JK/preview.png', data: encodePNG(256, 256, (x, y) => [40, x, y, 255]) },
    { name: 'JK/textures/tex1.png', data: encodePNG(256, 256, () => [1, 2, 3, 255]) },
  ];
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30, 0);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const body = Buffer.concat([lh, nameBuf, e.data]);
    local.push(body);

    const ch = Buffer.alloc(46, 0);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += body.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const eocd = Buffer.alloc(22, 0);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  fs.writeFileSync(file, Buffer.concat([localBuf, centralBuf, eocd]));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avtest-'));
  const root = path.join(tmp, 'lib');
  fs.mkdirSync(root, { recursive: true });

  const up = path.join(tmp, 'Kikyo_v2.unitypackage');
  const zp = path.join(tmp, 'JK_dress_pack.zip');
  const dir = path.join(tmp, 'MakeupSet');
  fs.mkdirSync(dir, { recursive: true });
  makeUnityPackage(up);
  makeZip(zp);
  fs.writeFileSync(path.join(dir, 'makeup_face.png'), encodePNG(256, 256, () => [250, 210, 200, 255]));
  fs.writeFileSync(path.join(dir, 'makeup.mat'), Buffer.from('%YAML'));

  for (const p of [up, zp, dir]) {
    const e = await ingestPath(root, p, { onProgress: () => {} });
    console.log(JSON.stringify({
      name: e.name, category: e.category, kind: e.kind, thumbs: e.thumbs.length,
      stats: e.stats, sizeMB: Math.round(e.sizeBytes / 1048576 * 10) / 10,
    }, null, 2));
  }
  console.log('\nroot:', root);
})();
