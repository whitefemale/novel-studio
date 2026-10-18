import test from 'node:test'
import assert from 'node:assert/strict'
import {
  splitLines,
  splitSentences,
  diffLinesOf,
  diffText,
  collapsedDiff
} from '../../src/services/novel/diff.js'

/**
 * 版本差异与审校修复预览共用这一份实现。
 * 这里钉住的是「界面会对用户说什么」：增删行数、字数变化、以及折叠后
 * 仍然保留了变化的上下文。
 */

test('splitLines 统一换行；空文本返回空数组而不是一个空行', () => {
  assert.deepEqual(splitLines('a\r\nb\rc\n'), ['a', 'b', 'c', ''])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines(null), [])
})

test('超长行按句切分，标点留在句尾', () => {
  const line = `${'甲'.repeat(60)}。${'乙'.repeat(60)}！${'丙'.repeat(20)}`
  const parts = splitSentences(line)
  assert.equal(parts.length, 3)
  assert.ok(parts[0].endsWith('。'))
  assert.ok(parts[1].endsWith('！'))
  assert.deepEqual(diffLinesOf('短句。'), ['短句。'])
})

test('行级 diff 给出等 / 增 / 删与统计', () => {
  const d = diffText('第一行\n第二行\n第三行', '第一行\n改成别的\n第三行')
  assert.equal(d.stats.added, 1)
  assert.equal(d.stats.removed, 1)
  assert.equal(d.stats.unchanged, 2)
  assert.equal(d.stats.beforeChars, '第一行\n第二行\n第三行'.length)
  assert.ok(d.stats.beforeWords > 0)
  const types = d.lines.map((r) => r.type)
  assert.deepEqual(types.sort(), ['add', 'del', 'equal', 'equal'])
  const del = d.lines.find((r) => r.type === 'del')
  const add = d.lines.find((r) => r.type === 'add')
  assert.equal(del.text, '第二行')
  assert.equal(del.aLine, 2)
  assert.equal(add.text, '改成别的')
  assert.equal(add.bLine, 2)
})

test('空 vs 有内容：全部是新增；两边都空：没有行', () => {
  const a = diffText('', '新的一行')
  assert.equal(a.stats.added, 1)
  assert.equal(a.stats.removed, 0)
  const b = diffText('', '')
  assert.equal(b.lines.length, 0)
  assert.equal(b.stats.added, 0)
  assert.equal(b.stats.removed, 0)
})

test('同一文本 diff 全是 equal', () => {
  const d = diffText('甲\n乙\n丙', '甲\n乙\n丙')
  assert.equal(d.stats.unchanged, 3)
  assert.equal(d.stats.added, 0)
  assert.equal(d.stats.removed, 0)
})

test('collapsedDiff 只留变化附近的行，并用 skip 记录省略数', () => {
  const before = Array.from({ length: 20 }, (_, i) => `行${i + 1}`).join('\n')
  const afterLines = before.split('\n')
  afterLines[9] = '改过的第十行'
  const d = diffText(before, afterLines.join('\n'))
  const rows = collapsedDiff(d.lines, 3)
  assert.ok(rows.some((r) => r.type === 'skip'))
  assert.ok(rows.some((r) => r.type === 'del' && r.text === '行10'))
  assert.ok(rows.some((r) => r.type === 'add' && r.text === '改过的第十行'))
  // 省略数之和 + 实际行数 = 原始行数
  const skipped = rows.filter((r) => r.type === 'skip').reduce((n, r) => n + r.count, 0)
  assert.equal(skipped + rows.filter((r) => r.type !== 'skip').length, d.lines.length)
})

test('没有变化时 collapsedDiff 整段折叠成一个 skip', () => {
  const d = diffText('甲\n乙\n丙', '甲\n乙\n丙')
  const rows = collapsedDiff(d.lines, 3)
  // 全部行都在「变化」附近之外（没有变化），因此全被省略
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'skip')
  assert.equal(rows[0].count, 3)
})
