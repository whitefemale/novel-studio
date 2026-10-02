import { createCollectionSet } from './collectionSet'

/**
 * 小说记忆层：人物 / 地点 / 势力 / 世界规则 / 时间线事件 / 伏笔 / 记忆审阅队列。
 *
 * 这一层是「写第 300 章时 AI 还能记得第 3 章埋了什么」的载体。它替代的不是
 * 旧「设定」侧栏（那是给用户手写的自由文本），而是把记忆变成**有字段、可比较、
 * 可被 AI 增量更新**的结构化数据。
 *
 * 记忆审阅队列（reviewQueue）刻意放在同一层：它装的是「AI 提出、但还没被批准
 * 的变更」，与人物/世界观是同一件事的两个阶段（候选态与已生效态），
 * 分开存放反而要求两处都懂对方的字段。
 */
export const MEMORY_COLLECTIONS = [
  'characters',
  'locations',
  'factions',
  'worldRules',
  'events',
  'foreshadowing',
  'reviewQueue'
]

const set = createCollectionSet(MEMORY_COLLECTIONS)

export const memoryStore = set.store

export function useNovelMemory() {
  return {
    store: memoryStore,
    /** 载入当前书的全部记忆集合。控制台打开时调用。 */
    loadForBook: set.loadForBook,
    clear: set.clear,
    /** upsert(name, data)：name 取 MEMORY_COLLECTIONS 之一 */
    upsert: set.upsert,
    remove: set.remove,
    replaceAll: set.replaceAll
  }
}
