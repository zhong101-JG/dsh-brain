// dsh-brain · 工作记忆（待办 / 承诺）
// 2026-10-30 借鉴 dsh-chain 的「工作记忆块」，按我家结构落地：
//   - 不自动从对话里正则认（我比正则准），由我主动记
//   - 最多展示 3 条；3 天没提起自动过期；说「做好了」就划掉
//   - 不进记忆链、不进星图——待办不该参与衰减统计
//
// 用法：
//   node tools/working.mjs                          列出来（最多 3 条）
//   node tools/working.mjs --all                    全列
//   node tools/working.mjs add "记得月末提醒存档" --due 2026-10-31
//   node tools/working.mjs add "明天把方案发你" --kind promise
//   node tools/working.mjs done 1                   做完 1 号
//   node tools/working.mjs touch 1                  又提起了一次（刷新保鲜期）
//   node tools/working.mjs prune                    清掉过期的 / 做完太久的
import fs from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../lib/atomic.mjs'
import { CONFIG } from '../lib/config.mjs'

const BRAIN = CONFIG.dataDir
const FILE = path.join(BRAIN, '工作记忆.json')
const SHOW_MAX = 3
const STALE_DAYS = 3
const DONE_KEEP_DAYS = 7

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const daysAgo = (s) => Math.floor((Date.now() - new Date(s + 'T00:00:00').getTime()) / 86400_000)

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return { at: j.at || '', items: Array.isArray(j.items) ? j.items : [] }
  } catch {
    return { at: '', items: [] }
  }
}
function save(db) {
  db.at = new Date().toISOString()
  writeAtomic(FILE, JSON.stringify(db, null, 2))
}

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : ''
}
const cmd = args.find((a) => !a.startsWith('-')) || 'list'
const db = load()
const today = ymd()

const isExpired = (it) => !it.doneAt && daysAgo(it.lastTouched) > STALE_DAYS

function show(list, total) {
  if (!total) {
    console.log('【还没做完的事】空了。')
    return
  }
  const more = total - list.length
  console.log(`【还没做完的事】${total} 条${more > 0 ? `（另有 ${more} 条未展开，--all 看全部）` : ''}\n`)
  for (const it of list) {
    const age = daysAgo(it.lastTouched)
    const due = it.dueBy ? ` 到 ${it.dueBy}` : ''
    const tag = isExpired(it) ? '【已过期，prune 会清】' : ''
    console.log(`  #${it.id} ${it.kind === 'promise' ? '承诺' : '待办'} · ${it.text}${due}（${age} 天前）${tag}`)
  }
}

if (cmd === 'add') {
  const body = args[1]
  if (!body) {
    console.error('用法: node tools/working.mjs add "要做的事" [--kind promise] [--due 2026-10-31]')
    process.exit(1)
  }
  const nextId = db.items.length ? Math.max(...db.items.map((x) => x.id)) + 1 : 1
  db.items.push({
    id: nextId,
    text: body,
    kind: flag('--kind') === 'promise' ? 'promise' : 'todo',
    createdAt: today,
    lastTouched: today,
    dueBy: flag('--due') || null,
    doneAt: null,
  })
  save(db)
  console.log(`记下了：#${nextId} ${body}`)
  process.exit(0)
}

if (cmd === 'done') {
  const it = db.items.find((x) => x.id === Number(args[1]))
  if (!it) {
    console.error(`没有 #${args[1]}`)
    process.exit(1)
  }
  it.doneAt = today
  save(db)
  console.log(`划掉：#${it.id} ${it.text}`)
  process.exit(0)
}

if (cmd === 'touch') {
  const it = db.items.find((x) => x.id === Number(args[1]))
  if (!it) {
    console.error(`没有 #${args[1]}`)
    process.exit(1)
  }
  it.lastTouched = today
  save(db)
  console.log(`续期：#${it.id}`)
  process.exit(0)
}

if (cmd === 'prune') {
  const before = db.items.length
  db.items = db.items.filter((it) => {
    if (it.doneAt && daysAgo(it.doneAt) > DONE_KEEP_DAYS) return false
    if (isExpired(it)) return false
    return true
  })
  save(db)
  console.log(`清掉 ${before - db.items.length} 条（做完超 ${DONE_KEEP_DAYS} 天 / 超 ${STALE_DAYS} 天没提起），剩 ${db.items.length} 条。`)
  process.exit(0)
}

// 默认 list
const open = db.items.filter((it) => !it.doneAt)
open.sort((a, b) => {
  const ad = a.dueBy ? 1 : 0
  const bd = b.dueBy ? 1 : 0
  return bd - ad || a.lastTouched.localeCompare(b.lastTouched)
})
if (args.includes('--all')) show(open, open.length)
else show(open.slice(0, SHOW_MAX), open.length)
