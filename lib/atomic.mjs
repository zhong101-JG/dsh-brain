// dsh-brain · 落盘原子化（借鉴 SnowLuma 那套 verify-data 的思路，2026-10-30 小鲸歌改）
//
// 为什么：
//   整文件重写（weights.json / vectors.json / hits.json）时如果断电，
//   直接 writeFileSync 会留下「写了一半」的文件——JSON 解析直接炸。
//   换成「唯一临时文件 → fsync → rename」，rename 是原子的，断电只会剩旧文件或新文件，不会剩半截。
//
// 用法：
//   import { writeAtomic, appendDurable } from './atomic.mjs'
//   writeAtomic('<indexDir>/weights.json', JSON.stringify(w))
//   appendDurable('<dataDir>/ledger.md', '## 新的一段\r\n', 'utf8')
import fs from 'node:fs'
import path from 'node:path'

// 整文件原子替换：失败会先清掉临时文件再抛错（不往目录里留垃圾）
export function writeAtomic(file, data, encoding = 'utf8') {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, data, encoding)
    fs.fsyncSync(fd) // 数据先真正落到盘，再 rename
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file) // Windows 上用 MoveFileEx，覆盖语义
  } catch (e) {
    try {
      if (fd !== null) fs.closeSync(fd)
    } catch {}
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw e
  }
}

// 追加写也要 fsync：账本是 append-only，不能用「临时文件 + rename」（那是整本重写）
// 这里只保证「这一行写完就落盘」，断电最多丢最后没写完的那次调用。
export function appendDurable(file, data, encoding = 'utf8') {
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeFileSync(fd, data, encoding)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
