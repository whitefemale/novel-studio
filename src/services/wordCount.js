/**
 * 字数统计。
 *
 * 口径与编辑器顶栏显示的完全一致：先去掉全部空白，再分出 CJK 字符与其它字符。
 * 抽成纯函数是为了让 chapters.wordCount（落库的字段）与编辑器上那个数字
 * 永远是同一个算法的结果 —— 两处各写一份，用户早晚会看到两个不一样的字数。
 */
export function countWords(text) {
  const s = String(text || '').replace(/\s/g, '')
  const cjk = (s.match(/[一-龥]/g) || []).length
  return { cjk, other: s.length - cjk, total: s.length }
}
