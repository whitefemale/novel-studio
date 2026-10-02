import { reactive } from 'vue'
import { coll } from '../services/storage'
import { genId } from '../services/ids'
import { store as books } from './books'

/**
 * 「一组按书隔离的集合」的通用 store 工厂。
 *
 * V2 的领域集合分成两族（记忆层与剧情结构），两族的 CRUD 逻辑一模一样 ——
 * 差别只在集合清单与字段语义上。各写一份的话，时间戳补全、bookId 解析、
 * 墓碑删除这些容易漏的地方就会出现两份，然后慢慢分叉。
 *
 * 与 books.js 一样是**模块级 reactive 单例**：跨组件共享一律走这里，
 * 不另起本地副本（否则控制台与编辑器会各自持有一份不同步的人物列表）。
 */
export function createCollectionSet(names) {
  const store = reactive({ loaded: false })
  for (const n of names) store[n] = []

  /** 当前打开的书；写操作默认作用于它（与 useBooks 的用法一致，避免层层传参） */
  const currentBookId = () => books.bookId

  async function loadForBook(bookId) {
    if (!bookId) {
      clear()
      return
    }
    const lists = await Promise.all(names.map((n) => coll[n].getAll(bookId)))
    names.forEach((n, i) => {
      store[n] = lists[i]
    })
    store.loaded = true
  }

  function clear() {
    for (const n of names) store[n] = []
    store.loaded = false
  }

  /**
   * 新建或更新一条记录，并补齐时间戳。
   *
   * createdAt 沿用它原有的值（更新时不能被刷新，否则「什么时候建的」就丢了），
   * updatedAt 每次都刷新 —— 第二阶段同步按 updatedAt 做后写覆盖，
   * 少一个时间戳等于少一条参与比较的记录。
   */
  async function upsert(name, data) {
    if (!names.includes(name)) return null
    const bookId = data?.bookId || currentBookId()
    if (!bookId) return null
    const now = Date.now()
    const existing = store[name].find((r) => r.id === data.id)
    const item = {
      ...data,
      id: data.id || genId(),
      bookId,
      createdAt: existing?.createdAt ?? data.createdAt ?? now,
      updatedAt: now
    }
    store[name] = await coll[name].upsert(bookId, item)
    return item
  }

  async function remove(name, id) {
    if (!names.includes(name)) return []
    const bookId = currentBookId()
    if (!bookId) return []
    store[name] = await coll[name].remove(bookId, id)
    return store[name]
  }

  /** 整组替换。快照恢复与迁移落库用。 */
  async function replaceAll(name, items) {
    if (!names.includes(name)) return []
    const bookId = currentBookId()
    if (!bookId) return []
    store[name] = await coll[name].saveAll(bookId, items)
    return store[name]
  }

  return { names, store, loadForBook, clear, upsert, remove, replaceAll }
}
