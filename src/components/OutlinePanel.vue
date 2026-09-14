<script setup>
import { ref, computed } from 'vue'
import { useBooks } from '../store/books'
import { toast } from '../store/toast'

const props = defineProps({
  // 传入既有设定则为编辑模式；null 为新建
  outline: { type: Object, default: null }
})
const emit = defineEmits(['close', 'saved'])

const { addOutline, updateOutline } = useBooks()

const typeMap = {
  outline: '故事大纲',
  character: '人物设定',
  world: '世界观'
}
const typeOptions = [
  { value: 'outline', label: '故事大纲' },
  { value: 'character', label: '人物设定' },
  { value: 'world', label: '世界观' }
]

const isEdit = computed(() => !!props.outline)
const form = ref({
  type: props.outline?.type || 'outline',
  title: props.outline?.title || '',
  content: props.outline?.content || ''
})

async function save() {
  if (!form.value.title.trim()) {
    toast('请填写标题', 'error')
    return
  }
  if (isEdit.value) {
    await updateOutline(props.outline.id, {
      title: form.value.title.trim(),
      content: form.value.content
    })
    toast('已保存', 'success')
  } else {
    await addOutline({
      type: form.value.type,
      title: form.value.title.trim(),
      content: form.value.content
    })
    toast('已添加设定', 'success')
  }
  emit('saved')
  emit('close')
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>{{ isEdit ? '编辑设定' : '添加设定' }}</h3>
        <button class="btn ghost sm" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <label class="label">类型</label>
        <select v-model="form.type" class="select" :disabled="isEdit">
          <option v-for="o in typeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <div style="height: 14px"></div>
        <label class="label">标题</label>
        <input v-model="form.title" class="input" placeholder="例如：主角 · 林晚 / 境界体系" />
        <div style="height: 14px"></div>
        <label class="label">内容</label>
        <textarea
          v-model="form.content"
          class="textarea"
          rows="8"
          placeholder="记录这条设定的详细信息，写作时 AI 会把它作为上下文参考……"
        ></textarea>
        <p class="hint">提示：内容会注入 AI 提示词，建议简洁、要点化。</p>
      </div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>
