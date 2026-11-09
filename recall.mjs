// 回忆入口：先关键词，后向量
//   node recall.mjs 吵架              → 先 grep，命中够就直接给
//   node recall.mjs 我们有没有吵架   → grep 不够就补向量
//   node recall.mjs xxx --vec-only   → 只用向量
//   node recall.mjs xxx -n 6         → 多要几条
//
// 2026-10-27：加「缺失声明」——每次输出末尾说清「还有多少没给」。
//   理由：模型不知道自己缺了什么，只会自信地编（es-memory-rag 的 lossy boundary）。
//   关键词：全量计数（原来数到 40 就早退，数字是假的）；
//   向量：数一数「相关（相似度 ≥ 0.5）但没进前 n」的还有多少条。
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from './lib/atomic.mjs'
import { CONFIG } from './lib/config.mjs'
import { decayOf, cmp } from './lib/decay.mjs'
import {
  load as loadLifecycle,
  save as saveLifecycle,
  applyLifecycle,
  summary as lcSummary,
  markDup,
  markDead,
  markExpire,
} from './lib/lifecycle.mjs'

const BRAIN = CONFIG.dataDir
const LEDGER = CONFIG.ledger
const ARCHIVE = CONFIG.archive
const IDX = path.join(CONFIG.indexDir, 'vectors.json')

// ── 2026-10-28 ④ 权重 + 热度 ──
// 权重：账本段标题里的 ★（build-index 解析后存 weights.json；段 key = file:line）
// 热度：每次 recall 给出去的命中各 +1（hits.json）
const WEIGHTS = path.join(CONFIG.indexDir, 'weights.json')
const HITS = path.join(CONFIG.indexDir, 'hits.json')
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const W = (readJson(WEIGHTS) || {}).weights || {}
const H = readJson(HITS) || {}
// 权重 ★ = 0.03/星；热度用 log 曲线——常被想起的稍微靠前，但不压过相关性
function boost(key) {
  const w = W[key] || 0
  const h = H[key] || 0
  return w * 0.03 + Math.log1p(h) * 0.008
}
function recordHits(keys) {
  const uniq = [...new Set(keys.filter(Boolean))]
  if (!uniq.length) return
  for (const k of uniq) H[k] = (H[k] || 0) + 1
  try {
    // 2026-10-30：hits.json 在热路径上（每次 recall 都写），整文件重写改原子写
    writeAtomic(HITS, JSON.stringify(H, null, 2))
  } catch (e) {
    console.error('（热度表写入失败：' + e.message + '）')
  }
}

const args = process.argv.slice(2)
const nIdx = args.indexOf('-n')
const n = nIdx > 0 ? Number(args[nIdx + 1]) : 6
const vecOnly = args.includes('--vec-only')
const flagVal = (name) => {
  const i = args.indexOf(name)
  return i > 0 ? args[i + 1] : ''
}
const budget = Number(flagVal('--budget')) || 0
// 2026-10-30 ⑧：平局裁决实测**退化**（25 题：hit@1 68%→56%），默认关，只留 --fresh 做实验
const useFresh = args.includes('--fresh')
// 2026-10-30 ⑦：默认就走 RRF 融合。
// 实测（25 题 / 3415 段）：现行 52.0% → RRF 68.0%（hit@3 60%→84%，MRR 0.553→0.740）。
// 代价是每次都要加载向量模型（约 10 秒），但「找错记忆」比「等 10 秒」严重得多。
// 想要旧行为（关键词命中就早退、快）加 --fast。
const useRrf = !args.includes('--fast')

// ── 2026-10-30 ③ 生命周期命令（不检索，处理完就退）──
if (args.includes('--lifecycle') || args.includes('--mark-dup') || args.includes('--mark-dead') || args.includes('--mark-expire')) {
  const lc = loadLifecycle()
  try {
    if (args.includes('--mark-dup')) markDup(lc, flagVal('--old'), flagVal('--new'), flagVal('--why'))
    if (args.includes('--mark-dead')) markDead(lc, flagVal('--old'), flagVal('--why'))
    if (args.includes('--mark-expire')) markExpire(lc, flagVal('--old'), flagVal('--until'), flagVal('--why'))
    if (args.includes('--lifecycle')) {
      console.log(`记忆生命周期（改于 ${lc.at || '从未'}）：${lcSummary(lc)}`)
      for (const [k, v] of Object.entries(lc.superseded)) console.log(`  覆盖 ${k} → ${v.by}  ${v.reason || ''}`)
      for (const [k, v] of Object.entries(lc.dead)) console.log(`  作废 ${k}  ${v.reason || ''}`)
      for (const [k, v] of Object.entries(lc.expire)) console.log(`  限期 ${k} 到 ${v.until}  ${v.reason || ''}`)
    } else {
      saveLifecycle(lc)
      console.log('已记下：' + lcSummary(lc))
    }
  } catch (e) {
    console.error('没成：' + e.message)
    process.exit(1)
  }
  process.exit(0)
}

