/**
 * 「上次读到哪里」的书籍指针（纯函数）。
 *
 * 一本书的当前章节、当前篇、当前卷分别存成三个可选字段，外加一个**独立于
 * `book.updatedAt` 的** `currentPointerUpdatedAt`：
 *
 * - 指针写得比书本身勤得多（每次切章一次），跟着 `updatedAt` 合并会让
 *   「A 设备切章、B 设备改书名」互相覆盖；
 * - 独立时间戳让两件事各算各的，见 snapshot.js 的 mergeBookRecords。
 *
 * 全部字段可选，旧书没有它们时 `openBook` 落回第一章，行为与旧版一致。
 */

export const BOOK_POINTER_FIELDS = ['currentVolumeId', 'currentArcId', 'currentChapterId']
export const BOOK_POINTER_STAMP = 'currentPointerUpdatedAt'

/** 按 id 找回上次读的章节；不存在（被删/同步丢了）时为 null。 */
export function resolvePointerChapter(chapters = [], id) {
  if (!id) return null
  return (chapters || []).find((c) => c && c.id === id) || null
}

/**
 * 由章节推导三个指针。
 *
 * `previous` 只在**打开书**时传入：当前章没有 arcId（旧数据或还没归篇）时，
 * 回退到书里记住的篇/卷，不要因为一次打开就把它们清空。用户主动切到一章
 * 没有归篇的章节时则传 null——那时旧篇指针已经过期，留着只会误导上下文。
 */
export function derivePointers(chapter, { arcs = [], previous = null } = {}) {
  const chapterId = chapter?.id || null
  const arcId = chapter?.arcId || null
  if (arcId) {
    const arc = (arcs || []).find((a) => a && a.id === arcId) || null
    return {
      currentChapterId: chapterId,
      currentArcId: arcId,
      currentVolumeId: arc?.volumeId || null
    }
  }
  if (previous && previous.currentArcId) {
    const arc = (arcs || []).find((a) => a && a.id === previous.currentArcId) || null
    return {
      currentChapterId: chapterId,
      // 篇已不存在时仍保留 id：它能作为「曾经在哪一篇」的线索，且不影响请求。
      currentArcId: previous.currentArcId,
      currentVolumeId: arc?.volumeId || previous.currentVolumeId || null
    }
  }
  return { currentChapterId: chapterId, currentArcId: null, currentVolumeId: null }
}

/**
 * 删除一章之后应该选中哪一章。
 *
 * 顺序是「原位置（也就是原来的下一章）→ 前一章 → 第一章 → null」。
 * 传的是**删除前**的列表：删除后按下标取值会在删最后一章时越界，
 * 而「删掉正在写的最后一章后光标莫名跳到第一章」是很刺眼的行为。
 */
export function pickChapterAfterDelete(chaptersBefore = [], deletedId) {
  const list = (chaptersBefore || []).filter((c) => c && c.id)
  if (!list.length) return null
  const idx = list.findIndex((c) => c.id === deletedId)
  if (idx < 0) return list[0] || null
  const rest = list.filter((c) => c.id !== deletedId)
  if (!rest.length) return null
  return rest[Math.min(idx, rest.length - 1)] || rest[idx - 1] || rest[0] || null
}

/** 两个指针对象在三个字段上是否一致（用于避免「只是打开书」也写一次库）。 */
export function pointersEqual(a, b) {
  return BOOK_POINTER_FIELDS.every((f) => (a?.[f] ?? null) === (b?.[f] ?? null))
}

/** 组装写入用的 patch。时间戳由调用方给，便于单测与「打开书不刷新时间」。 */
export function pointerPatch(pointers, now) {
  const out = {}
  for (const f of BOOK_POINTER_FIELDS) out[f] = pointers?.[f] ?? null
  out[BOOK_POINTER_STAMP] = Number(now) || 0
  return out
}
