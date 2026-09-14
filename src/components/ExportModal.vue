<script setup>
import { ref, computed } from 'vue'
import { useBooks } from '../store/books'
import { useSettings } from '../store/settings'
import {
  buildTxt,
  buildMarkdown,
  buildChapterText,
  buildChapterMarkdown,
  buildExportTarget,
  sanitizeFileName,
  saveToDisk
} from '../services/export'
import { isDesktop, isNative } from '../services/platform'
import { toast } from '../store/toast'

const emit = defineEmits(['close'])
const { store, currentChapter } = useBooks()
const { settings } = useSettings()

const format = ref('txt') // 'txt' | 'md'
const scope = ref('whole') // 'whole' | 'chapter'
const busy = ref(false)
// 局部状态：某一次导出的选择不应该写回全局设置
const reveal = ref(false)

const canExport = computed(() => {
  if (scope.value === 'chapter') return !!currentChapter.value
  return store.chapters.length > 0
})

const target = computed(() => buildExportTarget(settings, store.book))
const directMode = computed(
  () => isDesktop() && settings.exportMode === 'direct' && !!target.value
)

const hintText = computed(() => {
  if (isNative()) return '将写入应用缓存并拉起系统分享面板，由你选择保存位置或直接分享。'
  if (isDesktop()) {
    if (settings.exportMode === 'ask') return '每次导出都会弹出保存对话框。'
    if (target.value) {
      const where = settings.perBookFolder
        ? `${target.value.dir}\\${target.value.subDir}`
        : target.value.dir
      return `将直接保存到「${where}」，同名文件自动加序号，不会覆盖原文件。`
    }
    return '尚未设置保存地址，将弹出保存对话框。可在「设置 → 保存与导出」中配置。'
  }
  return '浏览器版直接下载文件。'
})

async function doExport(forceDialog = false) {
  if (!canExport.value) {
    toast('没有可导出的内容', 'error')
    return
  }
  const book = store.book
  const ext = format.value === 'md' ? 'md' : 'txt'
  const bookName = sanitizeFileName(book.title || '小说')
  let content = ''
  let fileName = ''

  if (scope.value === 'whole') {
    content =
      format.value === 'md' ? buildMarkdown(book, store.chapters) : buildTxt(book, store.chapters)
    fileName = `${bookName}.${ext}`
  } else {
    const c = currentChapter.value
    content = format.value === 'md' ? buildChapterMarkdown(c) : buildChapterText(c)
    fileName = `${bookName}-第${c.order}章-${sanitizeFileName(c.title || '未命名')}.${ext}`
  }

  const useDirect = directMode.value && !forceDialog

  busy.value = true
  try {
    let res = await saveToDisk({
      fileName,
      content,
      ext,
      target: useDirect ? target.value : null,
      reveal: reveal.value || settings.openFolderAfterExport
    })

    // 保存地址不可用（被删除、拔了盘、没权限）时提示一次并降级到保存框。
    // 降级由这里发起而不是 saveToDisk 内部，避免一次点击连弹两个对话框。
    if (res && res.ok === false && useDirect) {
      toast(`保存地址不可用（${res.message || res.code}），改为另存为`, 'error')
      res = await saveToDisk({ fileName, content, ext, target: null, reveal: false })
    }

    if (res?.canceled) return // 用户主动取消，不当作失败
    if (res?.ok === false) {
      toast(`导出失败：${res.message || res.code}`, 'error')
      return
    }
    toast('导出成功', 'success')
    emit('close')
  } catch (err) {
    toast(`导出失败：${(err && err.message) || err}`, 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal" style="max-width: 420px">
      <div class="modal-header">
        <h3>导出</h3>
        <button class="btn ghost sm" aria-label="关闭" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <label class="label">格式</label>
        <div class="seg">
          <button class="seg-btn" :class="{ active: format === 'txt' }" @click="format = 'txt'">
            纯文本 TXT
          </button>
          <button class="seg-btn" :class="{ active: format === 'md' }" @click="format = 'md'">
            Markdown
          </button>
        </div>

        <div style="height: 14px"></div>
        <label class="label">范围</label>
        <div class="seg">
          <button class="seg-btn" :class="{ active: scope === 'whole' }" @click="scope = 'whole'">
            整本（{{ store.chapters.length }} 章）
          </button>
          <button
            class="seg-btn"
            :class="{ active: scope === 'chapter' }"
            :disabled="!currentChapter"
            @click="scope = 'chapter'"
          >
            当前章节
          </button>
        </div>

        <template v-if="isDesktop()">
          <div style="height: 14px"></div>
          <label class="check">
            <input v-model="reveal" type="checkbox" />
            导出后打开所在文件夹
          </label>
        </template>

        <p class="hint">{{ hintText }}</p>
      </div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">取消</button>
        <button
          v-if="directMode"
          class="btn"
          :disabled="!canExport || busy"
          @click="doExport(true)"
        >
          另存为…
        </button>
        <button class="btn primary" :disabled="!canExport || busy" @click="doExport(false)">
          {{ busy ? '导出中…' : '导出' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  gap: 8px;
}
.seg-btn {
  flex: 1;
  padding: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-2);
  transition: all 0.15s ease;
}
.seg-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.seg-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.seg-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.check input {
  accent-color: var(--accent);
  width: 15px;
  height: 15px;
}

@media (pointer: coarse) {
  .seg-btn {
    padding: 11px 0;
  }
  .check input {
    width: 20px;
    height: 20px;
  }
}
</style>
