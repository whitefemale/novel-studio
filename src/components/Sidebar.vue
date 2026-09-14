<script setup>
import { ref, computed } from 'vue'
import { useBooks } from '../store/books'
import { toast } from '../store/toast'
import OutlinePanel from './OutlinePanel.vue'

const {
  store,
  currentChapter,
  selectChapter,
  addChapter,
  renameChapter,
  removeChapter,
  moveChapter,
  removeOutline
} = useBooks()

const tab = ref('chapters') // 'chapters' | 'settings'
const renamingId = ref(null)
const renamingTitle = ref('')
const outlineModal = ref(false)
const editingOutline = ref(null)
const confirmDelete = ref(null) // {type:'chapter'|'outline', id}

// 章节列表已按 order 排序
const chapterList = computed(() => store.chapters)

const outlineGroups = computed(() => ({
  outline: store.outlines.filter((o) => o.type === 'outline'),
  character: store.outlines.filter((o) => o.type === 'character'),
  world: store.outlines.filter((o) => o.type === 'world')
}))

function openNewChapter() {
  addChapter()
  toast('已新建章节', 'success')
}

function startRename(c) {
  renamingId.value = c.id
  renamingTitle.value = c.title
}
function confirmRename() {
  if (renamingId.value) {
    renameChapter(renamingId.value, renamingTitle.value.trim() || '未命名章节')
  }
  renamingId.value = null
}
function onRenameKey(e) {
  if (e.key === 'Enter') confirmRename()
  if (e.key === 'Escape') renamingId.value = null
}

function openNewOutline() {
  editingOutline.value = null
  outlineModal.value = true
}
function openEditOutline(o) {
  editingOutline.value = o
  outlineModal.value = true
}

async function doConfirmDelete() {
  const d = confirmDelete.value
  if (!d) return
  if (d.type === 'chapter') {
    await removeChapter(d.id)
    toast('已删除章节', 'success')
  } else {
    await removeOutline(d.id)
    toast('已删除设定', 'success')
  }
  confirmDelete.value = null
}
</script>

