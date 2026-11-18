'use strict';
/**
 * 极简 worker 线程池：把哈希/解析/统计等重活挪出主进程。
 * 每个 worker 一次只跑一个任务，任务完成后再接下一个。
 */
const path = require('path');
const { Worker } = require('worker_threads');

class WorkerPool {
  constructor(file, size = 2) {
    this.file = file;
    this.size = Math.max(1, size);
    this.workers = [];
    this.idle = [];
    this.jobs = new Map();
    this.queue = [];
    this.seq = 0;
    this.closed = false;
    this._spawnAll();
  }

  _spawnAll() {
    for (let i = 0; i < this.size; i++) this._spawn();
  }

  _spawn() {
    let worker;
    try {
      worker = new Worker(this.file);
    } catch (err) {
      // Worker 起不来时退化为“主进程直接执行”的兜底
      console.error('[worker] spawn failed', err);
      return;
    }
    worker._busy = null;
    worker.on('message', (msg) => this._onMessage(worker, msg));
    worker.on('error', (err) => this._onError(worker, err));
    worker.on('exit', () => {
      if (this.closed) return;
      const idx = this.workers.indexOf(worker);
      if (idx >= 0) this.workers.splice(idx, 1);
      const idleIdx = this.idle.indexOf(worker);
      if (idleIdx >= 0) this.idle.splice(idleIdx, 1);
      if (worker._busy && this.jobs.has(worker._busy)) {
        const job = this.jobs.get(worker._busy);
        this.jobs.delete(worker._busy);
        job.reject(new Error('worker 已退出'));
      }
      this._spawn();
      this._pump();
    });
    this.workers.push(worker);
    this.idle.push(worker);
  }

  _onMessage(worker, msg) {
    const job = this.jobs.get(msg && msg.id);
    if (!job) return;
    if (msg.progress) {
      if (job.onProgress) {
        try { job.onProgress(msg.progress); } catch (_) { /* ignore */ }
      }
      return;
    }
    if (msg.notice) {
      if (job.onNotice) {
        try { job.onNotice(msg.notice); } catch (_) { /* ignore */ }
      }
      return;
    }
    this.jobs.delete(msg.id);
    worker._busy = null;
    this.idle.push(worker);
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg.entry !== undefined ? msg.entry : msg.result);
    this._pump();
  }

  _onError(worker, err) {
    if (worker._busy && this.jobs.has(worker._busy)) {
      const job = this.jobs.get(worker._busy);
      this.jobs.delete(worker._busy);
      job.reject(err);
    }
    worker._busy = null;
  }

  run(type, payload, opts = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.jobs.set(id, { resolve, reject, onProgress: opts.onProgress, onNotice: opts.onNotice });
      this.queue.push({ id, type, payload });
      this._pump();
    });
  }

  _pump() {
    if (this.closed) return;
    while (this.queue.length && this.idle.length) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      worker._busy = job.id;
      try {
        worker.postMessage({ id: job.id, type: job.type, payload: job.payload });
      } catch (err) {
        this.jobs.delete(job.id);
        worker._busy = null;
        this.idle.push(worker);
        const rec = this.jobs.get(job.id);
        if (rec) rec.reject(err);
      }
    }
  }

  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})));
    this.workers = [];
    this.idle = [];
    this.queue = [];
    for (const [id, job] of this.jobs) {
      this.jobs.delete(id);
      job.reject(new Error('worker pool 已关闭'));
    }
  }
}

function createPool(size = 2) {
  return new WorkerPool(path.join(__dirname, '..', 'workers', 'heavy.js'), size);
}

module.exports = { WorkerPool, createPool };
