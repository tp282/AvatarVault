'use strict';
const assert = require('assert');
const booth = require('../lib/booth');

function itemId(text) {
  const r = booth.extractBoothLink(text);
  return r ? r.itemId : null;
}

assert.equal(itemId('https://booth.pm/ja/items/6641548'), 6641548);
assert.equal(itemId('备注：https://booth.pm/ja/items/6641548?foo=1。'), 6641548);
assert.equal(itemId('https://booth.pm/items/123'), 123);
assert.equal(itemId('https://silolab.booth.pm/items/123'), 123);
assert.equal(itemId('https://booth.pm/ja/items/6641548/'), 6641548);
assert.equal(itemId('https://booth.pm/ja/items/abc'), null);
assert.equal(itemId('https://example.com/ja/items/123'), null);
assert.equal(itemId('http://booth.pm/ja/items/123'), null);
assert.equal(itemId('没有链接'), null);
assert.equal(itemId(''), null);

const parsed = booth.parseBoothPayload({
  id: 123,
  name: '测试商品',
  shop: { name: '测试店' },
  category: { id: 209, name: '3D衣装' },
  images: [{ original: 'https://booth.pximg.net/a.jpg' }, {}],
}, 123);
assert.deepEqual(parsed, {
  id: 123,
  name: '测试商品',
  shop: '测试店',
  images: ['https://booth.pximg.net/a.jpg'],
  category: { id: 209, name: '3D衣装' },
});

assert.throws(() => booth.parseBoothPayload({ id: 1 }, 1), /商品信息不完整/);
assert.equal(booth.isBoothHost('booth.pm'), true);
assert.equal(booth.isBoothHost('silolab.booth.pm'), true);
assert.equal(booth.isBoothHost('booth.pm.evil.com'), false);
assert.equal(booth.isPximgHost('booth.pximg.net'), true);
assert.equal(booth.isPximgHost('i.pximg.net'), false);

console.log('test-booth: 链接解析 / 商品 JSON 解析 全部通过');

// 可选联网检查：AV_TEST_BOOTH_NETWORK=1 node scripts/test-booth.js
if (process.env.AV_TEST_BOOTH_NETWORK === '1') {
  (async () => {
    const info = await booth.fetchItem(6641548);
    assert.equal(info.id, 6641548);
    assert.ok(info.name.includes('KonoAsset'));
    assert.ok(info.images[0].startsWith('https://booth.pximg.net/'));
    console.log(`test-booth: 联网抓取通过，${info.name}（${info.images.length} 张图）`);
  })().catch((e) => {
    console.error('test-booth: 联网抓取失败：' + e.message);
    process.exit(1);
  });
}
