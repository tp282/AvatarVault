'use strict';
// 极简 zip 写入器（store 模式，单遍写入，事后回填 CRC）
// 用于「整库打包导出」，不依赖第三方库
const fs = require('fs');
const fsp = require('fs/promises');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
  return c;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/**
 * @param {string} outFile
 * @param {{name:string, absPath:string}[]} entries
 */
async function writeStoreZip(outFile, entries, onProgress) {
  const fh = await fsp.open(outFile, 'w');
  const central = [];
  let offset = 0;
  let done = 0;
  const total = entries.reduce((a, e) => a + (e.size || 0), 0) || 1;

  try {
    for (const e of entries) {
      const st = await fsp.stat(e.absPath);
      const size = st.size;
      if (size > 0xfffffffe) throw new Error('单个文件超过 4GB，请改用文件夹导出');
      const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
      const { time, date } = dosDateTime(st.mtimeMs);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
      local.writeUInt16LE(0, 8);      // store
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14);     // CRC 先占位，写完回填
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      const localOffset = offset;
      await fh.write(Buffer.concat([local, nameBuf]));
      offset += 30 + nameBuf.length;

      let crc = -1;
      const rs = fs.createReadStream(e.absPath, { highWaterMark: 4 * 1024 * 1024 });
      for await (const chunk of rs) {
        crc = crc32Update(crc, chunk);
        await fh.write(chunk);
        offset += chunk.length;
        done += chunk.length;
        if (onProgress) onProgress({ done, total, name: e.name });
      }
      crc = (crc ^ -1) >>> 0;

      // 回填 CRC
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32LE(crc);
      await fh.write(crcBuf, 0, 4, localOffset + 14);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(size, 20);
      cd.writeUInt32LE(size, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([cd, nameBuf]));
    }

    const cdBuf = Buffer.concat(central);
    const cdOffset = offset;
    await fh.write(cdBuf);
    offset += cdBuf.length;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    await fh.write(eocd);
  } finally {
    await fh.close();
  }
  return outFile;
}

module.exports = { writeStoreZip, crc32Update };
