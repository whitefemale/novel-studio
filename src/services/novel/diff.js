import { countWords } from '../wordCount.js'

/**
 * 文本差异：行级 LCS，中文长行按句再切一层。
 *
 * 为什么不是「字符级 diff」：中文正文一改就是成段重写，字符级 diff 会把一整段
 * 拆成几十条互不相关的增删，读者反而看不出改了什么；行/段级更接近作者的修改单位。
 *
 * 纯函数、无 I/O，结果确定 —— 版本面板与审校修复预览共用同一份实现，否则两处
 * 对同一组文本会给出不同的「改了什么」。
 */

/** 超过这个规模就不做完整 LCS：O(n·m) 的矩阵会把界面卡死。 */
const MAX_CELLS = 4_000_000

/** 单行超过这个长度时按句切分，避免「整段一行」时 diff 变成全删全增。 */
const LONG_LINE = 120

/** 统一换行、按行切开。空文本返回空数组（不是 ['']，否则空 vs 空会多一行）。 */
export function splitLines(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!s) return []
  return s.split('\n')
}

/**
 * 把一行切成句子。只在超长行上使用。
 * 标点保留在前一句末尾，这样 diff 片段本身仍然可读。
 */
export function splitSentences(line) {
  const s = String(line ?? '')
  if (s.length <= LONG_LINE) return [s]
  const out = []
  let buf = ''
  for (const ch of s) {
    buf += ch
    if ('。！？；…!?;'.includes(ch)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out
}

/** 供 diff 使用的逻辑行：长行先按句切，其余原样。 */
export function diffLinesOf(text) {
  const lines = []
  for (const line of splitLines(text)) {
    for (const part of splitSentences(line)) lines.push(part)
  }
  return lines
}

/**
 * 行级 LCS。返回 `{ lines, stats }`：
 *   lines: [{ type: 'equal'|'add'|'del', text, aLine, bLine }]
 *   stats: { added, removed, unchanged, beforeWords, afterWords, beforeChars, afterChars }
 *
 * `aLine` / `bLine` 是从 1 开始的行号；`add` 只有 bLine，`del` 只有 aLine。
 */
export function diffText(before, after) {
  const a = diffLinesOf(before)
  const b = diffLinesOf(after)

  let rows = []
  if (a.length * b.length > MAX_CELLS) {
    // 退化路径：规模过大时把两侧当作整块替换。结果是**诚实的**（确实变了），
    // 只是不细。界面会显示一行提示，不会假装这是一份精确 diff。
    if (a.length) rows.push({ type: 'del', text: a.join(''), aLine: 1 })
    if (b.length) rows.push({ type: 'add', text: b.join(''), bLine: 1 })
  } else {
    rows = lcsRows(a, b)
  }

  const stats = {
    added: 0,
    removed: 0,
    unchanged: 0,
    beforeChars: String(before ?? '').length,
    afterChars: String(after ?? '').length,
    beforeWords: countWords(before).total,
    afterWords: countWords(after).total,
    truncated: a.length * b.length > MAX_CELLS
  }
  for (const r of rows) {
    if (r.type === 'add') stats.added++
    else if (r.type === 'del') stats.removed++
    else stats.unchanged++
  }
  return { lines: rows, stats }
}

function lcsRows(a, b) {
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度。用 Uint32Array 平铺，比二维数组省内存。
  const dp = new Uint32Array((n + 1) * (m + 1))
  const at = (i, j) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }

  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'equal', text: a[i], aLine: i + 1, bLine: j + 1 })
      i++
      j++
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      rows.push({ type: 'del', text: a[i], aLine: i + 1 })
      i++
    } else {
      rows.push({ type: 'add', text: b[j], bLine: j + 1 })
      j++
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: a[i], aLine: i + 1 })
    i++
  }
  while (j < m) {
    rows.push({ type: 'add', text: b[j], bLine: j + 1 })
    j++
  }
  return rows
}

/** 只保留有变化的行与前后各 context 行，给界面省 DOM。纯函数。 */
export function collapsedDiff(lines, context = 3) {
  const changed = new Set()
  ;(lines || []).forEach((r, i) => {
    if (r.type !== 'equal') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
        changed.add(k)
      }
    }
  })
  const out = []
  let skipped = 0
  ;(lines || []).forEach((r, i) => {
    if (changed.has(i)) {
      if (skipped) {
        out.push({ type: 'skip', count: skipped })
        skipped = 0
      }
      out.push(r)
    } else {
      skipped++
    }
  })
  if (skipped) out.push({ type: 'skip', count: skipped })
  return out
}
