// 建语义索引：把账本 + 归档切成「200–300 字」的小段，每段一个向量
// 2026-10-26：第一版按「整段记忆」切，一段几百字，向量被稀释 → 精度差；改成细切。
// 用法：node build-index.mjs
import fs from 'node:fs'
import path from 'node:path'
import { pipeline, env } from '@huggingface/transformers'
import { writeAtomic } from './lib/atomic.mjs'
import { CONFIG } from './lib/config.mjs'

env.allowRemoteModels = CONFIG.allowRemoteModels
env.localModelPath = CONFIG.modelDir
env.cacheDir = path.join(CONFIG.modelDir, '..', 'models-cache')

const BRAIN = CONFIG.dataDir
const LEDGER = CONFIG.ledger
const ARCHIVE = CONFIG.archive
const OUT = path.join(CONFIG.indexDir, 'vectors.json')
// 2026-10-28 ④ 权重：账本标题末尾的 ★ 数量 → _index/weights.json（段 key = file:line）
const WEIGHTS = path.join(CONFIG.indexDir, 'weights.json')

const MAX = 280

// 长段按句号/换行切成 ≤280 字的小块
function splitLong(text) {
  const t = String(text).replace(/\r/g, '').trim()
  if (t.length <= MAX) return t ? [t] : []
  const parts = []
  let rest = t
  while (rest.length > MAX) {
    const seg = rest.slice(0, MAX)
    let cut = -1
    for (const mark of ['。', '！', '？', '；', '\n', '. ', '! ', '? ']) {
      const i = seg.lastIndexOf(mark)
      if (i > MAX * 0.45) {
        cut = i + mark.length
        break
      }
    }
    if (cut < 0) cut = MAX
    const piece = rest.slice(0, cut).trim()
    if (piece) parts.push(piece)
    rest = rest.slice(cut)
  }
  if (rest.trim()) parts.push(rest.trim())
  return parts
}

const raw = []

// ── 账本：按 "## " 切大段 ──
// 2026-10-27：标题以 `~` 开头 = 可忘段（可忘 ≠ 删除：原文照留，只是不进向量索引）
{
  const lines = fs.readFileSync(LEDGER, 'utf8').split(/\r?\n/)
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/^##\s+/.test(ln)) {
      if (cur) raw.push(cur)
      const title = ln.replace(/^##\s+/, '').trim()
      // 2026-10-28 ④：标题末尾的 ★ 数量 = 权重（★/★★/★★★），解析后从标题里去掉
      const m = title.match(/^(.*?)\s*(★+)\s*$/)
      cur = {
        src: '账本',
        title: (m ? m[1] : title).replace(/^~\s*/, ''),
        forget: title.startsWith('~'),
        weight: m ? m[2].length : 0,
        file: path.basename(LEDGER),
        line: i + 1,
        body: [],
      }
    } else if (cur) cur.body.push(ln)
  }
  if (cur) raw.push(cur)
}

// ── 归档：按 "## 时间 · 角色" 切大段 ──
{
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      // 2026-10-26：_冷存 不进向量索引（归档冷存后靠全文 grep，需要时把目录搬回来再重建）
      if (e.isDirectory() && e.name === '_冷存') continue
      if (e.isDirectory()) walk(p, acc)
      else if (e.name.endsWith('.md') && !e.name.startsWith('_')) acc.push(p)
    }
    return acc
  }
  for (const f of walk(ARCHIVE)) {
    const rel = f.slice(ARCHIVE.length + 1).replace(/\\/g, '/')
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    let cur = null
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (/^##\s+\d{4}-\d{2}-\d{2}/.test(ln)) {
        if (cur) raw.push(cur)
        cur = { src: '归档', title: ln.replace(/^##\s+/, '').trim(), file: rel, line: i + 1, body: [] }
      } else if (cur) cur.body.push(ln)
    }
    if (cur) raw.push(cur)
  }
}