// 取搜索词：剔掉所有开关和它们的值（--why 后面那句不能被当成搜索词）
const VALUE_FLAGS = new Set(['-n', '--budget', '--why', '--until', '--old', '--new'])
const qParts = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (VALUE_FLAGS.has(a)) {
    i++
    continue
  }
  if (a.startsWith('--')) continue
  qParts.push(a)
}
const q = qParts.join(' ')
if (!q) {
  console.error('用法: node recall.mjs <关键词或一句话> [-n 6] [--vec-only] [--budget 3000]')
  console.error('      生命周期: --lifecycle | --mark-dup --old <key> --new <key> --why "..."')
  console.error('                --mark-dead --old <key> --why "..." | --mark-expire --old <key> --until YYYY-MM-DD --why "..."')
  process.exit(1)
}

// 关键词最多展示几条（原来 n+4）；命中够不够的判定仍是 ≥3 条。
const SHOW_KW = n + 4

// ── 2026-10-29：关键词从「整句包含」改成「实词片段命中」──
// 原来 `lines[i].includes(q)`：问「被当众用滚水烫的那个媳妇」，整句当然不在账本里
// → 关键词 0 命中 → 25 道评估题全部被迫走向量（原来的问题一半在这里）。
// 现在：去掉疑问词/虚词，剩下的实词切 2 字片段，谁命中多谁靠前。
const STOP =
  /什么|怎么|为什么|哪个|哪些|那里|这里|这种|那种|一下|一种|一个|我们|你们|他们|她们|是不是|有没有|多少|那些|这些|时候|东西|事情|记得|说过|吗|呢|吧|啊|哦|呀|嘛|的|了|着|过|是|在|有|和|与|就|都|还|也|把|被|给|让|会|能|要|我|你|他|她|它|谁|几|个|上|下|里|中|而|但|又|很|最|更|不|没|无|所|以|为|对|从|到|向|于|其|之|这|那|哪|啥/g

function gramsOf(qq) {
  const s = String(qq).replace(STOP, ' ')
  const set = new Set()
  for (const part of s.split(/[\s，。、！？；：,.!?;:()（）"“”'']+/)) {
    if (!part) continue
    const low = part.toLowerCase()
    // 英文/数字整词（如 createUserMessage、TMA-1、184）
    if (/^[0-9a-z][0-9a-z._-]*$/.test(low)) {
      if (low.length >= 2) set.add(low)
      continue
    }
    for (let i = 0; i + 2 <= part.length; i++) {
      const g = part.slice(i, i + 2)
      if (/^[\u4e00-\u9fa5]{2}$/.test(g)) set.add(g)
    }
  }
  return [...set]
}

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.md') && !e.name.startsWith('_')) acc.push(p)
  }
  return acc
}

