// dsh-brain · 记忆库自检（verify-memory）
// 一条命令看数据到底健康不健康。exit 0 = 全绿，exit 1 = 有红项。
// 用法：node tools/verify-memory.mjs
//
// 2026-10-30 定稿。借鉴了 SnowLuma 的 verify-data.mjs 思路，
// 但按我家的真结构改过：索引是「精选 + 可手改」，不是全量，所以不查「条数相等」，
// 查「每条指针都指得到真行」。
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from '../lib/config.mjs'

const BRAIN = CONFIG.dataDir
const LEDGER = CONFIG.ledger
const LEDGER_NAME = path.basename(CONFIG.ledger)
const INDEX_MD = path.join(BRAIN, '索引.md')
const CUR = path.join(BRAIN, '当前记忆')
const IDXDIR = CONFIG.indexDir
const WEIGHTS = path.join(IDXDIR, 'weights.json')
const VECTORS = path.join(IDXDIR, 'vectors.json')
const BACKUP = path.join(BRAIN, '_backup')

const results = []
const check = (name, ok, detail) => results.push({ name, ok, detail })
const warn = []
const readText = (p) => fs.readFileSync(p, 'utf8')

// ── 1. 账本 ──
let segs = []
let ledgerLines = 0
try {
  const text = readText(LEDGER)
  const lines = text.split(/\r?\n/)
  ledgerLines = lines.length
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (/^##\s+/.test(ln)) {
      if (cur) segs.push(cur)
      const raw = ln.replace(/^##\s+/, '').trim()
      const starM = raw.match(/(★+)\s*$/)
      cur = {
        line: i + 1,
        title: raw.replace(/^~\s*/, '').replace(/\s*★+\s*$/, ''),
        forget: raw.startsWith('~'),
        stars: starM ? starM[1].length : 0,
        body: 0,
      }
    } else if (cur) {
      if (ln.trim()) cur.body++
    }
  }
  if (cur) segs.push(cur)

  // 半截行：替换符 / 不以换行收尾 / 空标题段
  const badChars = (text.match(/\uFFFD/g) || []).length
  const endWithNewline = text.endsWith('\n') || text.endsWith('\r\n')
  const emptySegs = segs.filter((s) => s.body === 0)
  const ok = !badChars && endWithNewline && emptySegs.length === 0
  check('账本', ok, `${segs.length} 段 / ${ledgerLines} 行 · 坏字符 ${badChars} · 末行换行 ${endWithNewline ? '有' : '无'} · 空段 ${emptySegs.length}`)
  if (badChars) warn.push(`账本里有 ${badChars} 个编码替换符（\uFFFD），可能是写入被截断`)
  if (!endWithNewline) warn.push('账本末尾没有换行——可能是最后一次追加被截断')
  if (emptySegs.length) warn.push(`空段：${emptySegs.map((s) => s.line + ':' + s.title).join('，')}`)
} catch (e) {
  check('账本', false, `读不了：${e.message}`)
}

// ── 2. 索引指针 ──
try {
  const lines = readText(INDEX_MD).split(/\r?\n/)
  const cache = new Map()
  const pins = []
  for (const ln of lines) {
    if (!/^\|/.test(ln) || /^\|\s*-/.test(ln) || /日期/.test(ln)) continue
    const cells = ln.split('|').map((s) => s.trim())
    const pin = cells[3] || ''
    const m = pin.match(/^(.+?):(\d+)$/)
    if (m) pins.push({ file: m[1], line: Number(m[2]), at: pin })
  }
  const broken = []
  for (const p of pins) {
    if (!cache.has(p.file)) {
      const f = path.join(CUR, p.file)
      cache.set(p.file, fs.existsSync(f) ? readText(f).split(/\r?\n/).length : null)
    }
    const total = cache.get(p.file)
    if (total === null) broken.push(`${p.at}（文件不存在）`)
    else if (p.line > total) broken.push(`${p.at}（超出 ${total} 行）`)
  }
  check('索引指针', broken.length === 0, `${pins.length} 条指针 · ${broken.length} 条断`)
  if (broken.length) warn.push('索引断链：' + broken.slice(0, 5).join('，') + (broken.length > 5 ? ` 等 ${broken.length} 条` : ''))
} catch (e) {
  check('索引指针', false, `读不了：${e.message}`)
}

