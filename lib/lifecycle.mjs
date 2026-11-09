// dsh-brain · 记忆生命周期（覆盖 / 作废 / 过期）
// 2026-10-30 借鉴「大肥鱼记忆星图」那套规则，按我家结构落地：
//
//   superseded = 同一件事，后说的盖过先说的
//                （分数减半、标注「已被 X 覆盖」、保留可查——不删）
//   dead       = 说了「记错了」，立刻作废
//                （召回时排最后并标「已作废」，不静默消失——不知道有这条比知道它错了更危险）
//   expire     = 写过具体日期的约定，到点自动失效
//
// 账本 append-only 一个字不动，状态只记在这里（_index/lifecycle.json）。
// key 的格式跟 build-index / recall 一致：`文件:行号`，如 `whale-girl-memory.md:1501`
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from './atomic.mjs'
import { CONFIG } from './config.mjs'

export const FILE = path.join(CONFIG.indexDir, 'lifecycle.json')

export const today = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return {
      at: j.at || '',
      superseded: j.superseded || {},
      dead: j.dead || {},
      expire: j.expire || {},
    }
  } catch {
    return { at: '', superseded: {}, dead: {}, expire: {} }
  }
}

export function save(lc) {
  writeAtomic(FILE, JSON.stringify({ at: new Date().toISOString(), ...lc }, null, 2))
}

// 纯函数，方便单测：给定命中项和规则，返回标注了 status 的列表（已按分数重排）
// items: [{ key, score, ... }]
export function applyLifecycle(items, lc, now = today()) {
  const out = []
  for (const it of items) {
    const key = it.key
    if (!key) {
      out.push({ ...it, status: 'live' })
      continue
    }
    if (lc.dead[key]) {
      out.push({ ...it, score: -1, status: 'dead', why: lc.dead[key].reason || lc.dead[key].why || '' })
      continue
    }
    const ex = lc.expire[key]
    if (ex && ex.until && ex.until <= now) {
      out.push({ ...it, score: -1, status: 'expired', why: ex.reason || '' })
      continue
    }
    const sup = lc.superseded[key]
    if (sup) {
      out.push({ ...it, score: (it.score || 0) * 0.5, status: 'superseded', by: sup.by || '', why: sup.reason || '' })
      continue
    }
    out.push({ ...it, status: 'live' })
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0))
}

// 汇总一行状态，给 verify 和 --lifecycle 用
export function summary(lc) {
  const n = (o) => Object.keys(o || {}).length
  return `覆盖 ${n(lc.superseded)} · 作废 ${n(lc.dead)} · 限期 ${n(lc.expire)}`
}

export function markDup(lc, oldKey, newKey, why) {
  if (!oldKey || !newKey) throw new Error('--mark-dup 需要两个 key：旧的 和 覆盖它的')
  if (oldKey === newKey) throw new Error('两个 key 一样，覆盖不了自己')
  lc.superseded[oldKey] = { by: newKey, at: today(), reason: why || '' }
  delete lc.dead[oldKey]
  return lc
}

export function markDead(lc, key, why) {
  if (!key) throw new Error('--mark-dead 需要一个 key')
  lc.dead[key] = { at: today(), reason: why || '' }
  delete lc.superseded[key]
  return lc
}

export function markExpire(lc, key, until, why) {
  if (!key) throw new Error('--mark-expire 需要一个 key')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '')) throw new Error('--until 要写成 YYYY-MM-DD')
  lc.expire[key] = { until, at: today(), reason: why || '' }
  return lc
}

// 清掉过期的限期条目（今天一过就没用了，留着只是噪音）
export function sweep(lc, now = today()) {
  let n = 0
  for (const [k, v] of Object.entries(lc.expire)) {
    if (v.until && v.until < now) {
      delete lc.expire[k]
      n++
    }
  }
  return n
}