// ── 关键词：直接扫文件（600 KB，扫起来比调进程快）──
// 返回 { hits, total }：hits 只留前 SHOW_KW 条，total 是全量命中数。
function keywordHits() {
  const files = [
    // idx = 与 build-index 一致的 file 字段（weights.json 的 key 用它拼；rel 只用于显示）
    { p: LEDGER, rel: '账本', idx: 'whale-girl-memory.md' },
    // 2026-10-28：血肉（喜欢/讨厌/日常）也进关键词检索
    { p: path.join(BRAIN, '血肉.md'), rel: '血肉', idx: '血肉.md' },
    ...walk(ARCHIVE).map((p) => {
      const sub = p.slice(ARCHIVE.length + 1).replace(/\\/g, '/')
      return { p, rel: '归档/' + sub, idx: sub }
    }),
  ]
  const grams = gramsOf(q)
  const minScore = Math.min(2, Math.max(1, grams.length))
  const all = []
  let total = 0
  for (const f of files) {
    let text
    try {
      text = fs.readFileSync(f.p, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    let segKey = null
    let segTitle = ''
    for (let i = 0; i < lines.length; i++) {
      // 2026-10-28 ④：记住所属段的 key（最近的 "## " 行），命中按段权重排
      if (/^##\s+/.test(lines[i])) {
        segKey = (f.idx || f.rel) + ':' + (i + 1)
        segTitle = lines[i]
      }
      // 2026-10-29：整句包含 → 实词片段命中打分
      const low = lines[i].toLowerCase()
      let score = 0
      for (const g of grams) if (low.includes(g)) score++
      if (score < minScore) continue
      total++
      all.push({
        rel: f.rel,
        line: i + 1,
        score,
        text: lines[i].trim().slice(0, 160),
        key: segKey,
        b: segKey ? boost(segKey) : 0,
        // 2026-10-30 ⑧：时效只在平局时用，不参与主导排序
        decay: segKey ? decayOf(segTitle, H[segKey] || 0) : 1,
      })
    }
  }
  // 命中片段越多越前；同分再看 ★ 权重
  // 2026-10-30 ⑧：加「平局看新鲜度」实测退化（hit@1 68%→56%，3 题从 hit@1 掉到 hit@3/漏检），
  // 已回滚成原规则；--fresh 才启用，等参数调对再说。
  if (useFresh) all.sort((a, b) => cmp(a.score, b.score, a.decay, b.decay, 0.001) || b.b - a.b)
  else all.sort((a, b) => b.score - a.score || b.b - a.b)
  return { hits: all, total }
}

// ── 向量 ──
// 返回 { vec, total, related }：
//   total    = 索引里一共多少段
//   related  = 相似度 ≥ 0.5 的段数（含 top n 里那些）——用它算「还有多少相关没给」
const RELATED = 0.5
async function vectorHits(limit = n) {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.allowRemoteModels = CONFIG.allowRemoteModels
  env.localModelPath = CONFIG.modelDir
  env.cacheDir = path.join(CONFIG.modelDir, '..', 'models-cache')
  const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'))
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
  const out = await extractor([q], { pooling: 'mean', normalize: true })
  const v = out.tolist()[0]
  const dot = (a, b) => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += a[i] * b[i]
    return s
  }
  const scored = idx.items
    .map((it) => {
      const key = it.file + ':' + it.line
      return { it, key, s: dot(it.vec, v) + boost(key), decay: decayOf(it.title, H[key] || 0) }
    })
    // 2026-10-30 ⑧ 实测回滚（原因见 keywordHits 上方注释）：--fresh 才按新鲜度裁决
    .sort((a, b) => (useFresh ? cmp(a.s, b.s, a.decay, b.decay, 0.01) : b.s - a.s))
  const vec = scored.slice(0, limit).map(({ it, s, key }) => ({
    rel: it.src + '/' + it.file,
    line: it.line,
    key,
    weight: W[key] || 0,
    text: it.title + ' · ' + it.preview.slice(0, 100),
    score: s,
  }))
  const related = scored.filter((x) => x.s >= RELATED).length
  return { vec, total: scored.length, related }
}

const LC = loadLifecycle()
const statusTag = (h) =>
  h.status === 'dead'
    ? '【已作废】'
    : h.status === 'expired'
      ? '【已过期】'
      : h.status === 'superseded'
        ? `【已被 ${h.by} 覆盖】`
        : ''

// ── 2026-10-30 ⑦ RRF 两路融合 ──
// 关键词和向量的分数尺度完全不同（命中片段数 1~9 vs 余弦 0~1），
// 直接相加会被一方压死。RRF 只看名次：1/(60+名次) 相加，两条路都靠前的自然往前。
const RRF_K = 60
function rrfFuse(kw, vec, topN) {
  const M = new Map()
  kw.forEach((it, i) => {
    if (!it || !it.key) return
    const cur = M.get(it.key) || { key: it.key, ref: it }
    if (!cur.kw) cur.kw = i + 1
    M.set(it.key, cur)
  })
  vec.forEach((it, i) => {
    if (!it || !it.key) return
    const cur = M.get(it.key) || { key: it.key, ref: it }
    if (!cur.vec) cur.vec = i + 1
    M.set(it.key, cur)
  })
  const arr = [...M.values()].map((x) => ({
    ...x.ref,
    kwRank: x.kw || null,
    vecRank: x.vec || null,
    rrf: (x.kw ? 1 / (RRF_K + x.kw) : 0) + (x.vec ? 1 / (RRF_K + x.vec) : 0),
  }))
  arr.sort((a, b) => b.rrf - a.rrf)
  const live = arr.filter((x) => x.status !== 'dead' && x.status !== 'expired')
  const dead = arr.filter((x) => x.status === 'dead' || x.status === 'expired')
  return [...live, ...dead].slice(0, topN)
}

const { hits: kwAll, total: kwTotal } = vecOnly ? { hits: [], total: 0 } : keywordHits()
// 2026-10-30 ③：关键词结果先过生命周期（覆盖/作废/过期），再截断展示
const kwRanked = applyLifecycle(kwAll, LC)
const hits = kwRanked.slice(0, SHOW_KW)

// 有关键词命中且没带 --budget / --rrf 才早退；带了就继续走向量
if (hits.length >= 3 && budget === 0 && !useRrf) {
  console.log(`[关键词] 「${q}」命中 ${kwTotal} 条（下面给出 ${hits.length} 条）：\n`)
  for (const h of hits) console.log(`  ${h.rel}:${h.line}${'★'.repeat(W[h.key] || 0)}${statusTag(h)}  ${h.text}`)
  const rest = kwTotal - hits.length
  console.log('')
  if (rest > 0) console.log(`[缺失声明] 另有 ${rest} 条关键词命中未加载——我手上没有它们，别当成「只有这些」。`)
  else console.log(`[缺失声明] 关键词命中已全部给出（${kwTotal} 条）。`)
  const stale = hits.filter((h) => h.status !== 'live').length
  if (stale) console.log(`[生命周期] 上面 ${stale} 条已作废/过期/被覆盖，别直接当证据。`)
  recordHits(hits.filter((h) => h.status === 'live').map((h) => h.key))
  process.exit(0)
}

// 预算模式多取一些候选，才装得满
const { vec: vecRaw, total: allTotal, related } = await vectorHits(budget > 0 ? 200 : n)
// 2026-10-30 ③：向量结果也过生命周期（作废/过期的排到最后并标出来）
const vec = applyLifecycle(vecRaw, LC)

// 2026-10-30 ⑦：--rrf 融合模式（关键词 + 向量各按名次，RRF 合并）
if (useRrf) {
  const fused = rrfFuse(kwRanked, vec, n)
  console.log(`[融合] 「${q}」关键词 + 向量按 RRF（1/(60+名次)）合并，前 ${fused.length} 条：\n`)
  for (const it of fused) {
    const tag = `(kw#${it.kwRank || '-'}/vec#${it.vecRank || '-'})`
    console.log(`  ${it.rrf.toFixed(4)}${'★'.repeat(W[it.key] || 0)}${statusTag(it)}  ${it.key}  ${tag}\n           ${it.text}`)
  }
  console.log('')
  console.log(`[缺失声明] 融合只给前 ${fused.length} 条；关键词命中 ${kwTotal} 条，库里共 ${allTotal} 段。`)
  recordHits(fused.filter((x) => x.status === 'live').map((x) => x.key))
  process.exit(0)
}

if (hits.length) {
  console.log(`[关键词] 「${q}」只命中 ${hits.length} 条：\n`)
  for (const h of hits) console.log(`  ${h.rel}:${h.line}${'★'.repeat(W[h.key] || 0)}${statusTag(h)}  ${h.text}`)
  console.log('')
}

// 2026-10-30 ⑤：--budget 按字符预算装箱，装不下的写进标题（不静默丢）
if (budget > 0) {
  let used = 0
  let skipped = 0
  const packed = []
  for (const v of vec) {
    const line = `  ${v.score.toFixed(3)}${'★'.repeat(v.weight)}${statusTag(v)}  ${v.rel}:${v.line}\n           ${v.text}`
    if (used + line.length > budget) {
      skipped++ // 装不下就跳过这条、继续试下一条（短的可能还装得下）
      continue
    }
    used += line.length
    packed.push({ v, line })
  }
  console.log(`[向量·预算 ${budget} 字符] 「${q}」装进 ${packed.length} 段（用了 ${used} 字符），另有 ${skipped} 条未展开：\n`)
  for (const p of packed) console.log(p.line)
  const missing = Math.max(0, related - packed.length)
  console.log('')
  console.log(
    `[缺失声明] 相关（≥ ${RELATED}）共 ${related} 段，装进 ${packed.length} 段${missing > 0 ? `、另有 ${missing} 条相关没装下` : ''}；库里共 ${allTotal} 段。`
  )
} else {
  console.log(`[向量] 「${q}」最接近的 ${vec.length} 段：\n`)
  for (const v of vec) console.log(`  ${v.score.toFixed(3)}${'★'.repeat(v.weight)}${statusTag(v)}  ${v.rel}:${v.line}\n           ${v.text}`)

  const missing = Math.max(0, related - vec.length)
  console.log('')
  if (missing > 0) {
    console.log(
      `[缺失声明] 另有 ${missing} 条相关记忆（相似度 ≥ ${RELATED}）未加载；库里共 ${allTotal} 段，上面只给了最接近的 ${vec.length} 段。`
    )
  } else {
    console.log(
      `[缺失声明] 相关的都给了（相似度 ≥ ${RELATED} 的共 ${related} 段）；库里共 ${allTotal} 段，其余不相关，没加载。`
    )
  }
}
recordHits([...hits.filter((h) => h.status === 'live').map((h) => h.key), ...vec.filter((v) => v.status === 'live').map((v) => v.key)])