// ── 3. weights.json ──
try {
  const w = JSON.parse(readText(WEIGHTS))
  const keys = Object.keys(w.weights || {})
  const ledgerLinesArr = readText(LEDGER).split(/\r?\n/)
  const bad = keys.filter((k) => {
    const [file, lineStr] = k.split(/:(?=\d+$)/)
    if (file !== LEDGER_NAME) return false // 归档/读书卡的权重不在这里校验
    const ln = ledgerLinesArr[Number(lineStr) - 1]
    return !ln || !/^##\s+/.test(ln)
  })
  check('weights', bad.length === 0, `${keys.length} 个 key · ${bad.length} 个指不到 ## 行`)
  if (bad.length) warn.push('weights 失配：' + bad.slice(0, 5).join('，'))
} catch (e) {
  check('weights', false, `读不了/不是 JSON：${e.message}`)
}

// ── 4. 可忘段 vs 向量索引 ──
try {
  const forgetSegs = segs.filter((s) => s.forget)
  const st = fs.statSync(VECTORS)
  const sizeMB = st.size / 1024 / 1024
  if (sizeMB > 80) {
    check('可忘段', true, `${forgetSegs.length} 个 ~ 段 · 向量库 ${sizeMB.toFixed(1)} MB（太大，跳过内容核对）`)
    warn.push(`向量库 ${sizeMB.toFixed(1)} MB，本次没做「~ 段是否混进索引」核对`)
  } else {
    const idx = JSON.parse(readText(VECTORS))
    const inIdx = new Set((idx.items || []).map((it) => it.file + ':' + it.line))
    const leaked = forgetSegs.filter((s) => inIdx.has(LEDGER_NAME + ':' + s.line))
    check('可忘段', leaked.length === 0, `${forgetSegs.length} 个 ~ 段 · 混进向量索引 ${leaked.length} 个`)
    if (leaked.length) warn.push(`可忘段混进索引：${leaked.map((s) => s.line + ':' + s.title).join('，')}`)
  }
} catch (e) {
  check('可忘段', false, `向量库读不了：${e.message}`)
}

// ── 4.4 核心段上限（2026-10-30 ⑧）──
try {
  const core = segs.filter((s) => s.stars === 3)
  const CAP = 10
  check('核心段', core.length <= CAP, `${core.length} 个 ★★★（上限 ${CAP}）`)
  if (core.length > CAP) warn.push(`★★★ 超了 ${core.length - CAP} 个——该挑几条降级（append-only：只能降级，删不了）`)
} catch (e) {
  check('核心段', false, `算不出来：${e.message}`)
}

