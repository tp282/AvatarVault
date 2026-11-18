'use strict';
const { parentPort } = require('worker_threads');
const { ingestPath, inspectStored } = require('../lib/ingest');

parentPort.on('message', async (msg) => {
  const { id, type, payload } = msg || {};
  if (!id || !type) return;
  try {
    if (type === 'ingest') {
      const entry = await ingestPath(payload.root, payload.srcPath, {
        onProgress: (progress) => parentPort.postMessage({ id, progress }),
        onNotice: (notice) => parentPort.postMessage({ id, notice }),
      });
      parentPort.postMessage({ id, done: true, entry });
    } else if (type === 'inspect') {
      const result = await inspectStored(payload.root, payload.entry);
      parentPort.postMessage({ id, done: true, result });
    } else {
      parentPort.postMessage({ id, error: '未知任务类型：' + type });
    }
  } catch (err) {
    parentPort.postMessage({ id, error: (err && err.message) || String(err) });
  }
});
