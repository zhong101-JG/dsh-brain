// writeAtomic / appendDurable 的验收测试（2026-10-30）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeAtomic, appendDurable } from '../lib/atomic.mjs'

const dir = path.join(os.tmpdir(), 'dsh-brain-atomic-test')
fs.mkdirSync(dir, { recursive: true })
for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true })

// 1) 正常写：内容读回一致，目录里不留 .tmp
const f1 = path.join(dir, 'ok.json')
writeAtomic(f1, JSON.stringify({ a: 1, zh: '小鲸歌' }))
const back = JSON.parse(fs.readFileSync(f1, 'utf8'))
const tmpLeft1 = fs.readdirSync(dir).filter((x) => x.endsWith('.tmp'))
console.log(`1) 正常写        ${back.a === 1 && back.zh === '小鲸歌' ? 'OK' : 'FAIL'} · 残留 .tmp ${tmpLeft1.length} 个`)

// 2) 失败路径：写到不存在的盘，必须抛错且不留文件/垃圾
const before2 = fs.readdirSync(dir).sort()
let code = 'no-throw'
try {
  writeAtomic('Z:\\不存在的盘\\x.json', 'x')
} catch (e) {
  code = e.code || e.message
}
const added = fs.readdirSync(dir).filter((x) => !before2.includes(x))
console.log(`2) 失败路径      ${code === 'ENOENT' ? 'OK' : 'FAIL（' + code + '）'} · 新增文件 ${added.length} 个（${added.join(',') || '无'}）`)

// 3) 追加写：两行都落盘、顺序对
const f3 = path.join(dir, 'append.txt')
fs.writeFileSync(f3, '')
appendDurable(f3, '## a\r\n')
appendDurable(f3, '## b\r\n')
console.log(`3) 追加写        ${fs.readFileSync(f3, 'utf8') === '## a\r\n## b\r\n' ? 'OK' : 'FAIL'}`)

// 4) 覆盖写：旧文件被整个替换，不出现半旧半新
const f4 = path.join(dir, 'overwrite.json')
fs.writeFileSync(f4, JSON.stringify({ old: true, pad: 'x'.repeat(500) }))
writeAtomic(f4, JSON.stringify({ new: true }))
const o4 = JSON.parse(fs.readFileSync(f4, 'utf8'))
console.log(`4) 覆盖写        ${o4.new === true && o4.old === undefined ? 'OK' : 'FAIL'}`)

fs.rmSync(dir, { recursive: true, force: true })