<template>
  <aside class="sidebar">
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: tab === 'chapters' }"
        @click="tab = 'chapters'"
      >
        章节
      </button>
      <button
        class="tab"
        :class="{ active: tab === 'settings' }"
        @click="tab = 'settings'"
      >
        设定
      </button>
    </div>

    <!-- 章节 -->
    <div v-if="tab === 'chapters'" class="tab-body">
      <div class="list-head">
        <span class="muted small">共 {{ chapterList.length }} 章</span>
        <button class="btn sm primary" @click="openNewChapter">＋ 新章节</button>
      </div>

      <div class="chapter-list">
        <div
          v-for="c in chapterList"
          :key="c.id"
          class="chapter-item"
          :class="{ active: c.id === store.chapterId }"
          @click="selectChapter(c.id)"
        >
          <template v-if="renamingId === c.id">
            <input
              v-model="renamingTitle"
              class="rename-input"
              @click.stop
              @keydown="onRenameKey"
              @blur="confirmRename"
              autofocus
            />
          </template>
          <template v-else>
            <span class="num">{{ c.order }}</span>
            <span class="name" :title="c.title">{{ c.title || '未命名' }}</span>
            <span class="ops">
              <button class="op" title="上移" aria-label="上移章节" @click.stop="moveChapter(c.id, -1)">↑</button>
              <button class="op" title="下移" aria-label="下移章节" @click.stop="moveChapter(c.id, 1)">↓</button>
              <button class="op" title="重命名" aria-label="重命名章节" @click.stop="startRename(c)">✎</button>
              <button
                class="op danger"
                title="删除"
                aria-label="删除章节"
                @click.stop="confirmDelete = { type: 'chapter', id: c.id }"
              >
                ✕
              </button>
            </span>
          </template>
        </div>
        <div v-if="!chapterList.length" class="empty" style="padding: 40px 10px">
          <div class="icon">📝</div>
          <p>还没有章节，先新建一个吧</p>
        </div>
      </div>
    </div>

    <!-- 设定 -->
    <div v-else class="tab-body">
      <div class="list-head">
        <span class="muted small">大纲 · 人物 · 世界观</span>
        <button class="btn sm primary" @click="openNewOutline">＋ 添加</button>
      </div>

      <div v-for="(group, key) in outlineGroups" :key="key" class="group">
        <div class="group-title">
          {{ key === 'outline' ? '故事大纲' : key === 'character' ? '人物设定' : '世界观' }}
        </div>
        <div
          v-for="o in group"
          :key="o.id"
          class="outline-item"
          @click="openEditOutline(o)"
        >
          <span class="name" :title="o.title">{{ o.title || '未命名' }}</span>
          <button
            class="op danger"
            title="删除"
            aria-label="删除设定"
            @click.stop="confirmDelete = { type: 'outline', id: o.id }"
          >
            ✕
          </button>
        </div>
        <div v-if="!group.length" class="muted small" style="padding: 4px 10px">
          暂无
        </div>
      </div>
    </div>

    <!-- 设定编辑弹窗 -->
    <!-- OutlinePanel 保存后自己会 emit('close')，这里不需要再挂一个空的 @saved 处理器 -->
    <OutlinePanel
      v-if="outlineModal"
      :outline="editingOutline"
      @close="outlineModal = false"
    />

    <!-- 删除确认 -->
    <div v-if="confirmDelete" class="modal-mask" @click.self="confirmDelete = null">
      <div class="modal" style="max-width: 360px">
        <div class="modal-header"><h3>确认删除</h3></div>
        <div class="modal-body">
          <p style="margin: 0">
            删除后不可恢复，确定删除这条{{ confirmDelete.type === 'chapter' ? '章节' : '设定' }}吗？
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="confirmDelete = null">取消</button>
          <button class="btn danger" @click="doConfirmDelete">确认删除</button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 248px;
  flex-shrink: 0;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tabs {
  display: flex;
  padding: 10px 12px 0;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}
.tab {
  flex: 1;
  padding: 8px 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease;
}
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.tab-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.chapter-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chapter-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s ease;
  min-height: 34px;
}
.chapter-item:hover {
  background: var(--bg-hover);
}
.chapter-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.chapter-item .num {
  font-size: 12px;
  color: var(--text-3);
  min-width: 18px;
  text-align: right;
  flex-shrink: 0;
}
.chapter-item.active .num {
  color: var(--accent);
}
.chapter-item .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.chapter-item .ops {
  display: none;
  gap: 2px;
  flex-shrink: 0;
}
.chapter-item:hover .ops {
  display: flex;
}
.op {
  font-size: 12px;
  color: var(--text-3);
  padding: 2px 4px;
  border-radius: 4px;
}
.op:hover {
  background: var(--bg-muted);
  color: var(--text);
}
.op.danger:hover {
  color: var(--danger);
  background: var(--danger-soft);
}

/*
 * 触屏设备没有 hover：`.ops` 永远不显示，等于章节的上移/下移/重命名/删除
 * 在手机和平板上完全无法触发。这里改为常显，并把点击目标放大到 ~40px。
 */
@media (hover: none) {
  .chapter-item .ops {
    display: flex;
  }
  .op {
    min-width: 40px;
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
  }
  .chapter-item {
    min-height: 48px;
  }
  .outline-item {
    min-height: 48px;
  }
  .outline-item .op {
    min-width: 40px;
    min-height: 40px;
  }
}
.rename-input {
  width: 100%;
  padding: 3px 8px;
  font-size: 13px;
  border: 1px solid var(--accent);
  border-radius: 6px;
}
.group {
  margin-bottom: 16px;
}
.group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  padding: 6px 10px 4px;
}
.outline-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.outline-item:hover {
  background: var(--bg-hover);
}
.outline-item .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
</style>
