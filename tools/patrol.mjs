// dsh-brain · 记忆夜巡
// 2026-10-30 借鉴 dsh-chain 的夜巡，按我家结构改成「能跑得动」的版本：
//   ① 不做 O(n²) 全量比对（3415 段会卡死）→ 只对账本段做两两，账本 vs 归档走 top-1
//   ② 不自动跑 → 日期锁：今天有报告就跳过（--force 强制重跑）
//   ③ 只出清单，一个字不改 —— 合并 / 作废 / 沉底都得人拍板
//
// 用法：
//   node tools/patrol.mjs          今天还没巡就跑，巡过就跳过
//   node tools/patrol.mjs --force  强制再跑一次
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../lib/atomic.mjs'
import { CONFIG } from '../lib/config.mjs'

const BRAIN = CONFIG.dataDir
const LEDGER_NAME = path.basename(CONFIG.ledger)
const VEC = path.join(CONFIG.indexDir, 'vectors.json')
const HITS = path.join(CONFIG.indexDir, 'hits.json')
const LC_FILE = path.join(CONFIG.indexDir, 'lifecycle.json')
const OUTDIR = path.join(BRAIN, 'patrol')

const DUP_THRESHOLD = 0.9 // 账本内部「太像了」
const CROSS_THRESHOLD = 0.93 // 账本段跟归档撞车
const STALE_DAYS = 30
const SHOW = 10

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const outFile = path.join(OUTDIR, `${today}.md`)

if (fs.existsSync(outFile) && !process.argv.includes('--force')) {
  console.log(`今天巡过了：${outFile}（要重巡加 --force）`)
  process.exit(0)
}

const idx = JSON.parse(fs.readFileSync(VEC, 'utf8')).items
const hits = (() => {
  try {
    return JSON.parse(fs.readFileSync(HITS, 'utf8'))
  } catch {
    return {}
  }
})()
const LC = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(LC_FILE, 'utf8'))
    return { dead: j.dead || {}, expire: j.expire || {} }
  } catch {
    return { dead: {}, expire: {} }
  }
})()

const keyOf = (it) => it.file + ':' + it.line
const isDead = (k) => !!LC.dead[k] || !!(LC.expire[k] && LC.expire[k].until && LC.expire[k].until <= today)

const ledger = idx.filter((it) => it.file === LEDGER_NAME && !isDead(keyOf(it)))
const archive = idx.filter((it) => it.file !== LEDGER_NAME && !it.file.startsWith('books/') && !isDead(keyOf(it)))

// 向量已 normalize（build-index 里 pooling: 'mean', normalize: true），点积即余弦
const dot = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ① 账本内部疑似重复：116 段两两 = 6670 次，秒级
const dup = []
for (let i = 0; i < ledger.length; i++) {
  for (let j = i + 1; j < ledger.length; j++) {
    const s = dot(ledger[i].vec, ledger[j].vec)
    if (s >= DUP_THRESHOLD) dup.push({ a: ledger[i], b: ledger[j], s })
  }
}
dup.sort((x, y) => y.s - x.s)

// ② 账本段跟归档撞车：每段取全库最像的那一条
const cross = []
for (const L of ledger) {
  let best = null
  for (const A of archive) {
    const s = dot(L.vec, A.vec)
    if (!best || s > best.s) best = { a: L, b: A, s }
  }
  if (best && best.s >= CROSS_THRESHOLD) cross.push(best)
}
cross.sort((x, y) => y.s - x.s)

// ③ 落灰段：从没被 recall 给出去过，且日期 30 天以上（同一段的多个块只算一次）
const stale = []
const seenStale = new Set()
for (const L of ledger) {
  const k = keyOf(L)
  if (seenStale.has(k)) continue
  seenStale.add(k)
  if (hits[k]) continue
  const m = String(L.title).match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) continue
  const days = Math.floor((now - new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)) / 86400_000)
  if (days >= STALE_DAYS) stale.push({ ...L, days, chunks: 1 })
}
stale.sort((a, b) => b.days - a.days)

// ── 出报告 ──
const L = []
L.push(`# 记忆夜巡 · ${today}`)
L.push('')
L.push(`索引 ${idx.length} 块 · 账本 ${ledger.length} 块（${new Set(ledger.map(keyOf)).size} 段）· 归档 ${archive.length} 块`)
L.push('')
L.push('> 只出清单，没改任何记忆。要合并/作废/沉底，用 `recall.mjs --mark-dup / --mark-dead / --mark-expire`。')
L.push('')

L.push(`## ① 账本内部疑似重复（相似度 ≥ ${DUP_THRESHOLD}，${dup.length} 对）`)
L.push('')
if (!dup.length) L.push('（没有）')
else {
  L.push('| 相似度 | A | B |')
  L.push('|---|---|---|')
  for (const d of dup.slice(0, SHOW)) {
    L.push(`| ${d.s.toFixed(3)} | \`${keyOf(d.a)}\` ${d.a.title} | \`${keyOf(d.b)}\` ${d.b.title} |`)
  }
}
L.push('')

L.push(`## ② 账本段跟归档撞车（≥ ${CROSS_THRESHOLD}，${cross.length} 条）`)
L.push('')
if (!cross.length) L.push('（没有）')
else {
  L.push('| 相似度 | 账本 | 归档 |')
  L.push('|---|---|---|')
  for (const c of cross.slice(0, SHOW)) {
    L.push(`| ${c.s.toFixed(3)} | \`${keyOf(c.a)}\` ${c.a.title} | \`${keyOf(c.b)}\` ${c.b.title} |`)
  }
}
L.push('')

L.push(`## ③ 落灰段（从没被想起过，且 ${STALE_DAYS} 天以上，${stale.length} 条）`)
L.push('')
if (!stale.length) L.push('（没有）')
else {
  for (const s of stale.slice(0, SHOW)) L.push(`- \`${keyOf(s)}\` ${s.title}（${s.days} 天前）`)
  if (stale.length > SHOW) L.push(`- ……还有 ${stale.length - SHOW} 条`)
}
L.push('')

L.push('## 该你拍板的')
L.push('')
const asked = []
for (const d of dup.slice(0, 2)) asked.push(`账本 \`${keyOf(d.a)}\` 和 \`${keyOf(d.b)}\` 像同一件事（${d.s.toFixed(2)}）——合并（--mark-dup）还是留两段？`)
for (const c of cross.slice(0, 2)) asked.push(`账本 \`${keyOf(c.a)}\` 跟归档 \`${keyOf(c.b)}\` 撞车（${c.s.toFixed(2)}）——账本留、归档照旧？`)
if (!asked.length) asked.push('这次没发现要拍的，安静。')
for (const a of asked) L.push(`- ${a}`)
L.push('')

fs.mkdirSync(OUTDIR, { recursive: true })
writeAtomic(outFile, L.join('\n'), 'utf8')

console.log(`夜巡完成 → ${outFile}`)
console.log(`  账本内部重复 ${dup.length} 对 · 跟归档撞车 ${cross.length} 条 · 落灰 ${stale.length} 条`)
if (dup.length) console.log(`  最像的一对：${keyOf(dup[0].a)} ↔ ${keyOf(dup[0].b)}（${dup[0].s.toFixed(3)}）`)
