import { computed, ref, watch } from 'vue'

/**
 * 长列表分页（「加载更多」），不引入虚拟列表依赖。
 *
 * 为什么是分页而不是虚拟滚动：虚拟滚动要接管滚动容器、测量行高、处理动态
 * 内容与键盘焦点，代价远大于收益；而这些列表（章节、实体、版本、生成历史）
 * 的瓶颈是**首次渲染几万个 DOM 节点**，分到 100 条一批就基本消失了。
 *
 * 用法：
 *   const paged = usePagedList(() => store.chapters, { watchKey: () => store.bookId })
 *   v-for="c in paged.visible"
 *   <button v-if="paged.hasMore" @click="paged.loadMore">加载更多（还有 N 条）</button>
 *
 * 语义保证：
 *   - 源数组变化（新增/删除/排序）时 `visible` 立即反映，不需要手动 reset；
 *   - 切换 watchKey（换书、换分组）时回到第一页 —— 否则用户会在新书里
 *     看到「已加载 300 条」的空状态；
 *   - `ensureVisible(pred)` 用来在搜索/跳转后把目标那条拉进已加载范围。
 */
export const DEFAULT_PAGE_SIZE = 100

export function usePagedList(source, { pageSize = DEFAULT_PAGE_SIZE, watchKey = null } = {}) {
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE)
  const list = computed(() => {
    const v = typeof source === 'function' ? source() : source?.value ?? source
    return Array.isArray(v) ? v : []
  })
  const limit = ref(size)
  const visible = computed(() => list.value.slice(0, limit.value))
  const total = computed(() => list.value.length)
  const hasMore = computed(() => limit.value < list.value.length)

  function loadMore() {
    limit.value += size
  }

  function reset() {
    limit.value = size
  }

  /** 把满足条件的条目录入已加载范围（找不到或已可见时不动） */
  function ensureVisible(predicate) {
    const idx = list.value.findIndex(predicate)
    if (idx < 0 || idx < limit.value) return
    limit.value = Math.ceil((idx + 1) / size) * size
  }

  if (watchKey) {
    watch(
      watchKey,
      () => {
        reset()
      },
      { flush: 'sync' }
    )
  }

  return { visible, hasMore, total, loadMore, reset, ensureVisible }
}
