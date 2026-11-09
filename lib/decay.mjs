// dsh-brain · 时效（记忆衰减）
// 2026-10-30：原本想照抄七池半衰期做「全局降权」，推了一遍发现**在我家空转**：
//   大多数段没有 ★，boost 本来就是 0，乘任何衰减系数还是 0。
//   而且拿衰减去压相关度，会让「老的即使相关也排不到前面」——那是错的。
// 所以缩成一条：**只在平局时用**（跟 dsh-chain 自己写的「新鲜度只做平局裁决」一致）。
//
// 分档（按自家数据定，不是照抄）：
//   ★★★ ∞ / ★★ 730 天 / ★ 365 天 / 无星 180 天
//   被反复想起的会拉长半衰期：× min(4, 1 + 0.6·log2(1+次数))

const HALF_LIFE = [180, 365, 730, Infinity] // 索引 = ★ 数量（0~3）
const TIE = 0.01

export function daysSince(title, now = new Date()) {
  const m = String(title).match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)
  if (Number.isNaN(t.getTime())) return null
  return Math.max(0, (now - t) / 86400_000)
}

// 返回 0~1：1 = 刚写的；越小越旧。标题没日期就返回 1（不参与裁决）
export function decayOf(title, hits = 0, now = new Date()) {
  const stars = Math.min(3, ((String(title).match(/★+\s*$/) || [''])[0].trim().length))
  const half = HALF_LIFE[stars]
  if (!Number.isFinite(half)) return 1
  const days = daysSince(title, now)
  if (days === null) return 1
  const mult = Math.min(4, 1 + 0.6 * Math.log2(1 + hits))
  return Math.exp(-days / (half * mult))
}

// 平局裁决：主分差超过阈值就按主分，否则新的优先
// 用法：list.sort((a, b) => cmp(a.score, b.score, a.decay, b.decay, 0.01))
export function cmp(scoreA, scoreB, decayA, decayB, tie = TIE) {
  const d = scoreB - scoreA
  if (Math.abs(d) > tie) return d
  return decayB - decayA
}
