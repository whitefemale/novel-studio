import { createCollectionSet } from './collectionSet'

/**
 * 剧情结构：卷（volume）与篇（arc）。
 *
 * 与记忆层分开存放，是因为两者的生命周期不同：卷/篇是作者一次规划、长期不变的
 * 骨架（几十条）；记忆是每章都可能变的活数据（几百上千条）。混在一个 store 里
 * 会让「载入记忆」顺带把骨架也刷一遍，而控制台的剧情标签并不需要它们。
 *
 * 两个集合都有 order 字段，storage 的集合工厂按 order 排序后返回。
 */
export const STRUCTURE_COLLECTIONS = ['volumes', 'arcs']

const set = createCollectionSet(STRUCTURE_COLLECTIONS)

export const structureStore = set.store

export function useStoryStructure() {
  return {
    store: structureStore,
    loadForBook: set.loadForBook,
    clear: set.clear,
    upsert: set.upsert,
    remove: set.remove,
    replaceAll: set.replaceAll
  }
}
