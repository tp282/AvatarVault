'use strict';
const { Buffer } = require('buffer');

// 流式 tar 读取器：只读需要的条目，跳过大的 asset 数据，内存占用恒定
class ByteReader {
  constructor(stream) {
    this.it = stream[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.done = false;
    this.position = 0;
  }

  async _pull() {
    if (this.done) return false;
    const r = await this.it.next();
    if (r.done) { this.done = true; return false; }
    this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    return true;
  }

  async ensure(n) {
    while (this.buf.length < n && !this.done) await this._pull();
    return this.buf.length >= n;
  }

  // 读取恰好 n 字节（不足时返回已读到的部分，通常出现在流末尾）
  async read(n) {
    await this.ensure(n);
    const len = Math.min(n, this.buf.length);
    const out = this.buf.subarray(0, len);
    this.buf = this.buf.subarray(len);
    this.position += len;
    return out;
  }

  async skip(n) {
    let left = n;
    while (left > 0) {
      if (this.buf.length) {
        const take = Math.min(left, this.buf.length);
        this.buf = this.buf.subarray(take);
        this.position += take;
        left -= take;
      } else {
        if (!(await this._pull())) return this.position;
      }
    }
    return this.position;
  }
}

function parseOctal(buf) {
  if (!buf || buf.length === 0) return 0;
  // GNU base-256 扩展
  if (buf[0] === 0x80 || buf[0] === 0xff) {
    let v = 0;
    for (let i = 1; i < buf.length; i++) v = v * 256 + buf[i];
    return v;
  }
  const s = buf.toString('latin1').replace(/\0.*$/, '').trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function headerName(h) {
  let name = h.toString('latin1', 0, 100).replace(/\0.*$/, '');
  const prefix = h.toString('latin1', 345, 500).replace(/\0.*$/, '');
  if (prefix) name = prefix + '/' + name;
  return name;
}

/**
 * 扫描 tar 流
 * @param {Readable} stream
 * @param {(name:string, size:number, typeflag:string) => 'data'|'head'|'skip'} want
 * @param {(name:string, buf:Buffer) => void} onData
 * @param {(name:string, head:Buffer) => void} onHead
 * @param {(pos:number) => void} [onProgress]
 */
async function scanTar(stream, want, onData, onHead, onProgress) {
  const reader = new ByteReader(stream);
  let pendingLongName = null;
  let entries = 0;

  for (;;) {
    if (!(await reader.ensure(512))) break;
    const head = await reader.read(512);
    if (!head.length || head.length < 512) break;
    // 全零块 = 结束
    let zero = true;
    for (let i = 0; i < 512; i++) if (head[i] !== 0) { zero = false; break; }
    if (zero) break;

    const size = parseOctal(head.subarray(124, 136));
    const typeflag = String.fromCharCode(head[156] || 0x30);
    let name = headerName(head);

    if (typeflag === 'L' || typeflag === 'K') {
      const data = await reader.read(size);
      if (typeflag === 'L') pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
      await reader.skip(pad512(size) - size);
      continue;
    }
    if (pendingLongName) { name = pendingLongName; pendingLongName = null; }

    if (size > 0 && typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
      // 非普通文件（目录/链接）直接跳过
    }

    const mode = want(name, size, typeflag);
    if (mode === 'data') {
      const data = await reader.read(size);
      onData(name, Buffer.from(data));
      await reader.skip(pad512(size) - size);
    } else if (mode === 'head') {
      const headBuf = await reader.read(Math.min(size, 64));
      onHead(name, Buffer.from(headBuf));
      await reader.skip(pad512(size) - headBuf.length);
    } else {
      await reader.skip(pad512(size));
    }

    entries++;
    if (onProgress && (entries & 31) === 0) onProgress(reader.position);
  }
}

function pad512(n) {
  const r = n % 512;
  return r === 0 ? n : n + (512 - r);
}

module.exports = { scanTar, pad512 };
