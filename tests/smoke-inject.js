// Electron 冒烟测试：在渲染进程内驱动核心逻辑，返回测试结果对象。
// 通过 src/main.js 暴露的 window.__ns 访问模块。
//
// 两点必须注意：
//  1. 本脚本跑在**真实**的 novel-studio-db 上（不是沙箱库），所以
//     · 只清理标题为「测试小说」的书，绝不碰用户自己的作品；
//     · 断言一律围绕本次新建的书，不能假设整个库是空的（曾经假设过，
//       结果库里一有真书就永久失败）；
//     · 改动过的设置键必须复位，否则下次 npm run electron 会静默导出到临时目录。
//  2. 绝不调用会弹原生对话框的通道（dialog:chooseDirectory / export:saveFile），
//     它们会挂到超时。只断言函数存在 + 非法入参返回类型化错误。
//     也不测 openFolder(存在的目录)——会在开发机上真的弹出资源管理器。
(async () => {
  const out = {}
  // Vue 会把 watcher / 生命周期回调里抛出的错误吞掉并 console.error 出去，
  // **不会**中断渲染、也不会让组件树消失。所以「有没有隐藏的报错」只能这样观测：
  // 光断言元素存在是抓不到的——出错的组件照样渲染。
  const swallowedErrors = []
  const origConsoleError = console.error
  console.error = (...args) => {
    swallowedErrors.push(args.map((a) => (a && a.stack) || String(a)).join(' '))
    origConsoleError.apply(console, args)
  }
  try {
    const {
      useBooks,
      useSettings,
      defaultSettings,
      db,
      chatStream,
      createAutosaver,
      sanitizeFileName,
      buildChapterMarkdown,
      buildBackupName,
      buildExportTarget,
      buildBackupTarget,
      pickStaleBackups,
      buildMessages,
      buildTxt,
      buildMarkdown,
      parseSseLine,
      buildChatUrl
    } = window.__ns
    const b = useBooks()
    const s = useSettings()
    await s.load()
    await b.init()

    // 后加的七个设置键：整轮测试前后各复位一次。
    // 开头的复位才是真正的保护——即使上一次运行中途崩了也能自愈。
    const NEW_KEYS = [
      'saveDir',
      'exportMode',
      'perBookFolder',
      'openFolderAfterExport',
      'autoBackup',
      'backupInterval',
      'backupKeep'
    ]
    const resetSettings = async () => {
      for (const k of NEW_KEYS) s.settings[k] = defaultSettings[k]
      await s.persist()
    }
    await resetSettings()

    // 清理历史残留的测试数据，保证断言独立
    for (const old of b.store.books.filter((x) => x.title === '测试小说')) {
      await b.removeBook(old.id)
    }
    // 早期缺陷可能留下的脏键，会让后面的守卫断言永远失败
    await db.rawDelete('chapters:null')
    await db.rawDelete('outlines:null')

    // ------------------------------------------------------------------
    // A) 设置：默认值 / 旧记录回填 / 持久化
    // ------------------------------------------------------------------
    out.saveDirDefaults =
      defaultSettings.saveDir === '' &&
      defaultSettings.exportMode === 'direct' &&
      defaultSettings.perBookFolder === true &&
      defaultSettings.openFolderAfterExport === false &&
      defaultSettings.autoBackup === false &&
      defaultSettings.backupInterval === 10 &&
      defaultSettings.backupKeep === 20

    // 先把内存里的值弄脏，再落一条「旧版本格式」的记录（没有新增的七个键），
    // load() 必须把新键补成默认值、同时保留旧字段。
    // 若哪天有人把 load() 的 defaultSettings 合并去掉，这条会立刻失败——
    // 它是「不需要迁移代码」这个结论的直接证据。
    s.settings.saveDir = 'D:/should-be-wiped'
    s.settings.autoBackup = true
    await s.persist()
    await db.saveSettings({
      baseUrl: 'https://legacy.example',
      apiKey: 'legacy-key',
      model: 'legacy-model',
      temperature: 1,
      maxTokens: 100,
      includeOutline: true,
      includeCharacters: true,
      includeWorld: true,
      contextChapters: 1
    })
    await s.load()
    out.settingsBackfill =
      s.settings.saveDir === '' &&
      s.settings.exportMode === 'direct' &&
      s.settings.perBookFolder === true &&
      s.settings.autoBackup === false &&
      s.settings.backupKeep === 20 &&
      s.settings.apiKey === 'legacy-key' &&
      s.settings.baseUrl === 'https://legacy.example'

    s.settings.saveDir = 'D:/ns-smoke-persist'
    await s.persist()
    const recAfter = await db.getSettings()
    out.saveDirPersisted = !!recAfter && recAfter.saveDir === 'D:/ns-smoke-persist'
    s.settings.saveDir = ''
    s.settings.baseUrl = defaultSettings.baseUrl
    s.settings.apiKey = ''
    s.settings.model = defaultSettings.model
    await s.persist()

    // ------------------------------------------------------------------
    // B) 纯函数：文件名净化 / 单章 Markdown / 备份命名 / 淘汰挑选
    // ------------------------------------------------------------------
    // 控制字符一律用 String.fromCharCode 现造：把 \uXXXX 字面量写进源码，
    // 会被 JSON 解码成真正的控制字节（含 NUL），污染源文件。
    const ctrl = String.fromCharCode(1)

    out.chapterMarkdownOk =
      buildChapterMarkdown({ order: 3, title: '', content: '正文' }) === '# 第3章\n\n正文' &&
      buildChapterMarkdown({ order: 1, title: '雨夜', content: 'x' }) === '# 雨夜\n\nx' &&
      buildChapterMarkdown(null) === '# 第1章\n\n' &&
      // 旧的内联手拼版本会输出 "# undefined"
      !buildChapterMarkdown({ order: 1, title: '', content: 'x' }).includes('undefined')

    out.sanitizeOk =
      sanitizeFileName('..') === '小说' &&
      sanitizeFileName('...') === '小说' &&
      sanitizeFileName('') === '小说' &&
      sanitizeFileName(null) === '小说' &&
      sanitizeFileName('CON') === '_CON' &&
      sanitizeFileName('com1') === '_com1' &&
      sanitizeFileName('x.') === 'x' &&
      sanitizeFileName('  书名  ') === '书名' &&
      sanitizeFileName('a/b') === 'a_b' &&
      sanitizeFileName('a:b*c?') === 'a_b_c_' &&
      sanitizeFileName('a' + ctrl + 'b') === 'ab'

    out.backupNameOk =
      buildBackupName({ title: '剑与星辰' }, new Date(2026, 8, 11, 22, 30)) ===
        '剑与星辰-20260911-2230.txt' &&
      buildBackupName({}, new Date(2026, 0, 2, 3, 4)) === '小说-20260102-0304.txt'

    out.exportTargetOk =
      buildExportTarget({ saveDir: '', perBookFolder: true }, { title: 'a' }) === null &&
      buildExportTarget({ saveDir: 'D:/x', perBookFolder: false }, { title: 'a' }).subDir === '' &&
      buildExportTarget({ saveDir: 'D:/x', perBookFolder: true }, { title: '书名' }).subDir === '书名' &&
      buildBackupTarget({ saveDir: 'D:/x', perBookFolder: true }, { title: '书名' }).subDir ===
        '书名/备份' &&
      buildBackupTarget({ saveDir: '', perBookFolder: true }, { title: '书名' }) === null

    out.staleBackupsOk = (() => {
      const files = ['a-20260101-0000.txt', 'a-20260102-0000.txt', 'a-20260103-0000.txt']
      const stale = pickStaleBackups(files, 2)
      return (
        stale.length === 1 &&
        stale[0] === 'a-20260101-0000.txt' &&
        pickStaleBackups(files, 0).length === 0 &&
        pickStaleBackups(files, 99).length === 0 &&
        pickStaleBackups(null, 3).length === 0
      )
    })()

    // ------------------------------------------------------------------
    // C) D1 自动保存调度器（抽成纯逻辑就是为了能在这里确定性地驱动）
    // ------------------------------------------------------------------
    const debounced = []
    const saverDebounce = createAutosaver({
      persist: async (id) => {
        debounced.push(id)
      },
      delay: 60
    })
    saverDebounce.schedule('A')
    await new Promise((r) => setTimeout(r, 10))
    const notYet = debounced.length === 0
    await new Promise((r) => setTimeout(r, 150))
    out.autosaveDebounce = notYet && debounced.length === 1 && debounced[0] === 'A'

    // flush 必须落盘「排队时捕获的那个 id」。
    // 旧实现按触发时刻读 currentChapter，这条会落成别的章节 —— 直接回归测试。
    const flushed = []
    const saverFlush = createAutosaver({
      persist: async (id) => {
        flushed.push(id)
      },
      delay: 5000
    })
    saverFlush.schedule('A')
    await saverFlush.flush()
    out.autosaveFlushTarget = flushed.length === 1 && flushed[0] === 'A'

    // 飞行中的落盘不得吃掉新排队的 id：最终必须依次落盘 A、B
    const seq = []
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const saverFlight = createAutosaver({
      persist: async (id) => {
        seq.push(id)
        if (id === 'A') await gate
      },
      delay: 5000
    })
    saverFlight.schedule('A')
    const pA = saverFlight.flush() // 同步摘除 pendingId='A'，随后挂在 gate 上
    saverFlight.schedule('B') // 此时 A 还在飞行中
    release()
    await pA
    await saverFlight.flush()
    out.autosaveNoClobber = seq.join(',') === 'A,B'

    // ------------------------------------------------------------------
    // D) 书本 / 章节 / 设定
    // ------------------------------------------------------------------
    const book = await b.createBook({ title: '测试小说', intro: '一场自动化测试' })
    out.createdBook = !!book.id && b.store.bookId === book.id

    const c = await b.addChapter()
    b.setChapterContent(c.id, '第一章正文：主角在一场大雨中醒来。')
    await b.persistChapter(c.id)
    out.chapterCount = b.store.chapters.length
    out.contentSaved = b.store.chapters[0].content.includes('大雨')

    await b.addOutline({ type: 'character', title: '主角', content: '坚韧果敢' })
    await b.addOutline({ type: 'world', title: '修真界', content: '灵气复苏' })
    out.outlineCount = b.store.outlines.length

    // 续写消息组装
    const msgs = buildMessages('continue', {
      book: b.store.book,
      chapter: b.store.chapters[0],
      chapters: b.store.chapters,
      outlines: b.store.outlines,
      settings: s.settings,
      selection: '',
      instruction: '主角发现真相'
    })
    out.msgCount = msgs.length
    out.msgRolesOk = msgs[0].role === 'system' && msgs[1].role === 'user'
    // 世界观上下文在 system 消息中，创作要求在 user 消息中
    out.msgHasContext =
      msgs[0].content.includes('修真界') &&
      msgs[0].content.includes('人物设定') &&
      msgs[1].content.includes('主角发现真相')

    // D7：侧边栏允许建任意多条「故事大纲」，旧实现只注入第一条。
    // 位置有约束——必须在 out.msgHasContext 之后、out.persisted 之前，
    // 因为这两条大纲建完就要删掉，不能让它们影响后面的 2 条计数。
    const o1 = await b.addOutline({ type: 'outline', title: '主线大纲', content: '主角寻剑' })
    const o2 = await b.addOutline({ type: 'outline', title: '副线大纲', content: '师门恩怨' })
    const mChapter = buildMessages('chapter', {
      book: b.store.book,
      chapter: b.store.chapters[0],
      chapters: b.store.chapters,
      outlines: b.store.outlines,
      settings: s.settings,
      selection: '',
      instruction: ''
    })
    const sysChapter = mChapter[0].content
    const usrChapter = mChapter[1].content
    out.multiOutlineOk =
      sysChapter.includes('主角寻剑') &&
      sysChapter.includes('师门恩怨') &&
      usrChapter.includes('主角寻剑') &&
      usrChapter.includes('师门恩怨')
    await b.removeOutline(o1.id)
    await b.removeOutline(o2.id)

    // 导出文本
    const txt = buildTxt(b.store.book, b.store.chapters)
    const md = buildMarkdown(b.store.book, b.store.chapters)
    out.txtOk = txt.includes('第1章') && txt.includes('大雨')
    out.mdOk = md.includes('## ') && md.includes('大雨')

    // 持久化校验：重新读库。库里有用户自己的书，按 id 过滤后再计数
    const books = await db.getBooks()
    const chapters = await db.getChapters(book.id)
    const outlines = await db.getOutlines(book.id)
    out.persisted = `${books.filter((x) => x.id === book.id).length}/${chapters.length}/${outlines.length}`

    // 设置持久化
    s.settings.apiKey = 'sk-test-123'
    await s.persist()
    const loadedSettings = await db.getSettings()
    out.settingsSaved = loadedSettings && loadedSettings.apiKey === 'sk-test-123'

    // ------------------------------------------------------------------
    // E) 落盘通道：保存地址的核心写入路径走 export:writeToDir，可无头驱动
    // ------------------------------------------------------------------
    const DIR = window.__nsSmokeDir
    const api = window.electronAPI
    out.smokeDirInjected = typeof DIR === 'string' && DIR.length > 0
    out.saveDirChannels =
      !!api &&
      ['chooseDirectory', 'writeToDir', 'listFiles', 'deleteFiles', 'openFolder'].every(
        (k) => typeof api[k] === 'function'
      )

    const w1 = await api.writeToDir({
      dir: DIR,
      subDir: '书屋',
      fileName: 'a.txt',
      content: '你好世界'
    })
    out.writeToDir = !!w1 && w1.ok === true
    // bytes 证明载荷完整穿过了 IPC，而不只是「没报错」
    out.writeBytesOk = !!w1 && w1.bytes === new TextEncoder().encode('你好世界').length

    const w2 = await api.writeToDir({
      dir: DIR,
      subDir: '书屋',
      fileName: 'a.txt',
      content: '第二份'
    })
    out.collisionSafe =
      !!w2 &&
      w2.ok === true &&
      w2.filePath !== w1.filePath &&
      w2.filePath.includes('(1)') &&
      w1.filePath.endsWith('a.txt')

    const lst = await api.listFiles({ dir: DIR, subDir: '书屋' })
    out.subDirCreated = !!lst && lst.ok === true && lst.files.length === 2

    const rRel = await api.writeToDir({ dir: 'relative/path', fileName: 'a.txt', content: 'x' })
    out.rejectsRelativeDir = !!rRel && rRel.ok === false && rRel.code === 'EINVALID_DIR'

    const rTrav = await api.writeToDir({
      dir: DIR,
      subDir: '../evil',
      fileName: 'a.txt',
      content: 'x'
    })
    out.rejectsTraversalSubDir = !!rTrav && rTrav.ok === false && rTrav.code === 'EINVALID_SUBDIR'

    const rMiss = await api.writeToDir({
      dir: DIR + '/nope-not-here',
      fileName: 'a.txt',
      content: 'x'
    })
    out.rejectsMissingDir = !!rMiss && rMiss.ok === false && rMiss.code === 'ENOENT'

    // 文件名越界「不拒绝而是改写」——与子目录越界的策略刻意不对称：
    // 书名里带个斜杠不该让整次导出失败。这条钉死该策略，防止后来者悄悄翻转。
    const w3 = await api.writeToDir({
      dir: DIR,
      subDir: 's',
      fileName: '../../evil.txt',
      content: 'x'
    })
    const seg = w3 && w3.ok ? String(w3.filePath).split(/[\\/]/) : []
    out.sanitizedFileNameStaysInDir =
      !!w3 &&
      w3.ok === true &&
      seg[seg.length - 1] === '_.._evil.txt' &&
      seg[seg.length - 2] === 's'

    // 删除通道（自动备份淘汰旧文件走的就是它）。
    // 在根目录放一个诱饵，然后用 `../outside.txt` 试图越界删除它：
    // 应当只删掉书屋里的 1 个文件，诱饵必须毫发无损。
    const wOutside = await api.writeToDir({ dir: DIR, fileName: 'outside.txt', content: '诱饵' })
    const delRes = await api.deleteFiles({
      dir: DIR,
      subDir: '书屋',
      fileNames: ['a (1).txt', '../outside.txt']
    })
    const afterDel = await api.listFiles({ dir: DIR, subDir: '书屋' })
    const rootFiles = await api.listFiles({ dir: DIR })
    out.deleteFilesOk =
      !!delRes &&
      delRes.ok === true &&
      delRes.deleted === 1 &&
      afterDel.files.length === 1 &&
      !!wOutside &&
      rootFiles.files.includes('outside.txt')

    // ------------------------------------------------------------------
    // F) D5 改名（不打开书也能改）与 D6 返回书库的顺序
    // ------------------------------------------------------------------
    const b2 = await b.createBook({ title: '待改名' })
    await b.updateBookById(b2.id, { title: '已改名' })
    const booksNow = await db.getBooks()
    out.renameBookOk = booksNow.some((x) => x.id === b2.id && x.title === '已改名')
    await b.removeBook(b2.id)

    // D6：正确顺序是 flush → closeBook。若先 closeBook，store.chapters 已被清空，
    // 最后一笔就再也写不回去了。这里证明「先落盘」的内容确实留得住。
    const bookD6 = await b.createBook({ title: '测试小说' })
    const cD6 = await b.addChapter()
    b.setChapterContent(cD6.id, '最后的一笔改动')
    await b.persistChapter(cD6.id)
    b.closeBook()
    const persistedD6 = await db.getChapters(bookD6.id)
    out.closeBookFlushOk = persistedD6.length === 1 && persistedD6[0].content === '最后的一笔改动'
    await b.removeBook(bookD6.id)

    // 清理测试数据：只断言「本次建的书没了」，不再假设整个库是空的
    await b.removeBook(book.id)
    const left = await db.getBooks()
    out.cleaned =
      !left.some((x) => x.id === book.id) &&
      (await db.rawGet('chapters:' + book.id)) === undefined

    // 纵深防御：关书后任何以 bookId 为作用域的写入都必须被拦下，
    // 「chapters:null」这类垃圾键永远不能再被创建出来。
    // 走 storage 层直调而非 persistChapter——后者在 store.chapters 里找不到就直接
    // 返回了，根本到不了存储层，那样的断言恒真、毫无价值。
    b.closeBook()
    await db.upsertChapter(null, { id: 'x', title: 't', content: 'c', order: 1 })
    await db.upsertOutline(null, { id: 'y', type: 'outline', title: 't', content: 'c' })
    await db.saveChapters(null, [{ id: 'z' }])
    await db.saveOutlines(null, [{ id: 'z' }])
    out.closeBookGuard =
      (await db.rawGet('chapters:null')) === undefined &&
      (await db.rawGet('outlines:null')) === undefined
    out.closeBookCleared =
      b.store.bookId === null && b.store.book === null && b.store.chapters.length === 0

    // ------------------------------------------------------------------
    // H) 组件挂载冒烟：走真实点击路径
    //
    // 这一节的价值在于覆盖「只有运行时才会暴露的错误」。纯 store 层的断言和
    // npm run build 都发现不了一类 bug：setup 期间访问尚未初始化的 const
    // （TDZ ReferenceError），表现为一打开书就白屏。Editor 就踩过一次——
    // immediate 的章节 watcher 回调引用了在它下面才声明的 findCursor。
    // 所以这里必须真的点开一本书，而不是只调 store。
    // ------------------------------------------------------------------
    const uiBook = await b.createBook({ title: '测试小说', intro: '挂载冒烟' })
    await b.addChapter()
    await new Promise((r) => setTimeout(r, 80))

    const card = [...document.querySelectorAll('.book-card')].find(
      (el) => el.querySelector('.title')?.textContent === '测试小说'
    )
    out.uiCardFound = !!card
    if (card) {
      card.click()
      // openBook 是异步的，且 WritingView 要等它 resolve 后才会有章节
      await new Promise((r) => setTimeout(r, 400))
      out.uiWritingMounted =
        !!document.querySelector('.editor-ta') &&
        !!document.querySelector('.sidebar') &&
        !!document.querySelector('.ai-panel')

      // 查找栏：Editor 的查找/替换状态正是在 setup 期被 watcher 碰过的那批
      const findBtn = [...document.querySelectorAll('.editor-ops .btn')].find(
        (el) => el.textContent.trim() === '查找'
      )
      findBtn?.click()
      await new Promise((r) => setTimeout(r, 80))
      out.uiFindBar = !!document.querySelector('.find-bar')
      document.querySelector('.find-bar .btn.ghost')?.click()
      await new Promise((r) => setTimeout(r, 50))

      // 返回书库：顺带覆盖 handleBackToShelf → flush → closeBook 的真实编排
      const backBtn = [...document.querySelectorAll('.topbar .btn')].find(
        (el) => el.textContent.trim() === '返回书库'
      )
      backBtn?.click()
      await new Promise((r) => setTimeout(r, 300))
      out.uiBackToShelf = !!document.querySelector('.shelf') && !document.querySelector('.editor')
    }
    await b.removeBook(uiBook.id)

    // 关键断言：整轮跑下来渲染进程不得有被吞掉的运行时错误。
    // 这一条才是真正兜住「组件里抛异常」的网——它就抓到过 Editor 里
    // immediate watcher 引用尚未初始化的 findCursor 导致的 TDZ ReferenceError。
    const realErrors = swallowedErrors.filter((m) =>
      /ReferenceError|TypeError|is not a function|Cannot read|before initialization/.test(m)
    )
    out.uiNoSwallowedErrors = realErrors.length === 0
    if (realErrors.length) out.uiSwallowedSample = realErrors[0].slice(0, 300)

    // ------------------------------------------------------------------
    // G) 流式管线端到端测试（本地 SSE mock 服务器，端口见 __PORT__）
    // ------------------------------------------------------------------
    const baseUrl = `http://127.0.0.1:__PORT__/v1`
    const sseSettings = { baseUrl, apiKey: 'k', model: 'm', temperature: 0.3, maxTokens: 100 }

    const collect = (settings, messages, extra = {}) =>
      new Promise((resolve) => {
        const acc = { text: '', err: '', done: false, aborted: false }
        const timer = setTimeout(() => resolve({ ...acc, err: 'timeout' }), 8000)
        const finish = (o) => {
          clearTimeout(timer)
          resolve(o)
        }
        chatStream({
          settings,
          messages,
          ...extra,
          callbacks: {
            onDelta: (t) => (acc.text += t),
            onError: (m) => finish({ ...acc, err: m }),
            onDone: () => finish({ ...acc, done: true }),
            onAborted: () => finish({ ...acc, aborted: true })
          }
        })
      })

    // G1) IPC 代理路径（桌面端生产路径）
    const rIpc = await collect(sseSettings, [{ role: 'user', content: 'hi' }])
    out.streamIpc = rIpc.done && rIpc.text === '你好，世界！'

    // G2) 错误路径：HTTP 500
    const rErr = await collect({ ...sseSettings, baseUrl: `http://127.0.0.1:__PORT__/error` }, [
      { role: 'user', content: 'hi' }
    ])
    out.streamError = !rErr.done && rErr.err.includes('HTTP 500')

    // G3) 浏览器直连路径（forceBrowser 强制走 fetch，模拟浏览器/Android WebView 场景）
    const rBr = await collect(sseSettings, [{ role: 'user', content: 'hi' }], { forceBrowser: true })
    out.streamBrowser = rBr.done && rBr.text === '你好，世界！'

    // G4) SSE 行解析
    out.parseOk =
      parseSseLine('data: {"choices":[{"delta":{"content":"你好"}}]}') === '你好' &&
      parseSseLine('data: [DONE]') === '' &&
      parseSseLine('not sse') === '' &&
      buildChatUrl('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions' &&
      buildChatUrl('https://x/v1/chat/completions') === 'https://x/v1/chat/completions'

    // 收尾：把新增的设置键复位，别把开发者留在一个会被静默改写的配置上
    await resetSettings()

    out.pass =
      out.saveDirDefaults &&
      out.settingsBackfill &&
      out.saveDirPersisted &&
      out.chapterMarkdownOk &&
      out.sanitizeOk &&
      out.backupNameOk &&
      out.exportTargetOk &&
      out.staleBackupsOk &&
      out.autosaveDebounce &&
      out.autosaveFlushTarget &&
      out.autosaveNoClobber &&
      out.createdBook &&
      out.chapterCount === 1 &&
      out.contentSaved &&
      out.outlineCount === 2 &&
      out.msgCount === 2 &&
      out.msgRolesOk &&
      out.msgHasContext &&
      out.multiOutlineOk &&
      out.txtOk &&
      out.mdOk &&
      out.persisted === '1/1/2' &&
      out.settingsSaved &&
      out.smokeDirInjected &&
      out.saveDirChannels &&
      out.writeToDir &&
      out.writeBytesOk &&
      out.collisionSafe &&
      out.subDirCreated &&
      out.rejectsRelativeDir &&
      out.rejectsTraversalSubDir &&
      out.rejectsMissingDir &&
      out.sanitizedFileNameStaysInDir &&
      out.deleteFilesOk &&
      out.renameBookOk &&
      out.closeBookFlushOk &&
      out.cleaned &&
      out.closeBookGuard &&
      out.closeBookCleared &&
      out.uiCardFound &&
      out.uiWritingMounted &&
      out.uiFindBar &&
      out.uiBackToShelf &&
      out.uiNoSwallowedErrors &&
      out.streamIpc &&
      out.streamError &&
      out.streamBrowser &&
      out.parseOk
  } catch (e) {
    out.error = String((e && e.stack) || e)
    out.pass = false
  }
  return out
})()
