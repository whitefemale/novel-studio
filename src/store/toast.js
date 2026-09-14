import { reactive } from 'vue'

export const toasts = reactive({ items: [] })
let seq = 0

/** 轻提示：toast(msg, 'success' | 'error' | 'info') */
export function toast(msg, type = 'info') {
  const id = ++seq
  toasts.items.push({ id, msg, type })
  setTimeout(() => {
    const i = toasts.items.findIndex((t) => t.id === id)
    if (i >= 0) toasts.items.splice(i, 1)
  }, 2600)
}
