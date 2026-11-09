// 验证：能不能在本地跑 bge-small-zh-v1.5，并给出可比较的向量
import path from 'node:path'
import { pipeline, env } from '@huggingface/transformers'
import { CONFIG } from './lib/config.mjs'

env.allowRemoteModels = CONFIG.allowRemoteModels
env.localModelPath = CONFIG.modelDir
env.cacheDir = path.join(CONFIG.modelDir, '..', 'models-cache')

const t0 = Date.now()
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
console.log('模型加载耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's')

const text = ['吵架', '我们吵架了', '说岔了，我收回', '今天天气不错', '读完了《百年孤独》', '我想读《百年孤独》']
const out = await extractor(text, { pooling: 'mean', normalize: true })
console.log('维度:', out.dims)

const v = out.tolist()
function cos(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const q = 0 // 「吵架」
for (let i = 1; i < v.length; i++) {
  console.log(text[q], '×', text[i], '=', cos(v[q], v[i]).toFixed(4))
}
