import { useNovelMemory, MEMORY_COLLECTIONS } from './novelMemory'
import { useStoryStructure, STRUCTURE_COLLECTIONS } from './storyStructure'

/**
 * 按集合名取它归属的那套 store 操作。
 *
 * 控制台里有八个实体要共用同一套列表/新建/编辑/删除，而它们分属两族
 * （记忆层与剧情结构）。若让每个组件自己判断「这个集合归谁」，那个判断
 * 就会在表格、审阅队列、Context Preview 里各写一遍，然后慢慢分叉 ——
 * 分叉的表现是「在控制台里建的卷刷新后不见了」这类难查的问题。
 *
 * 集合名不存在时返回空值而不是抛错：调用方一律是 UI，缺一个集合应该表现为
 * 「这一栏是空的」，而不是整个弹窗挂掉。
 */
export function useCollections() {
  const memory = useNovelMemory()
  const structure = useStoryStructure()

  const setOf = (name) =>
    MEMORY_COLLECTIONS.includes(name)
      ? memory
      : STRUCTURE_COLLECTIONS.includes(name)
        ? structure
        : null

  return {
    memory,
    structure,
    /** 全部集合名，顺序即控制台标签的顺序：先骨架后细节 */
    all: [...STRUCTURE_COLLECTIONS, ...MEMORY_COLLECTIONS],
    list: (name) => setOf(name)?.store[name] || [],
    upsert: (name, data) => setOf(name)?.upsert(name, data) ?? null,
    remove: (name, id) => setOf(name)?.remove(name, id) ?? [],
    /**
     * 载入这本书的全部集合。
     * 控制台打开时必须走这里 —— 它同时覆盖两族，漏一族就会在界面上
     * 表现为「卷是空的」而用户明明建过。
     */
    loadForBook: (bookId) => Promise.all([memory.loadForBook(bookId), structure.loadForBook(bookId)])
  }
}
