/**
 * 章节分块。
 *
 * 检索的单位不能是「整章」：一章 3000 字里可能只有一段与当前情节相关，
 * 整章注入会把预算全花在无关段落上。也不能是固定滑窗：写小说时句号、
 * 段落是天然的语义边界，从半句话开始的分块既难读又会让模型误解上下文。
 *
 * 所以策略是「**段落优先、句子兜底、整句重叠**」：
 *   1. 按空行/换行切段；
 *   2. 超过目标长度的段落按句末标点再切；
 *   3. 仍然超长的「句子」（几乎没有标点的长段）按目标长度硬切，
 *      但绝不切坏代理对（emoji 等多字节字符）；
 *   4. 装块时以**整句**为单位累积，重叠也按整句回退 —— 这样每个分块
 *      都能独立阅读，且相邻块之间有上下文衔接。
 *
 * 输出里的 `start/end` 是**原文中的字符下标**，供界面跳转与以后做
 * 「高亮召回位置」用。全部是纯函数，不读库。
 */

export const DEFAULT_CHUNK_CHARS = 500
export const DEFAULT_OVERLAP_CHARS = 80
export const DEFAULT_MAX_CHUNKS = 200

const SENTENCE_END = '。！？!?…；;'
const CLOSERS = '”’」』）)】》"\''

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '　'
}

/** 去掉首尾空白，同时把下标一起收进来。 */
function trimRange(content, start, end) {
  let s = start
  let e = end
  while (s < e && isSpace(content[s])) s++
  while (e > s && isSpace(content[e - 1])) e--
  return { start: s, end: e }
}

function pushUnit(units, content, start, end, targetChars) {
  const { start: ts, end: te } = trimRange(content, start, end)
  if (te <= ts) return
  if (te - ts <= targetChars) {
    units.push({ start: ts, end: te })
    return
  }
  // 超长「句子」：按目标长度硬切。避免切在代理对中间；若切点落在高代理项
  // 之前一位，退一格。极端情况下（目标长度 1 且全是 emoji）保证前进。
  let s = ts
  while (s < te) {
    let e = Math.min(te, s + targetChars)
    if (e < te && isHighSurrogate(content.charCodeAt(e - 1))) e--
    if (e <= s) e = Math.min(te, s + 1)
    const r = trimRange(content, s, e)
    if (r.end > r.start) units.push(r)
    s = e
  }
}

/** 把一段（段落内）按句末标点切成单元。 */
function pushSentences(units, content, start, end, targetChars) {
  let segStart = start
  let i = start
  while (i < end) {
    const cp = content.codePointAt(i)
    const width = cp > 0xffff ? 2 : 1
    const ch = content[i]
    if (SENTENCE_END.includes(ch) || ch === '\n' || ch === '\r') {
      let e = i + width
      // 把紧跟的右引号/右括号并进同一句：「他说：『走。』」不应在句号后断开
      while (e < end && CLOSERS.includes(content[e])) e++
      pushUnit(units, content, segStart, e, targetChars)
      segStart = e
      i = e
      continue
    }
    i += width
  }
  pushUnit(units, content, segStart, end, targetChars)
}

function buildUnits(content, targetChars) {
  const units = []
  let paraStart = 0
  for (let i = 0; i <= content.length; i++) {
    const ch = i < content.length ? content[i] : '\n'
    if (ch === '\n' || ch === '\r') {
      if (i > paraStart) pushSentences(units, content, paraStart, i, targetChars)
      paraStart = i + 1
    }
  }
  return units
}

/**
 * 把一章切成检索块。
 *
 * 参数上限由设置页约束（chunkChars 200–2000、overlap < chunkChars），但这里
 * 仍然自己夹一次：分块函数是纯函数，不能信任调用方一定传了合法值。
 *
 * 重叠长度夹到目标长度的一半：重叠不比半个块小的话，滑窗每步只前进一两句，
 * 会产生大量几乎相同的块 —— 既浪费存储，又会让检索结果被同一段文字刷屏。
 */
export function chunkChapter(
  chapter,
  {
    targetChars = DEFAULT_CHUNK_CHARS,
    overlapChars = DEFAULT_OVERLAP_CHARS,
    maxChunks = DEFAULT_MAX_CHUNKS
  } = {}
) {
  const content = String((typeof chapter === 'string' ? chapter : chapter?.content) ?? '')
  if (!content.trim()) return []

  const target = Math.max(50, Math.round(Number(targetChars) || DEFAULT_CHUNK_CHARS))
  const overlapLimit = Math.max(0, Math.min(Math.round(Number(overlapChars) || 0), Math.floor(target / 2)))
  const limit = Math.max(1, Math.round(Number(maxChunks) || DEFAULT_MAX_CHUNKS))

  const units = buildUnits(content, target)
  if (!units.length) return []

  const chunks = []
  let buf = []
  let i = 0

  const emit = () => {
    if (!buf.length) return
    const start = buf[0].start
    const end = buf[buf.length - 1].end
    const text = content.slice(start, end).trim()
    if (text) chunks.push({ text, start, end })
  }

  while (i < units.length && chunks.length < limit) {
    const u = units[i]
    const len = u.end - u.start
    if (buf.length && buf[buf.length - 1].end - buf[0].start + len > target) {
      emit()
      // 按整句回退出重叠部分；回退量不超过 overlapLimit。
      const overlap = []
      let olen = 0
      for (let k = buf.length - 1; k >= 0; k--) {
        const l = buf[k].end - buf[k].start
        if (olen + l > overlapLimit) break
        overlap.unshift(buf[k])
        olen += l
      }
      // 不允许整块都是重叠：否则这一轮没有前进，会原地打转。
      if (overlap.length >= buf.length) overlap.splice(0, 1)
      buf = overlap
      if (chunks.length >= limit) break
      // 不 i++，让同一个单元在新的（更短的）缓冲区里重新判断。
      if (!buf.length) continue
      // 重叠部分加上这一单元仍超长时，再走一次循环把它发出去；但若重叠
      // 已经缩到装得下，就正常追加。两种情况都不会死循环。
      continue
    }
    buf.push(u)
    i++
  }
  emit()
  return chunks.slice(0, limit)
}
