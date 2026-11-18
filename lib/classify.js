'use strict';

// 类目自动识别：按路径/文件名关键词打分，猜错可在界面里改
const RULES = [
  {
    key: 'base',
    words: ['素体', 'body', 'base_body', 'basemodel', 'base model', 'avatar', 'armature', 'humanoid',
      'head mesh', 'face mesh', '__body', 'body_mesh', 'hybrid', 'headmesh'],
  },
  {
    key: 'cloth',
    words: ['服装', '衣', 'clothes', 'cloth', 'outfit', 'costume', 'dress', 'skirt', 'shirt', 'hoodie',
      'jacket', 'pants', 'trousers', 'sock', 'shoe', 'boot', 'hair', 'ponytail', 'sweater', 'coat'],
  },
  {
    key: 'makeup',
    words: ['妆容', 'makeup', 'make_up', 'face_tex', 'facetex', 'decal', 'tattoo', 'eyebrow', 'eyelash',
      'eyeshadow', 'lip', 'blush', 'face_texture', 'eye_texture'],
  },
  {
    key: 'prop',
    words: ['道具', 'prop', 'weapon', 'accessory', 'gimmick', 'hat', 'glasses', 'earring', 'ring',
      'sword', 'gun', 'tail', 'wing', 'halo', 'bag', 'pin', 'ornament'],
  },
  {
    key: 'material',
    words: ['material', '材质', '着色球', '.mat', '.shader', 'matcap', 'poiyomi', 'liltoon', 'shader preset'],
  },
];

const CATEGORIES = ['base', 'cloth', 'makeup', 'prop', 'material', 'other'];

const CATEGORY_LABEL = {
  base: '素体',
  cloth: '服装',
  makeup: '妆容',
  prop: '道具',
  material: '着色球',
  other: '未分类',
};

function classify(pathnames, fallbackName = '') {
  const blob = (pathnames.join('\n') + '\n' + fallbackName).toLowerCase();
  if (!blob.trim()) return 'other';

  const scores = {};
  for (const rule of RULES) {
    let score = 0;
    for (const w of rule.words) {
      const needle = w.toLowerCase();
      let idx = 0;
      let hits = 0;
      while ((idx = blob.indexOf(needle, idx)) !== -1 && hits < 40) {
        // 命中路径片段比命中纯文本权重高
        score += 1;
        hits++;
        idx += needle.length;
      }
    }
    scores[rule.key] = score;
  }

  // .mat 占绝大多数文件 → 材质球
  const matCount = pathnames.filter((p) => p.toLowerCase().endsWith('.mat')).length;
  if (pathnames.length > 0 && matCount / pathnames.length > 0.6) scores.material += 8;

  let best = 'other';
  let bestScore = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) { bestScore = v; best = k; }
  }
  return bestScore >= 2 ? best : 'other';
}

module.exports = { classify, CATEGORIES, CATEGORY_LABEL, RULES };
