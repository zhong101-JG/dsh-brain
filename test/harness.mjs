// 离线验证台：假 ctx 跑 dsh-brain 的 apply，看 systemPrompt section 能不能出文本、工具能不能注册。
// 用法：node test/harness.mjs
//   —— 宿主里 session 级快照看不到新 section，所以逻辑对不对只能靠这里验。
import path from 'node:path'

const mod = await import('../lib/index.js')

const sections = []
const tools = []
const scoped = {
  systemPrompt: { section: (s) => sections.push(s) },
  tools: { register: (t) => tools.push(t) },
  agents: { list: () => [] },
}
const ctx = {
  inject: (_deps, cb) => cb(scoped),
  effect: () => {},
}

mod.apply(ctx)

let fail = 0
for (const s of sections.sort((a, b) => a.order - b.order)) {
  const t = s.text()
  console.log(`── section ${s.name}（order ${s.order}，${t.length} 字）`)
  console.log(t.slice(0, 160).replace(/\n/g, ' ') + (t.length > 160 ? '…' : ''))
  if (s.name === 'brain:state' && !t.startsWith('[状态]')) {
    console.log('❌ 状态层没出文本')
    fail++
  }
  if (s.name === 'brain:persona' && !t.startsWith('[我是谁]')) {
    console.log('❌ 人格层没出文本')
    fail++
  }
}
console.log('tools:', tools.map((t) => t.name).join(', ') || '(none)')
if (!tools.some((t) => t.name === 'memory_recall')) {
  console.log('❌ memory_recall 没注册')
  fail++
}
console.log(fail ? `❌ 有 ${fail} 项失败` : '✅ 全部通过')
process.exit(fail ? 1 : 0)
