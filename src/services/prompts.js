// AI 提示词组装：根据写作动作与上下文生成 messages

function tail(text, max) {
  if (!text) return ''
  text = text.trim()
  return text.length <= max ? text : text.slice(-max)
}

/**
 * 汇总所有「故事大纲」型设定。
 *
 * 侧边栏允许建任意多条大纲，旧实现用 `.find()` 只取第一条，后面的全被忽略。
 * 只有一条时保持与历史完全一致的行为（整段 tail 到 8000），以免提示词回归；
 * 多条时按《标题》分段、每条截断到 4000 —— 人物/世界观本就无界拼接，
 * 十几条大纲若各带全文会直接撑爆上下文。
 */
function collectOutlineText(outlines) {
  const list = (outlines || []).filter((o) => o.type === 'outline' && o.content)
  if (!list.length) return ''
  if (list.length === 1) return tail(list[0].content, 8000)
  return list.map((o) => `《${o.title || '未命名'}》\n${tail(o.content, 4000)}`).join('\n\n')
}

/** 组装系统提示：作者身份 + 作品设定上下文 */
export function buildSystemPrompt(book, outlines, settings) {
  const parts = []
  parts.push(
    `你是一名资深中文网文小说作者，正在创作小说《${book?.title || '未命名'}》。请用流畅、自然、有画面感的中文写作，保持文笔连贯、逻辑自洽。`
  )
  parts.push('写作要求：直接输出正文内容本身，不要输出章节标题、"好的"等客套话，不要添加任何解释说明。')

  const outlineText = collectOutlineText(outlines)
  if (settings.includeOutline !== false && outlineText) {
    parts.push(`【故事大纲】\n${outlineText}`)
  }
  if (settings.includeCharacters !== false) {
    const chars = outlines.filter((o) => o.type === 'character').map((c) => `${c.title}：${c.content}`)
    if (chars.length) parts.push(`【人物设定】\n${chars.join('\n')}`)
  }
  if (settings.includeWorld !== false) {
    const world = outlines.filter((o) => o.type === 'world').map((w) => `${w.title}：${w.content}`)
    if (world.length) parts.push(`【世界观设定】\n${world.join('\n')}`)
  }
  return parts.join('\n\n')
}

/** 取当前章节之前若干章的末尾作为剧情上下文 */
function buildRecentContext(chapters, chapter, settings) {
  const n = Number(settings.contextChapters ?? 3) || 3
  const sorted = [...(chapters || [])].sort((a, b) => a.order - b.order)
  const idx = sorted.findIndex((c) => c.id === chapter?.id)
  const prev = idx > 0 ? sorted.slice(Math.max(0, idx - n), idx) : []
  if (!prev.length) return ''
  const ctx = prev
    .map((c) => `【${c.title || `第${c.order}章`}】\n${tail(c.content, 800)}`)
    .join('\n\n')
  return ctx
}

/** 根据动作组装完整 messages */
export function buildMessages(action, { book, chapter, chapters, outlines, settings, selection, instruction }) {
  const system = buildSystemPrompt(book, outlines, settings)
  const messages = [{ role: 'system', content: system }]
  const inst = instruction ? instruction.trim() : ''
  const req = '请直接输出正文内容，不要输出标题或任何解释。'

  let user = ''
  switch (action) {
    case 'continue': {
      const context = buildRecentContext(chapters, chapter, settings)
      const cur = tail(chapter?.content, 6000)
      user =
        `请续写当前章节正文，从文末处自然衔接，延续上文风格与剧情继续推进。${req}\n\n` +
        (context ? `【前情提要】\n${context}\n\n` : '') +
        (cur ? `【当前章节正文】\n${cur}\n` : '当前章节为空，请直接开篇。') +
        (inst ? `\n\n【创作要求】\n${inst}` : '')
      break
    }
    case 'expand': {
      const context = tail(chapter?.content, 2000)
      user =
        `请扩写下面这段文字，使其内容更丰富、细节更生动、更有画面感，同时保持原意、风格与视角一致。${req}\n\n` +
        `【待扩写的文字】\n${selection || '(未提供)'}\n` +
        (context ? `\n【所在章节上下文】\n${context}\n` : '') +
        (inst ? `\n\n【扩写要求】\n${inst}` : '')
      break
    }
    case 'rewrite': {
      user =
        `请改写下面这段文字，优化文笔、语言节奏与逻辑表达，使文字更精炼、更有感染力，保持原意不变。${req}\n\n` +
        `【待改写的文字】\n${selection || '(未提供)'}\n` +
        (inst ? `\n\n【改写要求】\n${inst}` : '')
      break
    }
    case 'outline': {
      user =
        `请为小说《${book?.title || '未命名'}》${book?.intro ? `（一句话简介：${book.intro}）` : ''}生成一份详细的分章故事大纲。\n\n` +
        `要求：1) 按"第N章 章节标题\n本章情节要点"的格式逐章列出；2) 大纲要完整覆盖一个清晰的故事起承转合；3) 章节数量根据内容篇幅控制在 12~30 章之间。\n` +
        (inst ? `\n【创作方向】\n${inst}\n` : '')
      break
    }
    case 'chapter': {
      const outlineText = collectOutlineText(outlines)
      const context = buildRecentContext(chapters, chapter, settings)
      user =
        `请根据故事大纲，创作其中一章的完整正文。${req}\n\n` +
        (outlineText ? `【故事大纲】\n${outlineText}\n` : '(未提供大纲，请自由创作一章)') +
        (context ? `\n【已写章节剧情】\n${context}\n` : '') +
        (inst ? `\n【本章要求】\n${inst}` : '')
      break
    }
    default:
      return messages
  }

  messages.push({ role: 'user', content: user })
  return messages
}
