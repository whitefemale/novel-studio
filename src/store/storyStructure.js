import { createCollectionSet } from './collectionSet'

/**
 * 剧情结构：卷（volume）、篇（arc）与场景（scene），外加文风档案。
 *
 * 与记忆层分开存放，是因为两者的生命周期不同：卷/篇/场景是作者一次规划、
 * 相对稳定的骨架（几十到几百条）；记忆是每章都可能变的活数据（几百上千条）。
 * 混在一个 store 里会让「载入记忆」顺带把骨架也刷一遍，而控制台的剧情标签
 * 并不需要它们。
 *
 * 文风档案放在这里而不是记忆层：它是作者手写的稳定表达层，不会被每章的
 * 记忆提取改动；而且写正文时由同一次 loadForBook 一起载入，Context Builder
 * 不必额外等一次 I/O。`order` 字段只有前三个集合有，集合工厂对缺失字段
 * 的排序是稳定的（按原顺序），文风档案因此不会被意外打乱。
 */
export const STRUCTURE_COLLECTIONS = ['volumes', 'arcs', 'scenes', 'styleProfiles']

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