// ── 读书卡（2026-10-26 加）：<booksDir>/reading-card-*.md 也进记忆 ──
{
  const BOOKS = CONFIG.booksDir
  try {
    for (const f of fs.readdirSync(BOOKS)) {
      if (!/^reading-card-.*\.md$/.test(f)) continue
      const lines = fs.readFileSync(path.join(BOOKS, f), 'utf8').split(/\r?\n/)
      let cur = null
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]
        if (/^##\s+/.test(ln)) {
          if (cur) raw.push(cur)
          cur = {
            src: '读书卡',
            title: ln.replace(/^##\s+/, '').trim(),
            file: 'books/' + f,
            line: i + 1,
            body: [],
          }
        } else if (cur) cur.body.push(ln)
      }
      if (cur) raw.push(cur)
    }
  } catch (e) {
    console.log('读书卡扫描失败:', e.message)
  }
}

// ── 血肉.md（2026-11-02 加）：喜欢 / 讨厌 / 日常 ──
// 之前它只进了 recall 的关键词路（recall.mjs 里有），**向量索引里根本没有这一份**。
// 后果：问「我被夸的时候什么反应」「我讨厌什么」这类，向量路永远给不出它。
{
  const F = path.join(BRAIN, '血肉.md')
  try {
    const lines = fs.readFileSync(F, 'utf8').split(/\r?\n/)
    let cur = null
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      if (/^##\s+/.test(ln)) {
        if (cur) raw.push(cur)
        cur = { src: '血肉', title: ln.replace(/^##\s+/, '').trim(), file: '血肉.md', line: i + 1, body: [] }
      } else if (cur) cur.body.push(ln)
    }
    if (cur) raw.push(cur)
  } catch (e) {
    console.log('血肉扫描失败:', e.message)
  }
}

// ── 细切 ──
const chunks = []
const weights = {} // 2026-10-28 ④：段 key → 权重（只存有 ★ 的段）
let forgotten = 0
for (const c of raw) {
  if (c.forget) {
    forgotten++
    continue // `~` 可忘段：不进向量索引，原文照留
  }
  const body = c.body.join('\n').trim()
  if (body.length < 8) continue
  const key = c.file + ':' + c.line
  if (c.weight) weights[key] = c.weight
  const pieces = splitLong(body)
  pieces.forEach((p, k) => {
    chunks.push({
      src: c.src,
      title: c.title + (pieces.length > 1 ? `（${k + 1}/${pieces.length}）` : ''),
      file: c.file,
      line: c.line,
      key,
      weight: c.weight || 0,
      text: (pieces.length > 1 ? '' : c.title + '\n') + p,
    })
  })
}

console.log('切出', chunks.length, '段（MAX=' + MAX + '）' + (forgotten ? `，跳过 ${forgotten} 个可忘段（~）` : ''))

// 2026-10-28 ④：权重表落盘（recall 靠它给命中排序）
// 2026-10-30：整文件重写改走 writeAtomic（临时文件 → fsync → rename），断电不会留半截 JSON
writeAtomic(WEIGHTS, JSON.stringify({ at: new Date().toISOString(), weights }, null, 2))
console.log('权重表：', Object.keys(weights).length, '段有 ★，写入', WEIGHTS)

// --dry：只解析 + 写权重表，不建向量（改逻辑时省钱省时间）
if (process.argv.includes('--dry')) {
  console.log('（--dry，跳过向量）')
  process.exit(0)
}

const texts = chunks.map((c) => c.text.replace(/\n/g, ' ').slice(0, 400))

const t0 = Date.now()
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
console.log('模型就绪', ((Date.now() - t0) / 1000).toFixed(1) + 's')

const BATCH = 32
const items = []
for (let i = 0; i < texts.length; i += BATCH) {
  const batch = texts.slice(i, i + BATCH)
  const out = await extractor(batch, { pooling: 'mean', normalize: true })
  const vecs = out.tolist()
  for (let k = 0; k < batch.length; k++) {
    const c = chunks[i + k]
    items.push({
      id: i + k,
      src: c.src,
      title: c.title,
      file: c.file,
      line: c.line,
      preview: batch[k].slice(0, 160),
      vec: vecs[k].map((x) => Math.round(x * 10000) / 10000),
    })
  }
}

writeAtomic(OUT, JSON.stringify({ model: 'Xenova/bge-small-zh-v1.5', dim: 512, at: new Date().toISOString(), items }))
console.log('写入', OUT, (fs.statSync(OUT).size / 1024 / 1024).toFixed(2) + ' MB,', items.length, '条')