// ── 4.5 生命周期（2026-10-30 ③）──
try {
  const p = path.join(BRAIN, '_index', 'lifecycle.json')
  if (!fs.existsSync(p)) {
    check('生命周期', true, '还没用过（没有 lifecycle.json）')
  } else {
    const lc = JSON.parse(readText(p))
    const sup = Object.keys(lc.superseded || {})
    const dead = Object.keys(lc.dead || {})
    const exp = Object.keys(lc.expire || {})
    const known = new Set([LEDGER_NAME, '血肉.md'])
    try {
      const root = path.join(BRAIN, '归档记忆')
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name)
          if (e.isDirectory()) walk(fp)
          else if (e.name.endsWith('.md') && !e.name.startsWith('_'))
            known.add(fp.slice(root.length + 1).replace(/\\/g, '/'))
        }
      }
      walk(root)
    } catch {}
    const bad = [...sup, ...dead, ...exp].filter((k) => {
      const i = k.lastIndexOf(':')
      if (i < 0) return true
      return !known.has(k.slice(0, i)) || !Number.isFinite(Number(k.slice(i + 1)))
    })
    const badBy = sup.filter((k) => {
      const by = lc.superseded[k] && lc.superseded[k].by
      return by && !known.has(String(by).slice(0, String(by).lastIndexOf(':')))
    })
    check('生命周期', bad.length === 0 && badBy.length === 0, `覆盖 ${sup.length} · 作废 ${dead.length} · 限期 ${exp.length} · 坏 key ${bad.length + badBy.length}`)
    if (bad.length) warn.push('lifecycle 坏 key：' + bad.slice(0, 5).join('，'))
  }
} catch (e) {
  check('生命周期', false, `读不了：${e.message}`)
}

// ── 4.6 工作记忆（2026-10-30 ④）──
try {
  const p = path.join(BRAIN, '工作记忆.json')
  if (!fs.existsSync(p)) {
    check('工作记忆', true, '还没用过')
  } else {
    const db = JSON.parse(readText(p))
    const items = Array.isArray(db.items) ? db.items : []
    const bad = items.filter((it) => !it.id || !it.text || !it.lastTouched)
    const open = items.filter((it) => !it.doneAt).length
    check('工作记忆', bad.length === 0, `${items.length} 条（未完成 ${open}）· 坏条目 ${bad.length}`)
  }
} catch (e) {
  check('工作记忆', false, `读不了：${e.message}`)
}

// ── 5. 临时残渣 ──
try {
  const scans = [IDXDIR, BRAIN]
  const tmps = []
  const oldBaks = []
  const now = Date.now()
  for (const d of scans) {
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (/\.tmp$/i.test(f)) tmps.push(p)
      if (/\.bak-\d/.test(f) && now - st.mtimeMs > 7 * 86400_000) oldBaks.push(`${f}（${Math.floor((now - st.mtimeMs) / 86400_000)} 天）`)
    }
  }
  check('临时残渣', tmps.length === 0, `.tmp ${tmps.length} 个 · 7 天以上 .bak ${oldBaks.length} 个`)
  if (tmps.length) warn.push('残留临时文件：' + tmps.slice(0, 5).join('，'))
  if (oldBaks.length) warn.push('陈旧 .bak：' + oldBaks.slice(0, 5).join('，'))
} catch (e) {
  check('临时残渣', false, `扫描失败：${e.message}`)
}

// ── 6. 备份 ──
try {
  const packs = fs.readdirSync(BACKUP).filter((f) => /^whale-memory-.*\.tar\.gz$/.test(f)).sort()
  const latest = packs.length ? packs[packs.length - 1] : '（无）'
  const st = packs.length ? fs.statSync(path.join(BACKUP, latest)) : null
  const ageH = st ? (Date.now() - st.mtimeMs) / 3600_000 : Infinity
  const ok = packs.length > 0 && packs.length <= 20
  check('备份', ok, `${packs.length} 份 · 最新 ${latest}${st ? `（${ageH.toFixed(0)} 小时前）` : ''}`)
  if (!packs.length) warn.push('一个备份包都没有')
  if (ageH > 24 * 7) warn.push(`最新备份已 ${ageH.toFixed(0)} 小时前——该打一份了`)
} catch (e) {
  check('备份', false, `读不了：${e.message}`)
}

// ── 汇总 ──
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
console.log(`记忆库自检 · ${stamp}\n`)
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(6)}  ${r.detail}`)
const pass = results.filter((r) => r.ok).length
console.log(`\n结论：${pass}/${results.length} 项通过`)
if (warn.length) {
  console.log('\n提醒：')
  for (const w of warn) console.log('  · ' + w)
}
process.exit(pass === results.length ? 0 : 1)
