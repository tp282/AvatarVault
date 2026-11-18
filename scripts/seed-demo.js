'use strict';
// 生成一个带样例数据的素材库，用于界面截图 / 手动体验
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { encodePNG } = require('./pngwrite');
const { ingestPath } = require('../lib/ingest');
const store = require('../lib/store');

function octal(n, len) { return n.toString(8).padStart(len - 1, '0') + '\0'; }

function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  Buffer.from(name, 'utf8').copy(h, 0, 0, Math.min(name.length, 99));
  Buffer.from('0000644\0', 'latin1').copy(h, 100);
  Buffer.from(octal(size, 12), 'latin1').copy(h, 124);
  h[156] = 0x30;
  Buffer.from('ustar\0', 'latin1').copy(h, 257);
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let s = 0;
  for (let i = 0; i < 512; i++) s += h[i];
  Buffer.from(s.toString(8).padStart(6, '0') + '\0 ', 'latin1').copy(h, 148);
  return h;
}
function tarEntry(name, data) {
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader(name, data.length), data, pad]);
}

function gradient(w, h, c1, c2, glyph) {
  return encodePNG(w, h, (x, y) => {
    const t = (x / w + y / h) / 2;
    let r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    let g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    let b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    if (glyph) {
      const cx = w / 2, cy = h / 2;
      const dx = Math.abs(x - cx) / (w * 0.28), dy = Math.abs(y - cy) / (h * 0.28);
      if (dx * dx + dy * dy < 1) { r = 245; g = 248; b = 250; }
    }
    return [r, g, b, 255];
  });
}

function makeUnityPackage(file, modelName, texSize) {
  const preview = gradient(160, 160, [40, 60, 90], [70, 130, 160], true);
  const tex = encodePNG(texSize, texSize, () => [180, 140, 150, 255]);
  const parts = [];
  const add = (guid, pathname, assetBuf, prevBuf) => {
    parts.push(tarEntry(`${guid}/pathname`, Buffer.from(pathname + '\n')));
    if (assetBuf) parts.push(tarEntry(`${guid}/asset`, assetBuf));
    if (prevBuf) parts.push(tarEntry(`${guid}/preview.png`, prevBuf));
  };
  add('g1', `Assets/${modelName}/Body_${modelName}.fbx`, Buffer.from('fbx'), preview);
  add('g2', `Assets/${modelName}/${modelName}_body.mat`, Buffer.from('%YAML'));
  add('g3', `Assets/${modelName}/tex_body.png`, tex);
  add('g4', `Assets/${modelName}/tex_face.png`, encodePNG(1024, 1024, () => [200, 170, 160, 255]));
  add('g5', `Assets/${modelName}/${modelName}.prefab`, Buffer.from('%YAML'));
  parts.push(Buffer.alloc(1024, 0));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
}

function makeStoredZip(file, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nb = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30, 0);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    const body = Buffer.concat([lh, nb, e.data]);
    local.push(body);
    const ch = Buffer.alloc(46, 0);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nb]));
    offset += body.length;
  }
  const cb = Buffer.concat(central);
  const lb = Buffer.concat(local);
  const eocd = Buffer.alloc(22, 0);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cb.length, 12);
  eocd.writeUInt32LE(lb.length, 16);
  fs.writeFileSync(file, Buffer.concat([lb, cb, eocd]));
}

(async () => {
  const root = process.argv[2] || path.join(process.env.HOME, 'AvatarVaultDemo');
  const tmp = path.join(root, '_incoming');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(root, 'orig'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prev'), { recursive: true });

  const jobs = [];

  const base1 = path.join(tmp, 'Kikyo_2.0.unitypackage');
  makeUnityPackage(base1, 'Kikyo', 512);
  jobs.push({ p: base1, patch: { tags: ['素体', '日系'], favorite: true } });

  const base2 = path.join(tmp, 'Manuka_v3.unitypackage');
  makeUnityPackage(base2, 'Manuka', 256);
  jobs.push({ p: base2, patch: { tags: ['素体', '幼态'] } });

  const dress = path.join(tmp, 'JK制服_夏日.zip');
  makeStoredZip(dress, [
    { name: 'JK/Dress.fbx', data: Buffer.from('fbx') },
    { name: 'JK/dress_body.mat', data: Buffer.from('%YAML') },
    { name: 'JK/preview.png', data: gradient(220, 220, [40, 70, 60], [120, 180, 150], true) },
    { name: 'JK/tex.png', data: encodePNG(512, 512, () => [30, 60, 50, 255]) },
  ]);
  jobs.push({ p: dress, patch: { tags: ['JK', '夏季'] } });

  const dress2 = path.join(tmp, '赛博外套_pack.zip');
  makeStoredZip(dress2, [
    { name: 'Cyber/Coat.fbx', data: Buffer.from('fbx') },
    { name: 'Cyber/coat.mat', data: Buffer.from('%YAML') },
    { name: 'Cyber/preview.png', data: gradient(220, 220, [60, 40, 80], [150, 110, 200], true) },
  ]);
  jobs.push({ p: dress2, patch: { tags: ['赛博', '外套'] } });

  const makeup = path.join(tmp, '妆容_淡妆01');
  fs.mkdirSync(makeup, { recursive: true });
  fs.writeFileSync(path.join(makeup, 'face_makeup.png'), gradient(256, 256, [200, 160, 150], [235, 200, 190], true));
  fs.writeFileSync(path.join(makeup, 'makeup.mat'), Buffer.from('%YAML'));
  jobs.push({ p: makeup, patch: { tags: ['淡妆'] } });

  const prop = path.join(tmp, '猫耳耳机.unitypackage');
  makeStoredZip(prop, []); // 占位，下面单独处理
  // 道具用单文件图片演示
  const propImg = path.join(tmp, '猫耳耳机.png');
  fs.writeFileSync(propImg, gradient(256, 256, [70, 70, 90], [180, 180, 200], true));
  jobs.push({ p: propImg, patch: { tags: ['道具', '耳机'], category: 'prop', categorySource: 'manual' } });

  const mat = path.join(tmp, 'Poiyomi_Ocean.mat');
  fs.writeFileSync(mat, Buffer.from('%YAML !u!21'));
  jobs.push({ p: mat, patch: { category: 'material', categorySource: 'manual', tags: ['Poiyomi'] } });

  const index = { version: 1, items: [], collections: [] };
  for (const j of jobs) {
    try {
      const e = await ingestPath(root, j.p, {});
      Object.assign(e, j.patch);
      if (!index.items.find((x) => x.id === e.id)) index.items.unshift(e);
    } catch (err) {
      console.error('ingest failed', j.p, err.message);
    }
  }

  // 一个演示套装
  const jk = index.items.find((x) => x.name.includes('JK'));
  const kikyo = index.items.find((x) => x.name.includes('Kikyo'));
  const mk = index.items.find((x) => x.name.includes('妆容'));
  if (jk && kikyo) {
    index.collections.push({
      id: 'demo1',
      name: 'JK 日和套装',
      itemIds: [kikyo.id, jk.id, mk ? mk.id : null].filter(Boolean),
    });
  }

  await store.saveIndex(root, index);
  console.log('seeded →', root, '条目数', index.items.length);
})();
