// dsh-brain · 一键备份（打成压缩包）
// 把「我」收进临时目录 → tar -czf 打成一个包 → 放进 脑袋瓜\_backup\
// → 清掉临时目录 → 弹开 _backup 文件夹（方便直接拖去云盘）。
// ⚠️ 包内文件名一律用英文：中文名进 tar 会因代码页不同而乱码（2026-10-25 实测）。
// 用法：node lib/backup.mjs [--no-open]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { CONFIG } from './config.mjs'

const HOME = os.homedir()
const BRAIN = CONFIG.dataDir
const BK = path.join(BRAIN, '_backup')
const STAGE = path.join(BK, '_stage')
const KEEP = 20
// tar：Windows 用系统自带的；其它平台交给 PATH（tar 基本都有）
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const tgz = path.join(BK, `whale-memory-${stamp}.tar.gz`)

// 只打「存在」的文件：用户没配的文件跳过（原来就是 try/catch 静默跳过）
const files = [
  [CONFIG.ledger, 'ledger.md'],
  [CONFIG.persona, 'persona.md'],
  [CONFIG.state, 'state.md'],
  [path.join(BRAIN, '索引.md'), 'index.md'],
  [path.join(HOME, '.dsh', 'AGENTS.md'), 'AGENTS.md'],
]
const dirs = [
  [path.join(BRAIN, '当前记忆'), 'current'],
]

fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

let n = 0
for (const [src, name] of files) {
  try { fs.copyFileSync(src, path.join(STAGE, name)); n++ } catch {}
}
for (const [src, name] of dirs) {
  try { fs.cpSync(src, path.join(STAGE, name), { recursive: true }); n++ } catch {}
}

fs.writeFileSync(
  path.join(STAGE, 'README.txt'),
  [
    'dsh-brain · 记忆快照',
    `打包时间：${stamp}`,
    '',
    '包内对照：',
    '  ledger.md    = 账本（config.json 里 ledger 指向它）',
    '  persona.md   = 人格（可选）',
    '  state.md     = 状态层（可选）',
    '  AGENTS.md    = 全局约定（~/.dsh/AGENTS.md，可选）',
    '  index.md     = 记忆索引（可选）',
    '  current/     = 当前记忆（按月切好的账本副本，可选）',
    '',
    '恢复：解包后按上面的对照放回原位即可。',
  ].join('\r\n'),
  'utf8'
)

execFileSync(TAR, ['-czf', tgz, '-C', STAGE, '.'], { timeout: 120000 })
fs.rmSync(STAGE, { recursive: true, force: true })

// 只留最近 KEEP 个包
try {
  const all = fs.readdirSync(BK).filter((f) => /^whale-memory-.*\.tar\.gz$/.test(f)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.rmSync(path.join(BK, old), { force: true })
  }
} catch {}

const size = fs.statSync(tgz).size
console.log(`备份完成 → ${tgz}（${n} 项，${(size / 1024).toFixed(1)} KB）`)

if (!process.argv.includes('--no-open')) {
  execFile('explorer.exe', [BK], () => {})
}
