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
      chatStreamReliable,
      classifyError,
      redactSecrets,
      describeError,
      computeBackoff,
      shouldRetry,
      parseSseChunk,
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
      buildChatUrl,
      useNovelMemory,
      useStoryStructure,
      useGeneration,
      aggregateRuns,
      countWords,
      normalizePricing,
      findPrice,
      estimateTokens,
      computeCost,
      DEFAULT_PRICING,
      planMigration,
      planMigrationForBook,
      applyMigration,
      ensureSchemaVersion,
      SCHEMA_VERSION,
      buildContext,
      buildLayers,
      messagesFromContext,
      parseSseUsage,
      describeRun,
      runChapterWorkflow,
      extractJson,
      classifyRisk,
      diffMemoryCandidates,
      undoMemoryChange,
      PROMPT_VERSION,
      STAGE_LABELS,
      // V3 阶段 3：同步冲突副本与数据版本拒绝
      CONFLICT_TITLE_PREFIX,
      handleIncomingSnapshot,
      mergeSnapshot,
      snapshotStats,
      diffSnapshots,
      parseSnapshotJson,
      toSnapshotJson,
      collectSnapshot,
      applySnapshot,
      emptySnapshot,
      snapshotChecksum,
      cloneSnapshotAsNewBooks,
      createTaskRecord,
      appendDraft,
      markRunningInterrupted,
      pickRecoverable,
      buildVersion,
      pruneVersions,
      captureVersion,
      listVersions,
      groupVersions,
      versionDelta,
      DEFAULT_VERSION_KEEP,
      buildTimeline,
      findBrokenRefs,
      runRuleChecks,
      CONSISTENCY_RULES,
      timeKey,
      // V3 阶段 4：版本差异、施工卡、审校问题生命周期
      diffText,
      collapsedDiff,
      splitSentences,
      checkChapterPlan,
      planCompleteness,
      buildPlanProposal,
      missingLockedBeats,
      flattenReviewReport,
      isIssueStale,
      contentHashOf,
      saveIssueStates,
      setIssueStatus,
      DEFAULT_STAGES,
      // V4 阶段 3：生成前计划校验
      validatePlan,
      shouldBlockPlan,
      validationSummary,
      SNAPSHOT_VERSION,
      // V4 阶段 4：持久化写作队列
      useWritingQueue,
      queueStore,
      recoverQueueItems,
      LOCAL_ONLY_COLLECTIONS,
      buildSnapshot,
      // V4 阶段 5：本地哈希检索
      ensureBookIndex,
      getRagIndexStatus,
      clearBookIndex,
      searchRag,
      retrieveRagContext,
      EMBEDDING_DIM,
      // V4 阶段 6：人物关系图
      buildRelationshipGraph,
      layoutRelationshipGraph,
      parseRelationshipText,
      GRAPH_EDGE_KINDS,
      // V4 阶段 7：WebDAV 同步
      syncWithWebdav,
      testWebdav,
      describeWebdavState,
      parseDavBase,
      // V4 阶段 8：声明式插件
      validatePluginManifest,
      normalizePluginList,
      pluginContextFragments,
      runPluginRules,
      collectKeywordHints,
      renderExportTemplate,
      pluginTemplates,
      pluginState,
      usePlugins,
      // V2 第二阶段：局域网同步（渲染层这一半；主进程那一半走 window.electronAPI）
      pushSnapshot,
      syncState,
      normalizeSyncUrl,
      testConnection
    } = window.__ns
    const b = useBooks()
    const s = useSettings()
    await s.load()
    await b.init()

    // 后加的设置键：整轮测试前后各复位一次。
    // 开头的复位才是真正的保护——即使上一次运行中途崩了也能自愈。
    const NEW_KEYS = [
      'saveDir',
      'exportMode',
      'perBookFolder',
      'openFolderAfterExport',
      'autoBackup',
      'backupInterval',
      'backupKeep',
      // V2
      'showUsage',
      'streamUsage',
      'pricing',
      'contextBudget',
      'autoExtractMemory',
      'reviewHighRisk',
      'autoApplyLowRisk',
      'versionKeep',
      // V2 第二阶段：局域网同步
      'syncPort',
      'syncAutoStart',
      'syncUrl',
      'syncCode',
      'syncConflictCopies',
      // V3 阶段 2：请求稳定性
      'requestIdleTimeoutSec',
      'maxRetries',
      // V4：服务商 / 设备 / 计划校验 / RAG / WebDAV / 插件
      'providerId',
      'deviceName',
      'planValidation',
      'rag',
      'webdav',
      'plugins'
    ]
    const resetSettings = async () => {
      // API Key 也复位：冒烟测试会写入假 Key，而且（桌面端）会走 safeStorage。
      // 主进程在 SMOKE_TEST 下把安全存储指向临时目录，所以这里删的是测试自己的码。
      await s.clearApiKey()
      for (const k of NEW_KEYS) {
        // 对象/数组型设置必须拷一份：直接赋默认值的引用，会让测试里对
        // settings 的临时改动污染 defaultSettings，进而让「恢复默认」失效。
        const v = defaultSettings[k]
        s.settings[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v
      }
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
    // 整书墓碑是全局键，每删一本书就多一条。测试里删掉的书没有同步对象，
    // 留着只会在开发者的库里越积越多，故与设置一样前后各清一次。
    await db.rawDelete('bookTombstones')

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
      // 旧记录里没有 versionKeep —— 回填靠的就是 Object.assign 那一层浅合并
      s.settings.versionKeep === 10 &&
      s.settings.apiKey === 'legacy-key' &&
      s.settings.baseUrl === 'https://legacy.example'

    // 桌面端：load() 必须把旧明文 Key 迁进 safeStorage，并把 IndexedDB 里那份清掉。
    // 顺序是「先加密写成功、再清明文」—— 失败时旧明文仍在，不丢 Key。
    const recAfterBackfill = await db.getSettings()
    out.secureKeyMigrationOk =
      !s.settings.secureKeyAvailable || !recAfterBackfill || !recAfterBackfill.apiKey
    if (s.settings.secureKeyAvailable) {
      const sec = await window.electronAPI.secretGet()
      out.secureKeyReadOk = !!sec && sec.ok === true && sec.value === 'legacy-key'
    } else {
      // 系统安全存储不可用（如无 keyring 的 Linux）：跳过而不是假装通过
      out.secureKeyReadOk = true
    }

    s.settings.saveDir = 'D:/ns-smoke-persist'
    await s.persist()
    const recAfter = await db.getSettings()
    out.saveDirPersisted = !!recAfter && recAfter.saveDir === 'D:/ns-smoke-persist'
    s.settings.saveDir = ''
    s.settings.baseUrl = defaultSettings.baseUrl
    s.settings.model = defaultSettings.model
    await s.clearApiKey()

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

    // 设置持久化。API Key 的落点随平台不同：
    //  - 桌面端（safeStorage 可用）：密文进主进程，IndexedDB 里**不能**有明文；
    //  - 否则：维持旧行为，明文进 IndexedDB。
    s.settings.apiKey = 'sk-test-123'
    await s.persistApiKey()
    const loadedSettings = await db.getSettings()
    if (s.settings.secureKeyAvailable) {
      const sec = await window.electronAPI.secretGet()
      out.settingsSaved =
        !!loadedSettings &&
        loadedSettings.apiKey === undefined &&
        !!sec &&
        sec.ok === true &&
        sec.value === 'sk-test-123'
    } else {
      out.settingsSaved = loadedSettings && loadedSettings.apiKey === 'sk-test-123'
    }
    out.settingsNoPlaintextKey =
      !s.settings.secureKeyAvailable || !loadedSettings || loadedSettings.apiKey === undefined

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
    // F2) V4 指针：打开书回到上次那一章 / 删当前章不跳回第一章 / 不碰 updatedAt
    // ------------------------------------------------------------------
    const pBook = await b.createBook({ title: '测试小说', intro: 'V4 指针' })
    const p1 = await b.addChapterWithContent('第一章正文', '第一章')
    const p2 = await b.addChapterWithContent('第二章正文', '第二章')
    const p3 = await b.addChapterWithContent('第三章正文', '第三章')
    await db.coll.volumes.upsert(pBook.id, { id: 'vol-ptr', title: '测试卷' })
    await db.coll.arcs.upsert(pBook.id, { id: 'arc-ptr', title: '测试篇', volumeId: 'vol-ptr' })
    await b.updateChapter(p2.id, { arcId: 'arc-ptr' })
    const bookBefore = (await db.getBooks()).find((x) => x.id === pBook.id)

    await b.selectChapter(p2.id)
    out.pointerDeriveOk =
      b.store.book.currentChapterId === p2.id &&
      b.store.book.currentArcId === 'arc-ptr' &&
      b.store.book.currentVolumeId === 'vol-ptr'
    await b.flushCurrentPointers()
    const bookAfter = (await db.getBooks()).find((x) => x.id === pBook.id)
    out.pointerPersistOk =
      bookAfter.currentChapterId === p2.id &&
      bookAfter.currentArcId === 'arc-ptr' &&
      bookAfter.currentVolumeId === 'vol-ptr' &&
      bookAfter.currentPointerUpdatedAt > 0
    // 指针写的是 books 记录，但**不能**刷新 book.updatedAt：同步按它合并书本体，
    // 每次切章都刷新会让「另一台设备改书名」永远输给「这台设备翻了一页」。
    out.pointerKeepsBookUpdatedAtOk = bookAfter.updatedAt === bookBefore.updatedAt

    // 模拟重启：内存里只剩库里那一份，openBook 必须回到上次那一章
    b.closeBook()
    b.store.books = await db.getBooks()
    await b.openBook(pBook.id)
    out.pointerRestoreOnOpenOk =
      b.store.chapterId === p2.id &&
      b.store.book.currentChapterId === p2.id &&
      b.store.book.currentArcId === 'arc-ptr'

    // 同步重载：库里记住的是 p1（上次 flush），但同步前正看着 p2 —— 以 p2 为准
    await b.selectChapter(p1.id)
    await b.flushCurrentPointers()
    await b.selectChapter(p2.id)
    const reloaded = await window.__ns.reloadAfterSync()
    out.pointerSurvivesSyncReloadOk =
      reloaded.bookId === pBook.id &&
      b.store.chapterId === p2.id &&
      b.store.book.currentChapterId === p2.id

    // 删掉当前章：落到原位置的下一章，而不是跳回第一章
    await b.removeChapter(p2.id)
    out.pointerFallbackAfterDeleteOk =
      b.store.chapterId === p3.id &&
      b.store.book.currentChapterId === p3.id &&
      b.store.book.currentArcId === null
    await b.removeBook(pBook.id)

    // ------------------------------------------------------------------
    // I) V2 存储地基：集合工厂 / 墓碑 / bookId 守卫 / 写队列串行化 / 价目与成本
    //
    // 这一节全部围绕本次新建的 v2 书，不碰库里的既有数据。
    // ------------------------------------------------------------------
    const v2Book = await b.createBook({ title: '测试小说', intro: 'V2 存储地基' })
    const v2id = v2Book.id
    const mem = useNovelMemory()

    // I1) 增 / 改 与时间戳。createdAt 不能在更新时被刷新——否则「什么时候建的」
    //     就永久丢了，而同步要靠 updatedAt 做后写覆盖，两个时间戳各司其职。
    await mem.upsert('characters', { id: 'c1', name: '林昭', status: 'alive' })
    const bornAt = mem.store.characters.find((r) => r.id === 'c1').createdAt
    await new Promise((r) => setTimeout(r, 5))
    await mem.upsert('characters', { id: 'c1', name: '林昭', status: 'dead' })
    await mem.upsert('characters', { id: 'c2', name: '苏九', status: 'alive' })
    const reloadedChars = await db.coll.characters.getAll(v2id)
    const c1 = reloadedChars.find((r) => r.id === 'c1')
    out.collCrudOk =
      reloadedChars.length === 2 &&
      c1.status === 'dead' &&
      reloadedChars.every((r) => r.bookId === v2id && !!r.createdAt && !!r.updatedAt)
    out.collTimestampsOk = c1.createdAt === bornAt && c1.updatedAt > bornAt

    // I2) 删除必须同时留下墓碑：数组里没有它了，但删除这件事被记下来了。
    //     缺了墓碑，将来做设备同步时「删掉的章节在另一台设备上复活」就会发生。
    await mem.remove('characters', 'c2')
    const liveChars = await db.coll.characters.getAll(v2id)
    const tombs1 = await db.getTombstones(v2id)
    out.collTombstoneOk =
      !liveChars.some((r) => r.id === 'c2') &&
      liveChars.length === 1 &&
      tombs1.some((t) => t.type === 'characters' && t.id === 'c2' && t.deletedAt > 0)

    // I3) 章节走的是老式的整数组硬删除，但同样要记墓碑；且对 UI 的行为必须
    //     与从前逐字一致（删除后 store.chapters 里不能冒出幽灵项）。
    const vc = await b.addChapterWithContent('测试正文')
    const chaptersBefore = b.store.chapters.length
    await b.removeChapter(vc.id)
    out.chapterDeleteTombstoneOk =
      b.store.chapters.length === chaptersBefore - 1 &&
      !b.store.chapters.some((c) => c.id === vc.id) &&
      (await db.getTombstones(v2id)).some((t) => t.type === 'chapters' && t.id === vc.id)

    // I4) 建章时补上的 V2 字段：wordCount 必须与编辑器显示同一口径
    const vc2 = await b.addChapterWithContent('你好，世界！')
    out.chapterWordCountOk =
      vc2.wordCount === countWords('你好，世界！').total && vc2.wordCount === 6
    out.wordCountOk =
      countWords('你好，世界！').total === 6 &&
      countWords('你好，世界！').cjk === 4 &&
      countWords('ab cd').total === 4 &&
      countWords('').total === 0 &&
      countWords(null).total === 0

    // I5) bookId 守卫。走 storage 层直调而非常规入口——store 层在 bookId 为空时
    //     根本走不到存储层，那样的断言恒真、毫无价值（同 closeBookGuard 的理由）。
    await db.coll.characters.upsert(null, { id: 'ghost' })
    await db.coll.characters.remove(null, 'ghost')
    await db.coll.characters.saveAll(null, [{ id: 'ghost' }])
    await db.addTombstone(null, 'characters', 'ghost')
    out.collGuardOk =
      (await db.rawGet('characters:null')) === undefined &&
      (await db.rawGet('tombstones:null')) === undefined

    // I6) 写队列串行化。四条并发 upsert 各自「读-改-写」，没有 serialize 时
    //     它们会读到同一份快照、然后互相覆盖，最后只剩一条。这条断言就是
    //     「新集合的每一个写入口都包了 serialize」的直接证据。
    await Promise.all([
      db.coll.characters.upsert(v2id, { id: 's1', name: 'A' }),
      db.coll.characters.upsert(v2id, { id: 's2', name: 'B' }),
      db.coll.characters.upsert(v2id, { id: 's3', name: 'C' }),
      db.coll.characters.upsert(v2id, { id: 's4', name: 'D' })
    ])
    const conc = await db.coll.characters.getAll(v2id)
    out.collSerializedOk = ['s1', 's2', 's3', 's4'].every((id) => conc.some((r) => r.id === id))

    // I7) 价目表的浅合并坑：存储里的旧条目缺字段时必须从默认值补齐，
    //     否则以后新增的字段在老用户那里永远是空的，金额静默算成 0。
    const partial = [{ match: 'deepseek-chat', inputPerM: 1 }]
    const norm = normalizePricing(partial)
    const normChat = norm.find((e) => e.match === 'deepseek-chat')
    out.pricingNormalizeOk =
      normChat.inputPerM === 1 && // 用户显式给的值要保留
      normChat.outputPerM === 8 && // 缺的字段从默认条目补齐
      normChat.currency === 'CNY' &&
      normChat.label === 'DeepSeek Chat' &&
      norm.some((e) => e.match === '*') && // 兜底条目必须在
      norm !== partial &&
      normalizePricing(null).length === DEFAULT_PRICING.length

    // I8) 定价查找：最长前缀优先，未命中落到 '*'
    out.pricingLookupOk =
      findPrice(DEFAULT_PRICING, 'deepseek-chat').inputPerM === 2 &&
      findPrice(DEFAULT_PRICING, 'deepseek-chat-v3').match === 'deepseek-chat' &&
      findPrice(DEFAULT_PRICING, 'deepseek-reasoner').outputPerM === 16 &&
      findPrice(DEFAULT_PRICING, 'gpt-4o').match === '*' &&
      findPrice(DEFAULT_PRICING, '').match === '*'

    // I9) 成本算术。取不到价目必须是 null 而不是 0——「不知道多少钱」和
    //     「不花钱」是两件事，后者会显示成 ¥0 误导用户。
    const cost1 = computeCost(1e6, 1e6, { inputPerM: 2, outputPerM: 8, currency: 'CNY' })
    const cost2 = computeCost(500000, 250000, { inputPerM: 4, outputPerM: 16, currency: 'USD' })
    out.costMathOk =
      cost1.total === 10 &&
      cost1.inputCost === 2 &&
      cost1.outputCost === 8 &&
      cost1.currency === 'CNY' &&
      cost2.total === 2 + 4 &&
      cost2.currency === 'USD' &&
      computeCost(100, 100, null) === null &&
      estimateTokens('') === 0 &&
      estimateTokens('你好世界') === 4

    // I10) 生成记录落库与聚合。真实用量与估算用量必须能区分开，
    //      合计里只要混进估算值就要标出来。
    const gen = useGeneration()
    await gen.recordRun({
      action: 'chapter',
      stage: 'write',
      model: 'deepseek-chat',
      chapterId: vc2.id,
      inputTokens: 1000,
      outputTokens: 500
    })
    await gen.recordRun({
      action: 'continue',
      stage: 'write',
      model: 'deepseek-chat',
      inputText: '你好',
      outputText: '世界'
    })
    const runs = await db.coll.generationRuns.getAll(v2id)
    const agg = aggregateRuns(runs)
    out.generationRunPersisted =
      runs.length === 2 &&
      agg.inputTokens === 1000 + estimateTokens('你好') &&
      agg.outputTokens === 500 + estimateTokens('世界') &&
      agg.totalTokens === agg.inputTokens + agg.outputTokens &&
      agg.cost > 0 &&
      agg.estimated === true &&
      runs.some((r) => r.usageSource === 'provider') &&
      runs.some((r) => r.usageSource === 'estimated') &&
      runs.every((r) => r.bookId === v2id)

    // I11) 剧情结构走的是同一套集合机制，顺带验证 order 排序生效
    const struct = useStoryStructure()
    await struct.upsert('volumes', { id: 'v2', title: '第二卷', order: 2 })
    await struct.upsert('volumes', { id: 'v1', title: '第一卷', order: 1 })
    out.structureOrderOk =
      struct.store.volumes.map((r) => r.id).join(',') === 'v1,v2' &&
      (await db.coll.volumes.getAll(v2id)).map((r) => r.id).join(',') === 'v1,v2'

    // I12) 整书删除：级联删掉所有 V2 集合的键，并留下整书墓碑
    await b.removeBook(v2id)
    out.collCascadeOk =
      (await db.rawGet('characters:' + v2id)) === undefined &&
      (await db.rawGet('tombstones:' + v2id)) === undefined &&
      (await db.rawGet('volumes:' + v2id)) === undefined &&
      (await db.rawGet('generationRuns:' + v2id)) === undefined
    out.bookTombstoneOk = (await db.getBookTombstones()).some((t) => t.id === v2id)

    // ------------------------------------------------------------------
    // J) V2 迁移：非破坏 / 幂等 / 只转换有明确对应关系的
    // ------------------------------------------------------------------
    const migBook = await b.createBook({ title: '测试小说', intro: '迁移冒烟' })
    const migId = migBook.id
    await b.addOutline({ type: 'character', title: '林昭', content: '主角，剑修，沉默寡言。' })
    await b.addOutline({ type: 'character', title: '苏九', content: '配角，药师。' })
    await b.addOutline({ type: 'world', title: '灵气枯竭', content: '天地灵气每百年衰减一成。' })
    await b.addOutline({ type: 'outline', title: '全书大纲', content: '第一卷：入宗。第二卷：叛出。' })
    const legacyBefore = JSON.parse(JSON.stringify(await db.getOutlines(migId)))

    const plan1 = await planMigrationForBook(migId)
    out.migrationPlanOk =
      plan1.candidates.length === 3 &&
      plan1.candidates.filter((c) => c.kind === 'characters').length === 2 &&
      plan1.candidates.filter((c) => c.kind === 'worldRules').length === 1 &&
      plan1.stats.unconvertible === 1 &&
      plan1.candidates.find((c) => c.sourceId === legacyBefore[0].id).data.name === '林昭' &&
      plan1.candidates.find((c) => c.sourceId === legacyBefore[2].id).data.rule ===
        '天地灵气每百年衰减一成。'

    const applied = await applyMigration(migId, plan1.candidates)
    const legacyAfter = await db.getOutlines(migId)
    out.migrationAppliedOk =
      applied.migrated === 3 &&
      applied.failed.length === 0 &&
      (await db.coll.characters.getAll(migId)).length === 2 &&
      (await db.coll.worldRules.getAll(migId)).length === 1

    // 非破坏：被转换的源行只多了一个 migratedTo，其余字段逐字未变；
    // 故事大纲那一条连 migratedTo 都不该有（它压根没被转换）。
    const byId = new Map(legacyAfter.map((o) => [o.id, o]))
    const unchangedExceptMeta = (before, after) => {
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (k === 'migratedTo' || k === 'updatedAt') continue
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return false
      }
      return true
    }
    out.migrationNoDestroyOk =
      legacyAfter.length === 4 &&
      legacyBefore.every((o) => unchangedExceptMeta(o, byId.get(o.id))) &&
      legacyBefore.slice(0, 3).every((o) => (byId.get(o.id).migratedTo || []).length === 1) &&
      (byId.get(legacyBefore[3].id).migratedTo || []).length === 0

    // 幂等：再规划一次产出 0 条候选，三条被 migratedTo 挡下、一条不可转换
    const plan2 = await planMigrationForBook(migId)
    out.migrationIdempotentOk = plan2.candidates.length === 0 && plan2.stats.skippedMigrated === 3

    // 第二道护栏：用户手建的 V2 实体与尚未迁移的旧设定重名时，不该再造一个。
    // 这条护栏是必需的，不是冗余 —— 用户在侧栏编辑旧设定时，内存里的副本会整体
    // 覆盖回去（useBooks.updateOutline 的读-改-写不带 migratedTo），第一道护栏
    // 会因此失效，只剩这条还起作用。
    const dupOut = await b.addOutline({ type: 'character', title: '林 昭', content: '重复的人物设定' })
    const plan3 = await planMigrationForBook(migId)
    out.migrationDedupOk = plan3.candidates.length === 0 && plan3.stats.skippedDuplicate === 1
    await b.removeOutline(dupOut.id)

    // schemaVersion 只是标记，不做破坏性转换；重复执行应是空操作
    const metaBefore = await ensureSchemaVersion()
    const metaAfter = await ensureSchemaVersion()
    out.schemaVersionOk =
      metaBefore.schemaVersion === SCHEMA_VERSION &&
      metaAfter.updatedAt === metaBefore.updatedAt &&
      Array.isArray(metaBefore.migrations) &&
      metaBefore.migrations.some((m) => m.to === SCHEMA_VERSION && m.automatic === true)

    // ------------------------------------------------------------------
    // K) V2 Context Builder：分层 / 预算分配 / 与旧设定去重
    //    接着 J 迁移完的这本书记续测 —— 它同时有 V2 实体与未删的旧设定行，
    //    正是「去重护栏」唯一能被真正验证的数据状态。
    // ------------------------------------------------------------------
    const kChapter = await b.addChapterWithContent('林昭推开药庐的门，看见苏九正在碾药。', '雨夜')
    const kChapters = await db.getChapters(migId)
    const kOutlines = await db.getOutlines(migId)
    const kMemory = {
      characters: await db.coll.characters.getAll(migId),
      worldRules: await db.coll.worldRules.getAll(migId),
      locations: [],
      factions: [],
      events: [],
      foreshadowing: []
    }
    const kInput = (over = {}) => ({
      book: migBook,
      chapter: kChapter,
      chapters: kChapters,
      outlines: kOutlines,
      memory: kMemory,
      structure: { volumes: [], arcs: [] },
      settings: s.settings,
      action: 'continue',
      instruction: '接着写林昭与苏九在药庐的对话',
      ...over
    })

    // 预算：各层 token 之和等于总计且不超预算；同一输入两次组装逐字一致。
    // 「确定性」不是锦上添花 —— 组装结果若随集合的加载顺序漂移，出了提示词
    // 回归根本无从复现，而这类漂移在界面上一眼看不出来。
    const ctx1 = buildContext(kInput(), 6000)
    const ctx2 = buildContext(kInput(), 6000)
    const layerSum = ctx1.metadata.layers.reduce((a, l) => a + l.tokens, 0)
    out.contextBudgetOk =
      layerSum === ctx1.metadata.totalTokens &&
      layerSum > 0 &&
      layerSum <= 6000 &&
      ctx1.metadata.overBudget === false &&
      ctx1.system === ctx2.system &&
      ctx1.context === ctx2.context &&
      ctx1.task === ctx2.task &&
      ctx1.system.includes('直接输出正文')

    // 极小预算：required 层（写作硬规则、本次要求）必须保住，其余层被丢弃并记进
    // metadata。留半句话比不留更糟——模型会把半截设定当成完整设定照做。
    const tiny = buildContext(kInput(), 60)
    out.contextDropOk =
      tiny.metadata.overBudget === true &&
      tiny.metadata.droppedLayers.length > 0 &&
      tiny.metadata.layers.filter((l) => l.required).every((l) => l.tokens > 0 && !l.dropped) &&
      tiny.system.includes('不得擅自改变人物的既有设定') &&
      tiny.task.includes('接着写林昭与苏九在药庐的对话')

    // 去重：迁移过的旧设定行不得与 V2 实体一起被注入。第二道护栏单独验一次——
    // 用户编辑旧设定时 updateOutline 会把内存副本整体写回，migratedTo 会丢，
    // 那时只剩规范化标题比对还挡着（见 migration.js 的说明）。
    const countOf = (hay, needle) => hay.split(needle).length - 1
    const layerText = (layers, id) =>
      (layers.find((l) => l.id === id)?.items || []).map((i) => i.text).join('\n')
    const layersA = buildLayers(kInput())
    const layersB = buildLayers(kInput({ outlines: kOutlines.map((o) => ({ ...o, migratedTo: undefined })) }))
    out.contextNoDupOk =
      countOf(layerText(layersA, 'characters'), '林昭') === 1 &&
      countOf(layerText(layersA, 'characters'), '苏九') === 1 &&
      countOf(layerText(layersA, 'worldRules'), '灵气枯竭') === 1 &&
      countOf(layerText(layersB, 'characters'), '林昭') === 1 &&
      countOf(layerText(layersB, 'characters'), '苏九') === 1 &&
      countOf(layerText(layersB, 'worldRules'), '灵气枯竭') === 1

    const mctx = messagesFromContext(ctx1)
    out.contextMessagesOk =
      mctx.length === 2 &&
      mctx[0].role === 'system' &&
      mctx[0].content === ctx1.system &&
      mctx[1].role === 'user' &&
      mctx[1].content === [ctx1.context, ctx1.task].filter((x) => x.trim()).join('\n\n') &&
      messagesFromContext(null).length === 0

    // 旧路径必须原样可用：expand / rewrite / outline 三个模式本轮仍走 buildMessages，
    // 而末行的否定断言是关键 —— 若有人顺手把 buildMessages 改成转调 Context Builder，
    // 旧路径的提示词会静默变样，而三种输出看起来都「没问题」。
    const legacyMsgs = buildMessages('continue', {
      book: migBook,
      chapter: kChapter,
      chapters: kChapters,
      outlines: kOutlines,
      settings: s.settings,
      instruction: ''
    })
    out.legacyPromptUnchanged =
      legacyMsgs.length === 2 &&
      legacyMsgs[0].role === 'system' &&
      legacyMsgs[1].role === 'user' &&
      legacyMsgs[0].content.startsWith('你是一名资深中文网文小说作者') &&
      legacyMsgs[1].content.startsWith('请续写当前章节正文') &&
      legacyMsgs[1].content.includes('请直接输出正文内容，不要输出标题或任何解释。') &&
      !legacyMsgs[0].content.includes('硬性约束')

    await b.removeBook(migId)

    // ------------------------------------------------------------------
    // N) V2 全量快照：合并规则 + 真实整库往返
    //
    // 合并规则在这里被钉死，是因为它同时是「恢复备份」与（第二阶段的）「设备间
    // 同步」的行为。同步上线之后它就是被依赖的前提，届时再改代价极高；而且它是
    // 纯函数，现在验一分钱不花。
    // ------------------------------------------------------------------
    const ts = (n) => 1700000000000 + n
    const rec = (id, updatedAt, tag) => ({ id, updatedAt, tag })
    const snapOf = (books, data, bookTombstones = []) => ({
      ...emptySnapshot(0),
      books,
      data,
      bookTombstones
    })
    const bookData = (chapters, tombstones = []) => ({
      b1: { chapters, characters: [], outlines: [], tombstones }
    })
    const tomb = (id, deletedAt) => ({ id, type: 'chapters', deletedAt })

    // 同一条记录：时间戳大的赢
    const newerWins =
      mergeSnapshot(
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(10), 'local')])),
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(20), 'remote')]))
      ).data.b1.chapters[0].tag === 'remote'

    // 时间戳相同：保留本地（否则重复恢复同一个文件会让本机数据来回抖动）
    const tieKeepsLocal =
      mergeSnapshot(
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(20), 'local')])),
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(20), 'remote')]))
      ).data.b1.chapters[0].tag === 'local'

    // 墓碑新于记录 → 删除生效
    const tombstoneDeletes =
      mergeSnapshot(
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(10))])),
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(10))], [tomb('c1', ts(20))]))
      ).data.b1.chapters.length === 0

    // 墓碑旧于记录 → 记录活着（删掉之后又被编辑过，等于复活）
    const oldTombstoneKeeps =
      mergeSnapshot(
        snapOf([rec('b1', ts(1))], bookData([rec('c1', ts(30))], [tomb('c1', ts(20))])),
        snapOf([rec('b1', ts(1))], bookData([]))
      ).data.b1.chapters.length === 1

    // 同一条记录在两个快照里各有一份墓碑 → 只保留**最早**的删除时刻
    const earliestTombstone =
      mergeSnapshot(
        snapOf([], bookData([], [tomb('c1', ts(20))])),
        snapOf([], bookData([], [tomb('c1', ts(40))]))
      ).data.b1.tombstones[0].deletedAt === ts(20)

    // 整书墓碑新于书 → 书与它的 per-book 数据一起消失（不能只剩人物不知道归谁）
    const merged6 = mergeSnapshot(
      snapOf([rec('b2', ts(5))], { b2: { chapters: [rec('c2', ts(5))], tombstones: [] } }),
      snapOf([], {}, [{ id: 'b2', type: 'books', deletedAt: ts(50) }])
    )
    const bookTombstoneOk = merged6.books.length === 0 && !merged6.data.b2

    out.mergeSnapshotOk =
      newerWins &&
      tieKeepsLocal &&
      tombstoneDeletes &&
      oldTombstoneKeeps &&
      earliestTombstone &&
      bookTombstoneOk

    // 纯函数之外的另一半：真的读一遍库、真的写回去。
    // 断言「恢复一份刚刚导出的备份」是一次 no-op —— 写回时漏掉任何一个键，
    // 或者字段名对不上，都会在这里变成非零的 diff。
    const snapBook = await b.createBook({ title: '测试小说', intro: '快照往返' })
    await b.addChapter()
    const snapCh = b.store.chapters[0]
    await b.updateChapter(snapCh.id, { content: '快照往返正文' })
    await b.openBook(snapBook.id)
    const memForSnap = useNovelMemory()
    await memForSnap.upsert('characters', { name: '快照人物', status: 'alive' })
    b.closeBook()

    const exported = await collectSnapshot()
    const stats = snapshotStats(exported)
    // 不假设整个库是空的：只要求刚建的那本书与它的内容确实进了快照
    out.snapshotCollectOk =
      stats.books >= 1 &&
      stats.chapters >= 1 &&
      stats.entities >= 1 &&
      exported.data[snapBook.id]?.chapters.length === 1

    // 序列化 → 解析 → 应用。中间那次 JSON 往返是刻意的：用户实际经历的就是
    // 「写进文件、再从文件读出来」，直接传对象会漏掉序列化才暴露的问题。
    const roundTrip = await applySnapshot(parseSnapshotJson(toSnapshotJson(exported)))
    out.snapshotRoundTripOk =
      roundTrip.stats.added === 0 &&
      roundTrip.stats.updated === 0 &&
      roundTrip.stats.removed === 0 &&
      (await db.getChapters(snapBook.id)).length === 1 &&
      (await db.coll.characters.getAll(snapBook.id)).some((c) => c.name === '快照人物')

    // 选错文件时的报错必须是人话（用户很可能挑到导出的正文 .txt）
    const badFile = (text) => {
      try {
        parseSnapshotJson(text)
        return ''
      } catch (e) {
        return String((e && e.message) || e)
      }
    }
    out.snapshotParseOk =
      badFile('第一章 正文…').includes('JSON') &&
      badFile('{"format":"other"}').includes('不是 Novel Studio') &&
      badFile(toSnapshotJson({ ...exported, version: 99 })).includes('高于当前软件')

    // 校验和：内容被改过必须拒绝（截断/手改/网盘冲突都长得像合法 JSON），
    // 而**没有** checksum 的旧备份必须照常接受 —— 否则老用户的备份一夜之间失效。
    const tampered = JSON.parse(toSnapshotJson(exported))
    tampered.data[snapBook.id].chapters[0].content = '被人改过的正文'
    const legacy = JSON.parse(toSnapshotJson(exported))
    delete legacy.checksum
    out.snapshotChecksumOk =
      badFile(JSON.stringify(tampered)).includes('校验失败') &&
      parseSnapshotJson(JSON.stringify(legacy)).books.length === exported.books.length

    // 作为副本导入：书 id 全换、标题加后缀，不覆盖任何现有记录。
    let cloneSeq = 0
    const clone = cloneSnapshotAsNewBooks(exported, {
      newId: () => `smoke_clone_${++cloneSeq}`,
      now: Date.now()
    })
    out.snapshotCloneOk =
      clone.books.length === exported.books.length &&
      clone.books.every((c) => c.title.endsWith('（导入副本）')) &&
      clone.books.every((c) => !exported.books.some((o) => o.id === c.id)) &&
      clone.counts.chapters === exported.counts.chapters

    // 生成任务/流式草稿是**设备本地**的易失状态，绝不进全量备份与同步。
    const taskSnap = buildSnapshot({
      books: [{ id: 'taskbook', title: 'x' }],
      data: { taskbook: { chapters: [], generationTasks: [{ id: 'draft-secret', outputText: '草稿' }] } }
    })
    out.snapshotExcludesTasksOk = !JSON.stringify(taskSnap).includes('draft-secret')

    // 恢复前留底：全局键，且**不进快照**（否则每恢复一次就套一层，越滚越大）。
    // 这是开发者的真实库，先保存原值再恢复，不覆盖已有的留底。
    const priorPreRestore = await db.rawGet('preRestoreSnapshot')
    await db.savePreRestoreSnapshot({ format: 'smoke-pre-restore', exportedAt: 1 })
    out.preRestoreKeyOk =
      (await db.getPreRestoreSnapshot())?.format === 'smoke-pre-restore' &&
      !toSnapshotJson(await collectSnapshot()).includes('preRestoreSnapshot')
    if (priorPreRestore === undefined) await db.rawDelete('preRestoreSnapshot')
    else await db.savePreRestoreSnapshot(priorPreRestore)

    await b.removeBook(snapBook.id)

    // 版本数不进「设定」总数。一本 500 章的小说攒下几千条版本，混进 entities
    // 会让「这份备份有 3200 条设定」这种说法完全失真（generationRuns 同理）。
    const fakeStats = snapshotStats({
      ...emptySnapshot(0),
      data: {
        b9: {
          chapters: [{ id: 'c1' }],
          outlines: [],
          chapterVersions: [{ id: 'v1' }, { id: 'v2' }],
          characters: [{ id: 'p1' }],
          tombstones: []
        }
      }
    })
    out.snapshotStatsOk =
      fakeStats.entities === 1 && fakeStats.chapters === 1 && fakeStats.tombstones === 0

    // ------------------------------------------------------------------
    // N2) 章节版本：捕获 / 裁剪 / 回滚 / 误删救回 / 随快照进出
    //
    // 这套东西存在的理由只有一条：AI 覆盖整章正文是**不可逆**的。所以断言的重点
    // 不是「能存下一条记录」，而是那四个触发点真的都接上了、以及回滚本身也能被
    // 回滚 —— 否则用户点错一次就再也回不到「刚才那一版」，而那一版往往是他刚写完的。
    // ------------------------------------------------------------------
    const vBook = await b.createBook({ title: '测试小说', intro: '章节版本' })
    const verCh = await b.addChapterWithContent('第一版正文。', '第一章')

    // 空正文不存版本：「AI 覆盖一个刚建的空章」是最常见的情形，
    // 不拦住的话版本列表会被一堆空的「AI 覆盖前」塞满。
    // 这一步刻意排在动 verCh 之前：建章走的是「整组回写」，会把 store.chapters
    // 换成库里那一份，**还没落盘的内存正文会被它盖掉**（真实路径上由 WritingView
    // 的 flush 编排兜住，见 CLAUDE.md 坑 #8）。放在前面就不必依赖那个编排。
    const emptyCh = await b.addChapterWithContent('', '空章')
    const verEmpty = await b.captureChapterVersion(emptyCh.id, { source: 'ai' })

    // ① 手动存档（编辑器工具栏那颗「存档」背后就是这一个函数）
    const verManual = await b.captureChapterVersion(verCh.id, { source: 'manual' })

    // ② AI 覆盖前。captureChapterVersion 读的是 store 里**此刻**的正文，所以
    //    顺序不能反：先捕获再覆盖，否则存下来的是新正文，那一版毫无价值。
    await b.setChapterContent(verCh.id, '第二版正文，AI 写的。')
    const verAi = await b.captureChapterVersion(verCh.id, {
      source: 'ai',
      generationRunId: 'run-1'
    })
    await b.persistChapter(verCh.id)

    out.versionCaptureOk =
      !!verManual &&
      verManual.source === 'manual' &&
      verManual.content === '第一版正文。' &&
      verManual.chapterTitle === '第一章' &&
      verManual.bookId === vBook.id &&
      verManual.wordCount === countWords('第一版正文。').total &&
      // 版本记录是**不可变**的：没有 updatedAt，合并不必比较「哪个更新」
      verManual.updatedAt === undefined &&
      !!verAi &&
      verAi.source === 'ai' &&
      verAi.generationRunId === 'run-1' &&
      verAi.content === '第二版正文，AI 写的。' &&
      // 纯组装：id 现生成，字数与来源照抄
      buildVersion({ bookId: 'b1', chapterId: 'c1', content: '一二三' }).wordCount === 3 &&
      !!buildVersion({ bookId: 'b1', chapterId: 'c1', content: '一二三' }).id &&
      verEmpty === null

    // ③ 回滚。恢复之前必须把**当前**正文也存一版（source: 'rollback'），
    //    否则回滚不可撤销 —— 点错一次就再也回不到刚才那一版。
    const restoredOnce = await b.restoreChapterVersion(verManual)
    // 取成字符串而不是持有那个响应式对象：store 里的章节是**活的**，
    // 第二次回滚就地改的就是同一个对象，留着引用会让这里读到后来的值。
    const liveAfterRestore = b.store.chapters.find((c) => c.id === verCh.id)?.content
    const persistedAfterRestore = (await db.getChapters(vBook.id)).find((c) => c.id === verCh.id)
    const rollbackV = (await listVersions(vBook.id)).find((v) => v.source === 'rollback')
    // 再恢复一次，回到「被覆盖的那一版」—— 回滚自己也是可回滚的
    const restoredTwice = await b.restoreChapterVersion(rollbackV)
    const liveAfterUndo = b.store.chapters.find((c) => c.id === verCh.id)?.content

    out.versionRestoreOk =
      !!restoredOnce &&
      restoredOnce.id === verCh.id &&
      !!rollbackV &&
      rollbackV.content === '第二版正文，AI 写的。' &&
      liveAfterRestore === '第一版正文。' &&
      // 落库了才算数：只改内存的话，下一次会话看到的是旧正文
      persistedAfterRestore.content === '第一版正文。' &&
      persistedAfterRestore.wordCount === countWords('第一版正文。').total &&
      !!restoredTwice &&
      liveAfterUndo === '第二版正文，AI 写的。'

    // ④ 裁剪：每章最多留 versionKeep 版。先验纯函数的确定性
    //    （时间戳相同也要有确定结果，否则同一份数据两次裁剪会留下不同的那几条），
    //    再验真的落库那次裁剪**不写墓碑**。
    const mk = (id, chapterId, createdAt) => ({ id, chapterId, createdAt, content: id })
    const pruned = pruneVersions(
      [
        mk('a', 'c1', 1000),
        mk('b', 'c1', 4000),
        mk('c', 'c1', 2000),
        mk('d', 'c1', 3000),
        mk('e', 'c2', 500)
      ],
      3
    )
    const pruneCh = await b.addChapterWithContent('待裁剪。', '裁剪章')
    for (let i = 0; i < 4; i++) {
      await captureVersion({
        bookId: vBook.id,
        chapterId: pruneCh.id,
        chapterTitle: '裁剪章',
        content: `第 ${i} 版。`,
        source: 'manual',
        keep: 2,
        createdAt: 1700000000000 + i * 1000
      })
    }
    const prunedNow = (await db.coll.chapterVersions.getAll(vBook.id)).filter(
      (v) => v.chapterId === pruneCh.id
    )
    out.versionPruneOk =
      // c1 保留最新三版，c2 只有一条、整组留下；返回**保持入参顺序**，
      // 顺序变化会让 diffSnapshots 把没变过的记录也报成「有更新」
      pruned.map((v) => v.id).join(',') === 'b,c,d,e' &&
      // 时间戳打平时按 id 兜底排序，结果才是确定的
      pruneVersions([mk('x1', 'c3', 7000), mk('x2', 'c3', 7000)], 1)[0].id === 'x2' &&
      // keep 非法（负数）时兜到 1，不能变成「一条都不留」——
      // 设置里填错一个数就把全部历史抹掉，是没法原谅的失败方向
      pruneVersions([mk('y1', 'c4', 1), mk('y2', 'c4', 2)], -5).length === 1 &&
      DEFAULT_VERSION_KEEP === 10 &&
      prunedNow.length === 2 &&
      prunedNow.some((v) => v.content === '第 2 版。') &&
      prunedNow.some((v) => v.content === '第 3 版。') &&
      // 裁剪**没有**写墓碑：裁剪是本地整理，不是用户删除。写墓碑会让它传播到
      // 另一台设备、把对方故意保留的更多版本也删掉，而且墓碑表会无限膨胀。
      (await db.rawGet('tombstones:' + vBook.id)) === undefined

    // ⑤ 删章前自动存一版 —— 这是**误删救回的唯一入口**：章节走的是硬删除，
    //    数组里直接没了，版本是它留下的最后痕迹。
    const doomed = await b.addChapterWithContent('会被删掉的正文。', '要删的章')
    await b.removeChapter(doomed.id)
    const deleteVer = (await listVersions(vBook.id)).find((v) => v.source === 'delete')
    const chAfterDelete = await db.getChapters(vBook.id)
    const recovered = await b.restoreChapterVersion(deleteVer)
    const chAfterRecover = await db.getChapters(vBook.id)

    out.versionDeleteRecoverOk =
      !!deleteVer &&
      deleteVer.content === '会被删掉的正文。' &&
      deleteVer.chapterId === doomed.id &&
      // 章节真的没了（硬删除），而版本还在
      !chAfterDelete.some((c) => c.id === doomed.id) &&
      // 恢复出来的是一条**新**章节：原 id 已经进了墓碑，复用它是自找麻烦
      !!recovered &&
      recovered.id !== doomed.id &&
      recovered.title === '要删的章' &&
      recovered.content === '会被删掉的正文。' &&
      chAfterRecover.some((c) => c.id === recovered.id && c.content === '会被删掉的正文。')

    // ⑥ 分组：删掉的章节不能丢 —— 它们正是误删救回的入口，界面上单独一组
    //    （alive: false）并排在活章节之后。
    const verGroups = groupVersions(await listVersions(vBook.id), { chapters: b.store.chapters })
    const deadGroup = verGroups.find((g) => g.chapterId === doomed.id)
    out.versionGroupOk =
      !!deadGroup &&
      deadGroup.alive === false &&
      // 章节没了，标题只能取自版本自己记着的那一份
      deadGroup.chapterTitle === '要删的章' &&
      verGroups[verGroups.length - 1].chapterId === doomed.id &&
      verGroups.filter((g) => g.alive).every((g) => typeof g.order === 'number') &&
      // 与当前正文的字数差，给「比现在少 1,204 字」这种提示用
      versionDelta({ content: '一二三' }, '一二三四五').delta === 2 &&
      versionDelta({ content: '一二三' }, null).delta === null

    // ⑦ 版本随快照进出：COLLECTIONS 里加一行，它就自动进了全量备份与设备同步。
    const verList = await listVersions(vBook.id)
    const vSnap = await collectSnapshot()
    const vRound = await applySnapshot(parseSnapshotJson(toSnapshotJson(vSnap)))
    out.versionSyncOk =
      verList.length >= 5 &&
      (vSnap.data[vBook.id]?.chapterVersions || []).length === verList.length &&
      // 恢复一份刚导出的备份必须是 no-op：diff 里任何一项非零都说明有个键
      // 没能往返（版本记录不可变，合并靠 createdAt 回退，正是这里的考点）
      vRound.stats.added === 0 &&
      vRound.stats.updated === 0 &&
      vRound.stats.removed === 0 &&
      (await db.coll.chapterVersions.getAll(vBook.id)).length === verList.length

    await b.removeBook(vBook.id)

    // ------------------------------------------------------------------
    // N3) 时间线：两种排序的确定性 + 断链与逾期识别
    //
    // 全部喂**手写的纯数据**，不建书、不落库：buildTimeline 是纯函数，用真实
    // 库只会把「正文没落盘被整组回写盖掉」那类存储坑混进来，让这个断言在真正
    // 要考的排序问题上给出假失败。
    // ------------------------------------------------------------------
    const tlChapters = [
      { id: 'ch1', order: 1, title: '第一章' },
      { id: 'ch2', order: 2, title: '第二章' },
      { id: 'ch3', order: 3, title: '第三章', status: 'done' }
    ]
    const tlEvents = [
      { id: 'e1', title: '甲', chapterId: 'ch1', time: '2月' },
      { id: 'e2', title: '乙', chapterId: 'ch2', time: '3月' },
      { id: 'e3', title: '丙', chapterId: 'ch3', time: '4月' },
      // 没归章的、没填时间的、指向已删章节的 —— 轴必须把它们摆在一个**确定**
      // 的位置上，不能靠「碰巧渲染成这样」
      { id: 'e0', title: '无章', time: '1月' },
      { id: 'en', title: '无时间', chapterId: 'ch1' },
      { id: 'eo', title: '断链之事件', chapterId: 'ghost', characterIds: ['gone'] }
    ]
    const tlFores = [
      {
        id: 'f1',
        title: '埋下的伏笔',
        content: '埋了',
        status: 'planted',
        firstChapterId: 'ch1',
        expectedRevealChapterId: 'ch3'
      }
    ]
    const tlArgs = {
      chapters: tlChapters,
      events: tlEvents,
      foreshadowing: tlFores,
      locations: [],
      characters: [],
      factions: [],
      worldRules: [],
      volumes: [],
      arcs: []
    }

    const tlChap = buildTimeline({ ...tlArgs, sortBy: 'chapter' })
    const tlTime = buildTimeline({ ...tlArgs, sortBy: 'time' })

    const chapOrders = tlChap.nodes.map((n) => n.chapterOrder)
    // 同一章内的节点必须**相邻**：按章节分段是这条轴的全部意义，交错开就没人
    // 读得出「这一章究竟发生了什么」
    const tlGroupIds = (r, o) =>
      r.nodes
        .filter((n) => n.chapterOrder === o)
        .map((n) => n.id)
        .sort()
    out.timelineOrderOk =
      // 8 条 = 6 个事件 + 伏笔的埋点与回收点各一条（一条伏笔上轴两次是刻意的）
      tlChap.nodes.length === 8 &&
      // 主轴是章节号：单调不减，没有章节的一律排到最后
      chapOrders.every((o, i) => i === 0 || (chapOrders[i - 1] ?? Infinity) <= (o ?? Infinity)) &&
      chapOrders.slice(-2).every((o) => o === null) &&
      tlGroupIds(tlChap, 1).join(',') === 'event:e1,event:en,plant:f1' &&
      tlGroupIds(tlChap, 2).join(',') === 'event:e2' &&
      tlGroupIds(tlChap, 3).join(',') === 'event:e3,reveal:f1' &&
      // 按故事内时间：1月→2月→3月→4月，没填时间的一律沉到最后。
      // 注意末位是 eo —— 它是**章节已删除**，时间与章节号都无从判断，
      // 所以排在 e0 后面。这个次序是 cmp 里两次回退的结果，不是巧合。
      tlTime.nodes.map((n) => n.entityId).join(',') === 'e0,e1,e2,e3,en,f1,f1,eo'

    const eoNode = tlChap.nodes.find((n) => n.id === 'event:eo')
    out.timelineWarnOk =
      // 章节没了 → 节点自己是 orphan（轴上画虚线），而不是无声地消失
      eoNode.orphan === true &&
      tlChap.nodes.find((n) => n.id === 'event:e1').orphan === false &&
      // 引用已删人物 → 详情里能看见「谁，在哪，断了」
      eoNode.refs.some((r) => r.field === 'characterIds' && r.ok === false && r.name === '（已删除）') &&
      // 断链逐条可定位：同一事件的章节与人物两处都要报出来。只说「有 2 处断链」
      // 的报告是没法用的 —— 用户没有任何办法找到它们
      tlChap.warnings.some((w) => w.sourceId === 'eo' && w.field === 'chapterId') &&
      tlChap.warnings.some((w) => w.sourceId === 'eo' && w.field === 'characterIds') &&
      tlChap.warnings.every((w) => !!w.message && !!w.fieldLabel && !!w.targetType) &&
      // 逾期：说好回收的那一章 status 已是 done，伏笔却还停在 planted。
      // 埋点与回收点**都**标 overdue —— 作者是在轴上找「哪一条该收了」，
      // 只标其中一个会让另一半看起来是正常的
      tlChap.counts.overdue === 2 &&
      tlChap.nodes.filter((n) => n.overdue).every((n) => n.entityId === 'f1') &&
      // 汇总数字必须和 nodes 对得上，否则标签徽标与轴上的条数会各说各话
      tlChap.counts.events === 6 &&
      tlChap.counts.foreshadowing === 1 &&
      tlChap.counts.orphan === 1 &&
      // 同一份实现供两处使用：轴上的 warnings 与一致性规则 #1 必须是同一批，
      // 各写一份的话早晚一边报一边不报，而用户只能信其中一份
      findBrokenRefs(tlArgs).length === tlChap.warnings.length

    // 伏笔一旦回收，逾期就该消失 —— 这条是防误报的：一个「永远报逾期」的
    // 实现会让用户很快学会无视整张报告，比不报更糟
    const tlDone = buildTimeline({
      ...tlArgs,
      foreshadowing: [{ ...tlFores[0], status: 'revealed' }]
    })
    out.timelineOverdueClearsOk = tlDone.counts.overdue === 0

    // ------------------------------------------------------------------
    // N4) 一致性：十二条规则各造一个反例 + 干净数据必须 0 条
    //
    // 两个方向都要钉。只测「能报出来」的实现，可以在任何数据上都报警 ——
    // 那种报告用户看两次就再也不看了。consistencyCleanOk 才是这条功能的底线。
    // ------------------------------------------------------------------
    const dirtyChapters = [
      // 规则 8：主线标记停在 k2，后面又写了 30 章
      { id: 'k1', order: 1, title: '一', timelineStart: '5月', summary: '有', content: '正文', threads: '主线', arcId: 'arc1', purpose: '调查药庐的秘密' },
      { id: 'k2', order: 2, title: '二', timelineStart: '2月', summary: '有', content: '正文', threads: '主线', purpose: '调查药庐的秘密。' },
      { id: 'k3', order: 3, title: '三', summary: '有', content: '正文', status: 'done' },
      // 规则 12：连续两章已确认施工卡、且没有任何有效变化
      { id: 'k4', order: 4, title: '四', summary: '有', content: '正文', planStatus: 'confirmed', coreConflict: '等待' },
      { id: 'k5', order: 5, title: '五', summary: '有', content: '正文', planStatus: 'confirmed', coreConflict: '继续等待' },
      // 补满最近 10 章的窗口，供规则 9 使用
      ...[6, 7, 8, 9].map((n) => ({
        id: 'k' + n,
        order: n,
        title: String(n),
        summary: '有',
        content: '正文'
      })),
      { id: 'k32', order: 32, title: '三十二', summary: '', content: '正文' }
    ]
    const dirty = {
      chapters: dirtyChapters,
      memory: {
        characters: [
          // 规则 2：已死亡，却在更靠后的章节里还有戏
          { id: 'z1', name: '已死者', status: 'dead', lastUpdatedChapterId: 'k1' },
          // 规则 7：活着，但 31 章没更新过
          { id: 'z2', name: '久未出场', status: 'alive', lastUpdatedChapterId: 'k1' },
          // 规则 1：指向一个已被删掉的地点；规则 9：窗口内出场 8 章
          { id: 'z3', name: '断链人物', status: 'alive', currentLocationId: 'gone' }
        ],
        events: [
          { id: 'q1', title: '唯一事件', chapterId: 'k3', characterIds: ['z1'] },
          // 规则 5：同一章里两条同名
          { id: 'q2', title: '重复事件', chapterId: 'k2' },
          { id: 'q3', title: '重复事件', chapterId: 'k2' },
          // 规则 9 的 8 个不同章节（避开 k4/k5，否则规则 12 会被事件化解）
          ...[1, 2, 3, 6, 7, 8, 9, 32].map((n, i) => ({
            id: 'dense' + i,
            title: '密集事件' + i,
            chapterId: n === 32 ? 'k32' : 'k' + n,
            characterIds: ['z3']
          }))
        ],
        foreshadowing: [
          // 规则 4：说好回收的那一章已经写完，状态还停在已埋下
          { id: 'v1', title: '逾期伏笔', content: 'x', status: 'planted', expectedRevealChapterId: 'k3' }
        ],
        locations: [],
        factions: [],
        worldRules: []
      },
      // 规则 10：进行中的篇停在 k1
      structure: { volumes: [], arcs: [{ id: 'arc1', title: '药庐疑云', status: 'active' }] },
      tombstones: [{ id: 'gone', type: 'locations', deletedAt: 1700000000000 }]
    }
    const dirtyRes = runRuleChecks(dirty)
    const per = dirtyRes.stats.byRule
    out.consistencyRuleOk =
      // 十二条各命中**恰好一次**：多一次就说明这条规则在自己的反例之外还会误伤，
      // 那正是「报告变得没人看」的起点
      CONSISTENCY_RULES.length === 12 &&
      CONSISTENCY_RULES.every((r) => per[r.id] === 1) &&
      dirtyRes.stats.total === 12 &&
      // 严重度不能全一个样，否则报告就没法用来排优先级
      dirtyRes.stats.bySeverity.high === 2 &&
      dirtyRes.stats.bySeverity.medium === 3 &&
      dirtyRes.stats.bySeverity.low === 7 &&
      // 高的排前面
      dirtyRes.issues[0].severity === 'high' &&
      // 每条都带得动跳转所需的定位信息
      dirtyRes.issues.every((i) => !!i.id && !!i.rule && !!i.title && !!i.entityType) &&
      // 「故事内时间」判据：同一单位才比（1月 vs 2月 可比，三年前 vs 1月 不可比）
      timeKey('1月').n === 1 &&
      timeKey('1月').unit === '月' &&
      timeKey('第七天夜里').n === 7 &&
      timeKey('三年前').n === 3 &&
      timeKey('三年前').unit === '年前' &&
      timeKey('很久以前') === null

    // 干净数据必须一条都不报。这是全项目最容易被忽略、也最值钱的一条断言。
    const clean = {
      chapters: [
        { id: 'm1', order: 1, title: '一', timelineStart: '1月', summary: '有', content: '正文' },
        { id: 'm2', order: 2, title: '二', timelineStart: '2月', summary: '有', content: '正文' }
      ],
      memory: {
        characters: [{ id: 'y1', name: '林昭', status: 'alive', lastUpdatedChapterId: 'm2' }],
        events: [{ id: 'p1', title: '甲', chapterId: 'm1', characterIds: ['y1'] }],
        foreshadowing: [{ id: 'u1', title: '伏笔', content: 'x', status: 'planted', expectedRevealChapterId: 'm2' }],
        locations: [],
        factions: [],
        worldRules: []
      },
      structure: { volumes: [], arcs: [] },
      tombstones: []
    }
    const cleanRes = runRuleChecks(clean)
    out.consistencyCleanOk =
      cleanRes.stats.total === 0 &&
      cleanRes.issues.length === 0 &&
      // entities 只数 schema 里的实体，不把章节算进去（与 snapshotStats 同一条口径）
      cleanRes.stats.entities === 3 &&
      cleanRes.stats.chapters === 2

    // 空书也不能炸 —— 打开一本刚建的空书时走的就是这条路
    const emptyRes = runRuleChecks()
    out.consistencyEmptyOk = emptyRes.stats.total === 0 && emptyRes.stats.chapters === 0

    // --- AI 深检：review 阶段端到端（假 chat） --------------------------------
    // 与 L 节那个 fakeChat 同形但独立一份：L 节的声明在下面，这里引用会撞 TDZ。
    const reviewMsgs = []
    const reviewChat = (text) => (opts) => {
      reviewMsgs.push(opts.messages)
      setTimeout(() => {
        opts.callbacks.onDelta?.(text)
        opts.callbacks.onUsage?.({ inputTokens: 800, outputTokens: 120 })
        opts.callbacks.onDone?.()
      }, 0)
      return { abort: () => {} }
    }

    const rBook = await b.createBook({ title: '测试小说', intro: '一致性审校' })
    const rChapter = await b.addChapterWithContent('林昭推开门，苏九正在碾药。', '第一章')
    const genS = useGeneration()
    // 新契约（规范 §9.2）：单一 issues 数组，每条自带 category 与证据字段。
    // 旧的三个数组仍由 flattenReviewReport 兼容，但提示词已经只要求这一种。
    const reviewPayload = JSON.stringify({
      issues: [
        {
          category: 'setting',
          severity: 'high',
          title: '苏九已死却出场',
          quote: '苏九正在碾药',
          location: '第 1 段',
          explanation: '第 1 章之后她仍出现',
          evidence: '第 1 章人物状态：死亡',
          falsePositiveHint: '若是回忆或幻觉则不算问题',
          suggestion: '删掉这一句'
        },
        {
          category: 'continuity',
          severity: 'medium',
          title: '时间跳跃无过渡',
          quote: '推开门',
          explanation: '从夜里直接到清晨',
          evidence: '',
          falsePositiveHint: '',
          suggestion: '补一句天色转亮'
        }
      ],
      severity: 'high'
    })
    const rwf = await runChapterWorkflow({
      input: {
        book: rBook,
        bookId: rBook.id,
        chapter: rChapter,
        chapters: [rChapter],
        outlines: [],
        memory: { characters: [], locations: [], factions: [], worldRules: [], events: [], foreshadowing: [] },
        structure: { volumes: [], arcs: [] },
        settings: s.settings,
        action: 'review',
        text: rChapter.content
      },
      settings: s.settings,
      stages: ['review'],
      chat: reviewChat(reviewPayload),
      recordRun: genS.recordRun
    })
    const reviewRec = genS.store.runs.find((r) => r.stage === 'review')
    const reviewSent = (reviewMsgs[0] || []).map((m) => m.content).join('\n')
    out.consistencyReviewOk =
      STAGE_LABELS.review === '一致性审校' &&
      // 审校**不在**默认档里：它不是每章都要跑的东西，塞进去等于替用户决定
      // 「每写一章都多付一次钱」
      !DEFAULT_STAGES.includes('review') &&
      // 输出契约逐字采用规格书 04 / §9.2
      !!rwf.reviewReport &&
      rwf.reviewReport.severity === 'high' &&
      rwf.reviewReport.issues.length === 2 &&
      rwf.reviewReport.issues[0].category === 'setting' &&
      rwf.reviewReport.issues[0].falsePositiveHint.includes('回忆') &&
      // 压平后的问题带确定性 id、类别与正文指纹（状态落库靠这三样对齐）
      (() => {
        const flat = flattenReviewReport(rwf.reviewReport, {
          chapterId: rChapter.id,
          content: rChapter.content
        })
        return (
          flat.length === 2 &&
          flat.every((i) => i.id.startsWith('ri_') && i.contentHash === contentHashOf(rChapter.content)) &&
          flat.map((i) => i.category).sort().join(',') === 'continuity,setting'
        )
      })() &&
      rwf.run.stages.length === 1 &&
      rwf.run.stages[0].id === 'review' &&
      rwf.run.stages[0].status === 'done' &&
      // 手动触发也必须是**可见花费**：这次调用在生成历史里有一条记录
      !!reviewRec &&
      reviewRec.action === 'review' &&
      reviewRec.inputTokens === 800 &&
      reviewRec.outputTokens === 120 &&
      reviewRec.chapterId === rChapter.id &&
      // 必经 Context Builder：设定层在提示词里（这份数据里人物为空，
      // 于是换成断言「写作硬规则」那段 system 提示确实带上了）
      reviewSent.includes('直接输出正文') &&
      // 整章正文单独给一条消息 —— context 里的正文层只保留尾部，
      // 拿它审校等于只审了后半章
      reviewSent.includes('【待审校正文】') &&
      reviewSent.includes('苏九正在碾药') &&
      // 提示词要求的是新契约字段，不是旧的三个数组
      reviewSent.includes('"falsePositiveHint"') &&
      reviewSent.includes('category：setting')

    // 报告**不落库**；落库的只有「用户对这些问题的决定」。
    // 这一组直接走渲染进程的真实 IndexedDB，覆盖 reviewIssueStates 的读写。
    const flatIssues = flattenReviewReport(rwf.reviewReport, {
      chapterId: rChapter.id,
      content: rChapter.content
    })
    const saved = await saveIssueStates(rBook.id, flatIssues, { reportRunId: reviewRec.id })
    const ignored = await setIssueStatus(rBook.id, flatIssues[0], 'ignored')
    // 同一批问题再登记一次，不能把「已忽略」重置回「待处理」——
    // 否则忽略按钮每深检一次就白点一次。
    await saveIssueStates(rBook.id, flatIssues, { reportRunId: reviewRec.id })
    const afterResave = await db.coll.reviewIssueStates.getAll(rBook.id)
    const savedFirst = afterResave.find((x) => x.id === flatIssues[0].id)
    out.consistencyReviewNoPersistOk =
      // 这次审校只写了**一条**记录（计费那条），报告本身没有变成任何持久对象
      (await db.coll.generationRuns.getAll(rBook.id)).length === 1 &&
      (await db.rawGet('consistencyReports:' + rBook.id)) === undefined &&
      saved.length === 2 &&
      afterResave.length === 2 &&
      ignored?.status === 'ignored' &&
      savedFirst?.status === 'ignored' &&
      // 状态绑的是审校时那一版正文；正文一改就该显示为「报告已过期」
      isIssueStale(savedFirst, rChapter.content) === false &&
      isIssueStale(savedFirst, rChapter.content + '（改过）') === true

    // ------------------------------------------------------------------
    // N5) 阶段 4：施工卡、计划提案、上下文注入、版本差异、修复草案
    //
    // 这一节的重点是两条「不许自动写」：AI 计划与 AI 修复都只能产出草案，
    // 章节数据在用户点「接受」之前一个字都不能变。
    // ------------------------------------------------------------------
    const draftCard = await b.saveChapterPlan(rChapter.id, {
      arcId: 'a1',
      coreConflict: '夺回灵石',
      mustEvents: '林昭必须活下来',
      forbidden: '苏九正在碾药',
      lockedBeats: '林昭必须活下来',
      targetWords: 100
    })
    // updateChapter 返回的是 store 里的**同一对象**，第二次保存会就地改写它。
    // 所以草稿态的值必须在确认之前取下来，否则断言看到的是最终状态。
    const draftStatus = draftCard?.planStatus
    const draftVersion = draftCard?.planVersion
    const confirmedCard = await b.saveChapterPlan(
      rChapter.id,
      { arcId: 'a1', coreConflict: '夺回灵石', mustEvents: '林昭必须活下来', forbidden: '苏九正在碾药', lockedBeats: '林昭必须活下来', targetWords: 100 },
      { confirm: true }
    )
    const cardCheck = checkChapterPlan(confirmedCard, confirmedCard.content)
    const cardCtx = buildContext(
      {
        book: rBook,
        chapter: confirmedCard,
        chapters: [confirmedCard],
        outlines: [],
        memory: { characters: [] },
        structure: {
          volumes: [{ id: 'v1', title: '第一卷' }],
          arcs: [{ id: 'a1', title: '药庐篇', volumeId: 'v1' }],
          scenes: [{ id: 'sc1', chapterId: rChapter.id, title: '入屋', order: 1, purpose: '试探' }]
        },
        settings: s.settings,
        action: 'chapter'
      },
      6000
    )
    const layerIds = cardCtx.metadata.layers.map((l) => l.id)
    out.planCardOk =
      draftStatus === 'draft' &&
      (draftVersion ?? 0) === 0 &&
      confirmedCard.planStatus === 'confirmed' &&
      confirmedCard.planVersion === 1 &&
      // 施工卡 13 项里填了 4 项（锁定节点不算进 13 项里的完成度）
      planCompleteness(confirmedCard).filled === 4 &&
      // 禁发内容命中必须是 high；必发事件没写是 low
      cardCheck.issues.some((i) => i.field === 'forbidden' && i.severity === 'high') &&
      cardCheck.issues.some((i) => i.field === 'mustEvents' && i.severity === 'low') &&
      // 卷 / 篇 / 施工卡 / 场景四层都进了提示词
      layerIds.includes('volume') &&
      layerIds.includes('arc') &&
      layerIds.includes('chapterCard') &&
      layerIds.includes('scenes') &&
      cardCtx.context.includes('第一卷') &&
      cardCtx.context.includes('药庐篇') &&
      cardCtx.context.includes('施工卡（已确认 v1）') &&
      !cardCtx.context.includes('临时计划（尚未确认）') &&
      cardCtx.context.includes('入屋')

    // 锁定节点被 AI 草稿触碰时必须出提案，而不是直接改施工卡
    const planProposal = buildPlanProposal({
      bookId: rBook.id,
      chapterId: rChapter.id,
      current: confirmedCard,
      proposed: { coreConflict: '苏九杀了林昭', mustEvents: '主角死亡' }
    })
    out.planProposalOk =
      !!planProposal &&
      planProposal.status === 'pending' &&
      planProposal.missingBeats.includes('林昭必须活下来') &&
      planProposal.previous.coreConflict === '夺回灵石' &&
      missingLockedBeats(confirmedCard, '林昭必须活下来').length === 0 &&
      // 提案只是数据，不会自己进章节
      b.store.chapters.find((c) => c.id === rChapter.id).planStatus === 'confirmed'

    // 版本差异：等 / 增 / 删、中文长行按句切、折叠后保留变化上下文
    const diffRes = diffText('第一行\n第二行', '第一行\n改写')
    const cjkLine = '甲'.repeat(60) + '。' + '乙'.repeat(60) + '！'
    out.diffOk =
      diffRes.stats.added === 1 &&
      diffRes.stats.removed === 1 &&
      diffRes.stats.unchanged === 1 &&
      diffRes.lines.some((r) => r.type === 'del' && r.text === '第二行') &&
      collapsedDiff(diffRes.lines, 0).some((r) => r.type === 'add') &&
      splitSentences(cjkLine).length === 2

    // AI 计划：只出草案，章节施工卡一个字段都不许变
    const planMsgs = []
    const planChat = (text) => (opts) => {
      planMsgs.push(opts.messages)
      setTimeout(() => {
        opts.callbacks.onDelta?.(text)
        opts.callbacks.onUsage?.({ inputTokens: 300, outputTokens: 80 })
        opts.callbacks.onDone?.()
      }, 0)
      return { abort: () => {} }
    }
    const planWf = await runChapterWorkflow({
      input: {
        book: rBook,
        bookId: rBook.id,
        chapter: confirmedCard,
        chapters: [confirmedCard],
        outlines: [],
        memory: { characters: [], locations: [], factions: [], worldRules: [], events: [], foreshadowing: [] },
        structure: { volumes: [], arcs: [] },
        settings: s.settings,
        action: 'plan'
      },
      settings: s.settings,
      stages: ['plan'],
      chat: planChat(
        JSON.stringify({ coreConflict: '闯进密道', mustEvents: '发现密道', targetWords: 1800 })
      ),
      recordRun: genS.recordRun
    })
    const planSent = (planMsgs[0] || []).map((m) => m.content).join('\n')
    out.planAiDraftOk =
      planWf.planDraft?.coreConflict === '闯进密道' &&
      planWf.planDraft?.targetWords === 1800 &&
      // 提示词把锁定节点原样交给模型，并要求「不得删改或绕开」
      planSent.includes('林昭必须活下来') &&
      planSent.includes('不得删改或绕开') &&
      // 草案没有进章节：coreConflict 仍是作者确认过的那一份
      b.store.chapters.find((c) => c.id === rChapter.id).coreConflict === '夺回灵石'

    // V4 阶段 3：生成前计划校验接进 plan 阶段。
    // 这份草案安排记忆里已死亡的「苏九」出场：校验必须报 high、标 blocked，
    // 但**草案本身照常返回** —— 校验不是阶段失败，用户仍能看到并决定要不要用。
    const pvChat = (text) => (opts) => {
      setTimeout(() => {
        opts.callbacks.onDelta?.(text)
        opts.callbacks.onUsage?.({ inputTokens: 300, outputTokens: 60 })
        opts.callbacks.onDone?.()
      }, 0)
      return { abort: () => {} }
    }
    const pvWf = await runChapterWorkflow({
      input: {
        book: rBook,
        bookId: rBook.id,
        chapter: { ...confirmedCard, order: 3 },
        chapters: [confirmedCard],
        outlines: [],
        memory: {
          characters: [{ id: 'pv-dead', name: '苏九', status: 'dead' }],
          locations: [],
          factions: [],
          worldRules: [],
          events: [],
          foreshadowing: []
        },
        structure: { volumes: [], arcs: [] },
        settings: s.settings,
        action: 'plan'
      },
      settings: s.settings,
      stages: ['plan'],
      chat: pvChat(
        JSON.stringify({ coreConflict: '苏九回到药庐', mustEvents: '苏九推开木窗' })
      ),
      recordRun: genS.recordRun
    })
    const pvDeadIssue = (pvWf.planValidation?.issues || []).find(
      (i) => i.category === 'dead-character'
    )
    out.planValidateWiredIntoStagePlanOk =
      pvWf.run.status === 'done' &&
      pvWf.planDraft?.coreConflict === '苏九回到药庐' &&
      pvWf.planBlocked === true &&
      pvWf.run.stages[0].blocked === true &&
      pvWf.run.stages[0].validation?.blocking === true &&
      pvDeadIssue?.severity === 'high' &&
      pvDeadIssue?.field === 'coreConflict' &&
      (pvDeadIssue?.evidence || '').includes('苏九')

    // 阻断的语义：只拦「自动采用 / 队列自动继续」，作者永远可以显式放行。
    out.planValidateBlockSaveOk =
      shouldBlockPlan(pvWf.planValidation, { blockHigh: true }) === true &&
      shouldBlockPlan(pvWf.planValidation, { blockHigh: false }) === false &&
      validationSummary(pvWf.planValidation, 1000, {}).overridden === false

    // 放行后保存：字段落库，摘要留下「这次是作者作主」。摘要只存判断与问题 id，
    // 完整报告不落库（正文一改就过期）。
    const pvSaveRes = await b.saveChapterPlan(rChapter.id, {
      ...pvWf.planDraft,
      planValidation: validationSummary(pvWf.planValidation, 1000, { overridden: true })
    })
    const pvStored = (await db.getChapters(rBook.id)).find((c) => c.id === rChapter.id)
    out.planValidateOverrideSavesOk =
      !!pvSaveRes &&
      pvSaveRes.coreConflict === '苏九回到药庐' &&
      pvStored.coreConflict === '苏九回到药庐' &&
      pvStored.planValidation?.overridden === true &&
      pvStored.planValidation?.high === 1 &&
      // 放行只影响这一次保存，不改变「校验确实拦过」的事实
      pvStored.planValidation?.blocking === true &&
      !('issues' in (pvStored.planValidation || {}))

    // ------------------------------------------------------------------
    // V4 阶段 4：持久化写作队列
    //
    // 这一节不打网络：runItem 是注入的。要验证的是队列自己的账 ——
    // 串行、失败即停并保留已收到的文本、**不自动改正文**、生成中挡住同步。
    // ------------------------------------------------------------------
    const queue = useWritingQueue()
    await db.saveQueueState({ paused: false })
    await queue.loadForBook(rBook.id)
    const contentBeforeQueue = b.store.chapters.find((c) => c.id === rChapter.id).content
    const chaptersBeforeQueue = b.store.chapters.length

    const enq1 = await queue.enqueue({ chapterId: rChapter.id })
    const enqDup = await queue.enqueue({ chapterId: rChapter.id })
    const storedQueue = await db.coll.generationQueue.getAll(rBook.id)
    const snapHasQueue = JSON.stringify(await collectSnapshot()).includes('generationQueue')
    out.queueEnqueuePersistOk =
      enq1.ok &&
      enq1.item?.status === 'queued' &&
      // 同一章重复入队会让同一次调用花两遍钱，必须挡住
      enqDup.ok === false &&
      enqDup.existing === true &&
      storedQueue.length === 1 &&
      storedQueue[0].chapterId === rChapter.id &&
      // 队列是设备本地态：绝不进全量备份 / 设备同步
      LOCAL_ONLY_COLLECTIONS.includes('generationQueue') &&
      snapHasQueue === false

    // 第二章用于验证「一次只跑一项」
    const qc2 = await b.addChapterWithContent('第二章原有的正文。', '第二章')
    await queue.enqueue({ chapterId: qc2.id })

    const runOrder = []
    let releaseGate
    const queueGate = new Promise((r) => {
      releaseGate = r
    })
    const startRes = await queue.start({
      runItem: async (it) => {
        runOrder.push(it.chapterId)
        if (runOrder.length === 1) await queueGate
        return {
          status: 'done',
          result: {
            text: '队列草稿-' + it.chapterId,
            runId: 'qrun-' + it.chapterId,
            usage: { inputTokens: 10, outputTokens: 20, cost: 0 }
          }
        }
      }
    })
    const waitQueue = async (fn, ms = 4000) => {
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        if (fn()) return true
        await new Promise((r) => setTimeout(r, 25))
      }
      return false
    }
    await waitQueue(() => queueStore.running && queueStore.activeId === enq1.item.id)
    // 队列运行期间，局域网同步必须被挡在合并之前：整组回写会覆盖正在写的正文。
    const busyWhileQueue = await handleIncomingSnapshot({}, {})
    out.queueBlocksSyncOk =
      busyWhileQueue.ok === false &&
      busyWhileQueue.busy === true &&
      busyWhileQueue.message.includes('正在生成')
    releaseGate()
    await waitQueue(() => !queueStore.running)

    const qDone = queueStore.items.filter((x) => x.status === 'done')
    out.queueSerialRunOk =
      startRes.ok === true &&
      runOrder.length === 2 &&
      runOrder[0] === rChapter.id &&
      runOrder[1] === qc2.id &&
      qDone.length === 2 &&
      qDone.every((x) => x.result?.text && !x.result.appliedAt) &&
      queueStore.paused === false

    // 关键断言：跑完两章，正文与章节数一个字都没动。
    const ch1AfterQueue = (await db.getChapters(rBook.id)).find((c) => c.id === rChapter.id)
    const ch2AfterQueue = (await db.getChapters(rBook.id)).find((c) => c.id === qc2.id)
    out.queueNoAutoWriteOk =
      ch1AfterQueue.content === contentBeforeQueue &&
      ch2AfterQueue.content === '第二章原有的正文。' &&
      b.store.chapters.length === chaptersBeforeQueue + 1

    // 应用草稿：先存版本、再追加正文；队列里的正文副本要清掉。
    const qItem1 = queueStore.items.find((x) => x.chapterId === rChapter.id)
    const prevAutoExtract = s.settings.autoExtractMemory
    s.settings.autoExtractMemory = false
    const applyRes = await queue.applyResult(qItem1.id, { mode: 'insert' })
    s.settings.autoExtractMemory = prevAutoExtract
    const afterInsert = (await db.getChapters(rBook.id)).find((c) => c.id === rChapter.id)
    const qVersions = await b.loadVersions()
    const appliedItem = queueStore.items.find((x) => x.id === qItem1.id)
    out.queueResultInsertOk =
      applyRes.ok === true &&
      applyRes.chapterId === rChapter.id &&
      afterInsert.content.startsWith(contentBeforeQueue) &&
      afterInsert.content.includes('队列草稿-' + rChapter.id) &&
      // 插入前先存了版本，所以这一步可回滚
      qVersions.some(
        (v) => v.source === 'ai' && v.chapterId === rChapter.id && v.content === contentBeforeQueue
      ) &&
      appliedItem.result?.appliedMode === 'insert' &&
      appliedItem.result?.text === ''

    // 失败即停：保留已收到的半章，后续条目不跑，队列自动暂停。
    const qc3 = await b.addChapterWithContent('第三章原有的正文。', '第三章')
    const qc4 = await b.addChapterWithContent('第四章原有的正文。', '第四章')
    await queue.enqueue({ chapterId: qc3.id })
    await queue.enqueue({ chapterId: qc4.id })
    const failOrder = []
    await queue.start({
      runItem: async (it) => {
        failOrder.push(it.chapterId)
        if (it.chapterId === qc3.id) {
          return { status: 'failed', error: '模拟失败：Key 无效', result: { text: '已经收到的一半草稿' } }
        }
        return { status: 'done', result: { text: '不该跑到这里' } }
      }
    })
    await waitQueue(() => failOrder.length > 0 && !queueStore.running)
    const failedItem = queueStore.items.find((x) => x.chapterId === qc3.id)
    const skippedItem = queueStore.items.find((x) => x.chapterId === qc4.id)
    const qc3After = (await db.getChapters(rBook.id)).find((c) => c.id === qc3.id)
    out.queueFailureKeepsTextOk =
      failOrder.length === 1 &&
      failOrder[0] === qc3.id &&
      failedItem?.status === 'failed' &&
      failedItem.error.includes('Key 无效') &&
      // 已收到的文本不丢：用户可能就想要这半章
      failedItem.result?.text === '已经收到的一半草稿' &&
      skippedItem?.status === 'queued' &&
      queueStore.paused === true &&
      qc3After.content === '第三章原有的正文。'

    // 重启恢复：running → interrupted，不自动重跑（重跑=再花一次钱）。
    const queueRec = recoverQueueItems(
      [{ id: 'recover-1', bookId: rBook.id, chapterId: rChapter.id, status: 'running' }],
      { now: 12345 }
    )
    out.queueRecoveryOk =
      queueRec.changed === true &&
      queueRec.items[0].status === 'interrupted' &&
      queueRec.items[0].error.includes('未自动重跑') &&
      queueRec.items[0].updatedAt === 12345

    // 收尾：不要在真实库里留下「暂停」这个全局标记
    await db.saveQueueState({ paused: false })
    queueStore.paused = false

    // ------------------------------------------------------------------
    // V4 阶段 5：本地哈希检索（RAG）
    //
    // 索引是设备本地派生数据：这里验证「建得起来、内容改了只重建那一章、
    // 章删了块也清掉、永不进快照」，以及上下文层只在有片段时出现。
    // ------------------------------------------------------------------
    const ragSettings = {
      rag: { enabled: true, topK: 6, minScore: 0.01, budget: 800, chunkChars: 200, overlapChars: 40 }
    }
    const ragCh1 = await b.addChapterWithContent(
      '林昭在药庐与苏九对峙，剑拔弩张。药庐外雨声渐急。',
      '检索一'
    )
    const ragCh2 = await b.addChapterWithContent(
      '飞船引擎过载，警报响彻舱室。没有人知道还能撑多久。',
      '检索二'
    )
    const ragFirst = await ensureBookIndex(rBook.id, b.store.chapters, ragSettings, {
      force: true,
      now: 5000
    })
    const ragRecs = await db.coll.ragChunks.getAll(rBook.id)
    const ragSnap = JSON.stringify(await collectSnapshot())
    out.ragIndexChapterOk =
      ragFirst.changed === true &&
      ragFirst.builtChapters >= 2 &&
      ragFirst.chunkCount === ragRecs.length &&
      ragFirst.chunkCount > 0 &&
      ragRecs.some((r) => r.chapterId === ragCh1.id) &&
      ragRecs.some((r) => r.chapterId === ragCh2.id) &&
      ragRecs.every((r) => r.vector?.dims === EMBEDDING_DIM && Object.keys(r.vector.counts).length > 0) &&
      // 设备本地态：绝不出现在全量备份 / 设备同步里
      LOCAL_ONLY_COLLECTIONS.includes('ragChunks') &&
      !ragSnap.includes('ragChunks')

    // 只改一章的正文：状态要如实报「过期」，重建只动这一章，另一章的块原样保留。
    const ragCh2Before = ragRecs.find((r) => r.chapterId === ragCh2.id)
    b.setChapterContent(ragCh1.id, '林昭在龙脊玉前停下脚步，苏九的名字被刻在背面。')
    await b.persistChapter(ragCh1.id)
    const ragStale = await getRagIndexStatus(rBook.id, b.store.chapters)
    const ragSecond = await ensureBookIndex(rBook.id, b.store.chapters, ragSettings, { now: 7777 })
    const ragRecs2 = await db.coll.ragChunks.getAll(rBook.id)
    const ragCh2After = ragRecs2.find((r) => r.chapterId === ragCh2.id)
    const ragCh1Recs = ragRecs2.filter((r) => r.chapterId === ragCh1.id)
    out.ragIncrementalReplaceOk =
      ragStale.staleChapters >= 1 &&
      ragSecond.changed === true &&
      ragSecond.builtChapters === 1 &&
      JSON.stringify(ragCh2Before) === JSON.stringify(ragCh2After) &&
      ragCh1Recs.length > 0 &&
      ragCh1Recs.every((r) => r.updatedAt === 7777) &&
      ragCh1Recs.some((r) => r.text.includes('龙脊玉'))

    // 删章之后，它的块必须一起消失 —— 否则检索会把「已删除章节」的原文
    // 当成历史片段注入，作者会在提示词里看到自己已经删掉的内容。
    await b.removeChapter(ragCh2.id)
    const ragThird = await ensureBookIndex(rBook.id, b.store.chapters, ragSettings, { now: 8888 })
    const ragRecs3 = await db.coll.ragChunks.getAll(rBook.id)
    out.ragDeleteChapterCleanupOk =
      ragThird.removedChapters >= 1 &&
      !ragRecs3.some((r) => r.chapterId === ragCh2.id) &&
      ragRecs3.some((r) => r.chapterId === ragCh1.id)

    // 上下文层：有片段才出现，且预算确实截断在 rag.budget 上。
    const ragCtx = buildContext(
      {
        book: { title: '测试' },
        chapter: { id: 'rag-now', order: 9, title: '当前章' },
        chapters: [{ id: 'rag-now', order: 9, title: '当前章' }],
        settings: { contextBudget: 4000, rag: { enabled: true, budget: 80 } },
        ragPassages: [
          {
            id: 'p1',
            chapterId: 'rag-old',
            chapterTitle: '旧事',
            chapterOrder: 2,
            text: '很久以前，林昭在药庐埋下了一枚铜钱，这件事没人记得。',
            score: 0.5
          }
        ]
      },
      2000
    )
    const ragLayer = ragCtx.metadata.layers.find((l) => l.id === 'ragPassages')
    // 极小预算：层必须被这一层的预算截断，而不是按全局预算一路吃下去
    const ragTinyCtx = buildContext(
      {
        book: { title: '测试' },
        chapter: { id: 'rag-now', order: 9, title: '当前章' },
        chapters: [{ id: 'rag-now', order: 9, title: '当前章' }],
        settings: { contextBudget: 4000, rag: { enabled: true, budget: 8 } },
        ragPassages: [
          {
            id: 'p1',
            chapterId: 'rag-old',
            chapterTitle: '旧事',
            chapterOrder: 2,
            text: '很久以前，林昭在药庐埋下了一枚铜钱，这件事没人记得。',
            score: 0.5
          }
        ]
      },
      2000
    )
    const ragTinyLayer = ragTinyCtx.metadata.layers.find((l) => l.id === 'ragPassages')
    out.ragLayerInContextOk =
      !!ragLayer &&
      ragLayer.label === '相关历史片段' &&
      ragLayer.tokens > 0 &&
      ragLayer.tokens <= 80 &&
      ragCtx.context.includes('相关历史片段') &&
      ragCtx.context.includes('铜钱') &&
      !!ragTinyLayer &&
      ragTinyLayer.tokens <= 8

    // 开关关着：retrieve 直接返回空数组（不读库、不建索引），上下文也不产生该层。
    const ragOffPassages = await retrieveRagContext(
      { bookId: rBook.id, chapter: b.store.chapters[0], chapters: b.store.chapters },
      { rag: { enabled: false } }
    )
    const ragOffCtx = buildContext(
      {
        book: { title: '测试' },
        chapter: { id: 'x', order: 1 },
        chapters: [{ id: 'x', order: 1 }],
        settings: { rag: { enabled: false, budget: 800 } }
      },
      2000
    )
    out.ragDisabledNoLayerOk =
      Array.isArray(ragOffPassages) &&
      ragOffPassages.length === 0 &&
      !ragOffCtx.metadata.layers.some((l) => l.id === 'ragPassages') &&
      !ragOffCtx.context.includes('相关历史片段')

    // 收尾：不把测试索引留在真实库里
    await clearBookIndex(rBook.id)

    // ---- V4 阶段 6：人物关系图（纯函数部分） ----
    // 组件那一段在控制台里用真实点击验证；这里验证派生的规则本身，
    // 尤其是「悬空引用丢弃」与「自由文本只认明确分隔符」——它们出错时
    // 界面上仍然画得出一张好看的图，只有断言能发现。
    {
      const gChars = [
        { id: 'g1', name: '林昭', currentFactionId: 'gf1' },
        { id: 'g2', name: '苏九', relationships: '林昭与苏九是同门' },
        { id: 'g3', name: '周野' }
      ]
      const gFactions = [{ id: 'gf1', name: '青云门', leaders: ['g1'] }]
      const g = buildRelationshipGraph({
        characters: gChars,
        factions: gFactions,
        events: [
          { id: 'ge1', characterIds: ['g1', 'g2', 'g3'] },
          { id: 'ge2', characterIds: ['g2', 'g1'] }
        ]
      })
      const edgeOf = (kind, a, b) =>
        g.edges.find(
          (e) =>
            e.kind === kind &&
            [e.source, e.target].sort().join('|') ===
              [`character:${a}`, `character:${b}`].sort().join('|')
        )
      out.graphCharacterNodesOk =
        g.stats.characters === 3 && g.stats.factions === 1 && g.stats.locations === 0
      out.graphFactionLeaderEdgeOk =
        !!g.edges.find(
          (e) => e.kind === 'leader' && e.source === 'faction:gf1' && e.target === 'character:g1'
        ) &&
        !!g.edges.find(
          (e) => e.kind === 'member' && e.source === 'character:g1' && e.target === 'faction:gf1'
        )
      out.graphEventCooccurrenceOk =
        edgeOf('cooccur', 'g1', 'g2')?.weight === 2 &&
        edgeOf('cooccur', 'g1', 'g3')?.weight === 1 &&
        edgeOf('cooccur', 'g2', 'g3')?.weight === 1
      out.graphTextRelationshipConservativeOk =
        parseRelationshipText('林昭与苏九是同门', gChars).length === 1 &&
        parseRelationshipText('林昭想起苏九曾说过的话', gChars).length === 0 &&
        parseRelationshipText('林昭独自离开', gChars).length === 0 &&
        !!edgeOf('relation', 'g1', 'g2')
      const dangling = buildRelationshipGraph({
        characters: [{ id: 'd1', name: '甲', currentFactionId: 'gone' }],
        factions: [{ id: 'df1', name: '乙门', leaders: ['ghost'], allies: ['不存在'] }],
        events: [{ id: 'de1', characterIds: ['d1', 'nobody'] }]
      })
      out.graphNoDanglingEdgesOk =
        dangling.nodes.length === 2 && dangling.edges.length === 0
      const l1 = layoutRelationshipGraph(g, { width: 600, height: 400 })
      const l2 = layoutRelationshipGraph(g, { width: 600, height: 400 })
      out.graphLayoutDeterministicOk =
        JSON.stringify(l1) === JSON.stringify(l2) &&
        l1.nodes.length === g.nodes.length &&
        l1.nodes.every((n) => n.x >= 0 && n.x <= 600 && n.y >= 0 && n.y <= 400)
    }

    // AI 修复：返回修订稿与差异预览，正文保持原样
    const fixMsgs = []
    const fixChat = (text) => (opts) => {
      fixMsgs.push(opts.messages)
      setTimeout(() => {
        opts.callbacks.onDelta?.(text)
        opts.callbacks.onUsage?.({ inputTokens: 500, outputTokens: 100 })
        opts.callbacks.onDone?.()
      }, 0)
      return { abort: () => {} }
    }
    const contentBeforeFix = b.store.chapters.find((c) => c.id === rChapter.id).content
    const fixWf = await runChapterWorkflow({
      input: {
        book: rBook,
        bookId: rBook.id,
        chapter: confirmedCard,
        chapters: [confirmedCard],
        outlines: [],
        memory: { characters: [], locations: [], factions: [], worldRules: [], events: [], foreshadowing: [] },
        structure: { volumes: [], arcs: [] },
        settings: s.settings,
        action: 'fix',
        text: contentBeforeFix,
        issue: flatIssues[0]
      },
      settings: s.settings,
      stages: ['fix'],
      chat: fixChat(JSON.stringify({ revised: '修订后的完整正文', explanation: '改了死亡设定' })),
      recordRun: genS.recordRun
    })
    const fixSent = (fixMsgs[0] || []).map((m) => m.content).join('\n')
    const storedAfterFixDraft = (await db.getChapters(rBook.id)).find((c) => c.id === rChapter.id)
    out.fixDraftOk =
      fixWf.fixDraft?.revised === '修订后的完整正文' &&
      fixWf.fixDraft?.explanation === '改了死亡设定' &&
      // 提示词带上了问题原文、说明与建议，并要求整章修订稿
      fixSent.includes('【审校问题】') &&
      fixSent.includes('苏九已死却出场') &&
      fixSent.includes('苏九正在碾药') &&
      fixSent.includes('修订后的完整章节正文') &&
      // 草案没有自动覆盖：内存与库里都还是原文
      b.store.chapters.find((c) => c.id === rChapter.id).content === contentBeforeFix &&
      storedAfterFixDraft.content === contentBeforeFix

    // 用户接受：先存版本（source=review），再写回正文，最后把问题标成已修复
    const versionsBefore = await b.loadVersions()
    await b.captureChapterVersion(rChapter.id, { source: 'review' })
    const versionsAfter = await b.loadVersions()
    const reviewVersion = versionsAfter.find(
      (v) => v.source === 'review' && v.content === contentBeforeFix
    )
    b.setChapterContent(rChapter.id, fixWf.fixDraft.revised)
    await b.persistChapter(rChapter.id)
    const fixedState = await setIssueStatus(rBook.id, flatIssues[0], 'fixed')
    const storedAfterAccept = (await db.getChapters(rBook.id)).find((c) => c.id === rChapter.id)
    out.fixAcceptOk =
      versionsAfter.length === versionsBefore.length + 1 &&
      !!reviewVersion &&
      storedAfterAccept.content === '修订后的完整正文' &&
      fixedState?.status === 'fixed' &&
      (await db.coll.reviewIssueStates.getAll(rBook.id)).find((x) => x.id === flatIssues[0].id)
        ?.status === 'fixed'
    await b.removeBook(rBook.id)

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
    const uiCh = await b.addChapter()
    // 先造出一版历史，再把正文换成新的：这样编辑器里打开的「第二版」与
    // 版本列表里那一版「第一版」是不同的东西，恢复才有可断言的变化。
    // 最后一笔必须 persist：点开书卡会走 openBook，它从库里重读章节，
    // 只改了内存的正文会被无声地丢掉（setChapterContent 不落盘）。
    await b.setChapterContent(uiCh.id, '第一版。')
    await b.captureChapterVersion(uiCh.id, { source: 'manual' })
    await b.setChapterContent(uiCh.id, '第二版。')
    await b.persistChapter(uiCh.id)
    // 第二章只服务后面的「全书搜索 → Enter 切章」：上面那节版本恢复会把当前章
    // 正文变回「第一版。」，若仍拿它当搜索目标，Enter 之后正文不变，断言就
    // 证明不了「跳转真的发生了」。openBook 会回到第一章，所以不影响前面的断言。
    const uiCh2 = await b.addChapter()
    await b.setChapterContent(uiCh2.id, '另一章独有的正文。')
    await b.persistChapter(uiCh2.id)
    // V4 起 openBook 会回到「上次读到的那一章」，而本节后面的断言都假设点开书卡
    // 落在第一章。建 uiCh2 时当前章已经跟过去了，这里显式切回第一章并落盘指针。
    await b.selectChapter(uiCh.id)
    await b.flushCurrentPointers()
    await new Promise((r) => setTimeout(r, 80))

    // 造一条「上次生成到一半就退出」的任务：status 仍是 running，草稿有内容。
    // 打开书后 AiPanel 必须把它标成 interrupted 并显示恢复条 —— 这正是崩溃、
    // 关窗、Android 杀后台之后用户实际会遇到的场景。
    await db.coll.generationTasks.upsert(uiBook.id, {
      id: 'smoke_crash_task',
      bookId: uiBook.id,
      chapterId: uiCh.id,
      action: 'continue',
      stages: ['write'],
      model: 'mock',
      status: 'running',
      startedAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
      outputText: '中断前已经收到的一段草稿。',
      lastError: '',
      abortedByUser: false,
      finishReason: ''
    })

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

      // 写作队列面板：从侧栏入口真点一次。setup 期抛错不会白屏（见坑 #14），
      // 所以必须断言它真的渲染出说明文案，而不是只断言按钮存在。
      const queueBtn = [...document.querySelectorAll('.sidebar .head-ops .btn')].find((el) =>
        el.textContent.includes('队列')
      )
      queueBtn?.click()
      await new Promise((r) => setTimeout(r, 250))
      const qModal = document.querySelector('.queue-modal')
      out.queuePanelMountOk =
        !!queueBtn &&
        !!qModal &&
        qModal.textContent.includes('只生成草稿，不会自动改正文') &&
        qModal.textContent.includes('开始队列')
      qModal?.querySelector('.modal-header .btn')?.click()
      await new Promise((r) => setTimeout(r, 120))

      // 草稿恢复条：等 settleOnOpen 的异步读写跑完
      await new Promise((r) => setTimeout(r, 250))
      const crashTask = (await db.coll.generationTasks.getAll(uiBook.id)).find(
        (t) => t.id === 'smoke_crash_task'
      )
      const recoveryBar = document.querySelector('.recovery-bar')
      out.draftRecoveryOk =
        crashTask?.status === 'interrupted' &&
        !!recoveryBar &&
        recoveryBar.textContent.includes('已保留') &&
        recoveryBar.textContent.includes('服务端请求不会恢复')

      const loadDraftBtn = [...(recoveryBar?.querySelectorAll('.btn') || [])].find((el) =>
        el.textContent.includes('载入到输出框')
      )
      loadDraftBtn?.click()
      await new Promise((r) => setTimeout(r, 120))
      out.draftLoadOk =
        (document.querySelector('.out-box')?.textContent || '').includes('中断前已经收到') &&
        !document.querySelector('.recovery-bar')

      // 生命周期冲刷：输入后**立刻**触发 pagehide，等过防抖窗口再读库。
      // 若 App 没有在 pagehide 上调 flush()，这笔修改仍停在 1.5s 防抖里，库里就没有。
      const ta = document.querySelector('.editor-ta')
      if (ta) {
        ta.value = '第二版。页面隐藏前补的一笔。'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        window.dispatchEvent(new Event('pagehide'))
        await new Promise((r) => setTimeout(r, 350))
      }
      const afterPagehide = (await db.getChapters(uiBook.id)).find((c) => c.id === uiCh.id)
      out.pagehideFlushOk = (afterPagehide?.content || '').includes('页面隐藏前补的一笔')

      // 把这笔测试改动还原，后面的版本面板断言依赖当前正文正好是「第二版。」
      if (ta) {
        ta.value = '第二版。'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        window.dispatchEvent(new Event('pagehide'))
        await new Promise((r) => setTimeout(r, 200))
      }

      // 给时间线留一条可画的东西。控制台打开时会**从库里重载**全部集合，
      // 所以这条必须先落库（memory.upsert 会写），只放进内存是看不到的。
      await useNovelMemory().upsert('events', {
        title: '挂载事件',
        chapterId: uiCh.id,
        time: '2月',
        // 关系图与「事件同场」都要靠这两个 id；没有它们，关系图那一段
        // 只能在空图上断言「组件挂载了」，那等于什么都没验。
        characterIds: ['uiC1', 'uiC2']
      })
      // 关系图的夹具：两个人 + 一个势力（首领 + 所属 + 自由文本关系）
      await useNovelMemory().upsert('characters', {
        id: 'uiC1',
        name: '林昭',
        status: 'alive',
        currentFactionId: 'uiF1',
        currentLocationId: 'uiL1',
        relationships: '苏九——林昭的同门师姐'
      })
      await useNovelMemory().upsert('locations', { id: 'uiL1', name: '药庐' })
      await useNovelMemory().upsert('characters', {
        id: 'uiC2',
        name: '苏九',
        status: 'alive'
      })
      await useNovelMemory().upsert('factions', {
        id: 'uiF1',
        name: '青云门',
        status: 'active',
        leaders: ['uiC1']
      })

      // 查找栏：Editor 的查找/替换状态正是在 setup 期被 watcher 碰过的那批
      const findBtn = [...document.querySelectorAll('.editor-ops .btn')].find(
        (el) => el.textContent.trim() === '查找'
      )
      findBtn?.click()
      await new Promise((r) => setTimeout(r, 80))
      out.uiFindBar = !!document.querySelector('.find-bar')
      document.querySelector('.find-bar .btn.ghost')?.click()
      await new Promise((r) => setTimeout(r, 50))

      // 版本面板：编辑器与控制台是两处入口，用的是同一个组件。这里连「恢复」
      // 一起点到底 —— 它顺带覆盖 reloadFromStore 那条路：同章内换正文**不会**
      // 触发章节 watch，漏掉重读的表现是「点了恢复什么也没发生」。
      const verBtn = [...document.querySelectorAll('.editor-ops .btn')].find(
        (el) => el.textContent.trim() === '版本'
      )
      verBtn?.click()
      await new Promise((r) => setTimeout(r, 120))
      out.versionPanelMountOk =
        !!document.querySelector('.ver-modal .cv') &&
        document.querySelectorAll('.ver-modal .cv-item').length === 1

      const restoreBtn = [...document.querySelectorAll('.ver-modal .cv-ops .btn')].find(
        (el) => el.textContent.trim() === '恢复此版'
      )
      restoreBtn?.click()
      await new Promise((r) => setTimeout(r, 60))
      // 恢复是改正文的动作，且它自己会先存一版 —— 一点就执行等于多出一条
      // 用户没要的版本，所以第一次点击只允许变成「确认恢复？」。
      const confirmBtn = [...document.querySelectorAll('.ver-modal .cv-ops .btn')].find(
        (el) => el.textContent.trim() === '确认恢复？'
      )
      const beforeConfirm = document.querySelector('.editor-ta')?.value
      confirmBtn?.click()
      await new Promise((r) => setTimeout(r, 300))
      out.versionRestoreUiOk =
        !!confirmBtn &&
        beforeConfirm === '第二版。' &&
        !document.querySelector('.ver-modal') &&
        document.querySelector('.editor-ta')?.value === '第一版。'

      // AI 面板端到端：真实点击「开始写作」，走编排器 + 真实 IPC 流式，
      // 断言面板上确实显示了这次花掉的 token 与金额。
      // 这一节补的是 L 节够不到的那一段：L 节把 chat 换成了假流，验证的是
      // 编排逻辑；这里验证的是**组件接线**——没有它，「每章显示花费」这个
      // 需求在真实点击路径上是否成立就没人验过。
      // 关掉自动提取让这条链只剩一次调用，断言就不必和「提取调用也算钱」纠缠
      // （提取路径已由 L4/L6 覆盖）。
      s.settings.apiKey = 'k'
      s.settings.baseUrl = `http://127.0.0.1:__PORT__/v1`
      s.settings.model = 'deepseek-chat'
      s.settings.autoExtractMemory = false
      s.settings.showUsage = true
      await s.persist()

      document.querySelector('.ai-panel .gen-btn')?.click()
      let usageText = ''
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 100))
        usageText = document.querySelector('.ai-panel .usage-line')?.textContent || ''
        if (usageText) break
      }
      const aiOut = document.querySelector('.ai-panel .out-text')?.textContent || ''
      out.aiPanelUsageOk =
        aiOut.includes('你好，世界！') &&
        // mock 的用量块是 prompt 1234 / completion 56
        usageText.includes('1.2k') &&
        usageText.includes('输入') &&
        usageText.includes('¥') &&
        // 详情默认折叠，点开才展开
        !document.querySelector('.ai-panel .usage-detail')
      document.querySelector('.ai-panel .usage-line')?.click()
      await new Promise((r) => setTimeout(r, 60))
      out.aiPanelUsageDetailOk =
        (document.querySelector('.ai-panel .usage-detail')?.textContent || '').includes('deepseek-chat')
      await new Promise((r) => setTimeout(r, 200))

      // 全书搜索：从顶栏真实打开，输入后必须出现命中，Enter 必须切章并关掉弹窗。
      // 这一节同时覆盖「搜索结果的集合名 → 控制台标签键」的映射：events 的标签
      // 叫「时间线」，直接传集合名会静默落到第一页。
      const searchBtn = [...document.querySelectorAll('.topbar .btn')].find(
        (el) => el.textContent.trim() === '搜索'
      )
      out.searchButtonFound = !!searchBtn
      searchBtn?.click()
      await new Promise((r) => setTimeout(r, 200))
      const searchInput = document.querySelector('.modal.search-modal input[type="search"]')
      out.searchModalOk = !!searchInput && !!document.querySelector('.modal.search-modal .hint')
      if (searchInput) {
        searchInput.value = '独有'
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 350))
      }
      const firstHit = document.querySelector('.modal.search-modal .hit')
      out.searchHitOk =
        !!firstHit &&
        firstHit.textContent.includes('章节') &&
        firstHit.textContent.includes('独有') &&
        !!firstHit.querySelector('mark')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      await new Promise((r) => setTimeout(r, 300))
      out.searchJumpOk =
        !document.querySelector('.modal.search-modal') &&
        document.querySelector('.editor-ta')?.value === '另一章独有的正文。'

      // 搜实体：点中事件必须打开控制台并落在「时间线」标签，而不是首页。
      searchBtn?.click()
      await new Promise((r) => setTimeout(r, 200))
      const searchInput2 = document.querySelector('.modal.search-modal input[type="search"]')
      if (searchInput2) {
        searchInput2.value = '挂载事件'
        searchInput2.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 350))
      }
      const eventHit = [...document.querySelectorAll('.modal.search-modal .hit')].find((el) =>
        el.textContent.includes('事件')
      )
      eventHit?.click()
      await new Promise((r) => setTimeout(r, 400))
      out.searchEntityOpenOk =
        !document.querySelector('.modal.search-modal') &&
        !!document.querySelector('.modal.console') &&
        (document.querySelector('.console-tabs .ctab.active')?.textContent || '').includes('时间线') &&
        (document.querySelector('.console-pane .tl-title')?.textContent || '').includes('挂载事件')

      // 关掉搜索打开的那次控制台，后面的正常入口测试重新开一遍
      const searchConsoleClose = [...document.querySelectorAll('.modal.console .modal-header .btn')].find(
        (el) => el.textContent.trim() === '关闭'
      )
      searchConsoleClose?.click()
      await new Promise((r) => setTimeout(r, 200))

      // 小说控制台：同样必须走真实点击。控制台一次性挂载 EntityTable ×8、
      // MemoryReview、ContextPreview、GenerationHistory 六个组件，是全项目
      // 依赖 setup 期正确性最重的一处 —— 只调 store 根本碰不到它们。
      const consoleBtn = [...document.querySelectorAll('.topbar .btn')].find(
        (el) => el.textContent.trim() === '控制台'
      )
      out.consoleButtonFound = !!consoleBtn
      consoleBtn?.click()
      await new Promise((r) => setTimeout(r, 500))

      const tabs = [...document.querySelectorAll('.console-tabs .ctab')]
      const pickTab = (label) =>
        tabs.find((el) => el.querySelector('span')?.textContent.trim() === label)
      // 剧情页：全书规划面板 + 卷 / 篇 / 场景三张表（场景是阶段 4 新增的）
      const storyTables = document.querySelectorAll('.console-pane .entity-table')
      out.consoleMountOk =
        !!document.querySelector('.modal.console') &&
        // 16 个标签：阶段 5 新增「检索」、阶段 6 新增「关系图」。这个数字
        // **不是**随手写死的常量，它同时验证「TABS 与标签栏渲染一致」——
        // 改了 TABS 忘改这里会立刻红。
        tabs.length === 16 &&
        !!document.querySelector('.console-pane .bp') &&
        document.querySelectorAll('.console-pane .bp-field').length === 7 &&
        storyTables.length === 3 &&
        (storyTables[0]?.querySelector('h4')?.textContent || '').includes('卷') &&
        (storyTables[2]?.querySelector('h4')?.textContent || '').includes('场景')

      // 切标签：每次切换都会挂载一个不同的子组件，逐个确认它们真的渲染出内容
      pickTab('人物')?.click()
      await new Promise((r) => setTimeout(r, 120))
      const peopleOk = (document.querySelector('.console-pane .et-head h4')?.textContent || '').includes(
        '人物'
      )

      // 上下文与迁移：Context Preview 是本轮最容易被遗漏的验收点 ——
      // 它跑的是真正的 buildContext + messagesFromContext，组件里任何一处的
      // 字段名写错都只会在打开这一页时才炸。
      pickTab('上下文与迁移')?.click()
      await new Promise((r) => setTimeout(r, 200))
      const ctxRows = document.querySelectorAll('.console-pane .ctx-table tbody tr')
      const ctxOk = ctxRows.length > 0 && !!(document.querySelector('.console-pane .ctx'))

      // 生成历史：必须能看到刚才那次真实调用 —— 这是「每章显示花费」在
      // 控制台一侧的落点，也是它与 AI 面板那行摘要数据同源的证据。
      pickTab('生成历史')?.click()
      await new Promise((r) => setTimeout(r, 120))
      const hisRows = document.querySelectorAll('.console-pane .gh-table tbody tr')
      const hisSum = document.querySelector('.console-pane .gh-sum')?.textContent || ''
      out.consoleHistoryOk = hisRows.length >= 1 && hisSum.includes('调用次数')

      // 版本标签：同一份数据在两处入口渲染，这里确认它挂在控制台这一侧也对
      // （上面点过恢复，所以现在应当是 2 版：恢复前那一版是自动存下的）
      pickTab('版本')?.click()
      await new Promise((r) => setTimeout(r, 150))
      // 来源徽标只从 .cv-item 里取 —— 顶部说明文案里也写着「手动存档」「回滚前」，
      // 从整块面板取文本等于断言恒真
      const srcLabels = [...document.querySelectorAll('.console-pane .cv-item .cv-src')].map((el) =>
        el.textContent.trim()
      )
      out.consoleVersionsOk =
        document.querySelectorAll('.console-pane .cv-group').length === 1 &&
        srcLabels.length === 2 &&
        srcLabels.includes('手动存档') &&
        srcLabels.includes('回滚前')

      // 版本对比：点开当前章节这一组的「版本对比」，必须真的画出逐行差异。
      // 只断言面板出现是不够的——diff 结果为空时面板同样会出现。
      document.querySelector('.console-pane .cv-cmp-toggle .btn')?.click()
      await new Promise((r) => setTimeout(r, 150))
      out.versionCompareUiOk =
        !!document.querySelector('.console-pane .cv-cmp') &&
        document.querySelectorAll('.console-pane .cv-diff .dline').length >= 1 &&
        (document.querySelector('.console-pane .cv-cmp-stats')?.textContent || '').includes('新增')

      // 时间线：轴是画出来的，光断言「组件挂载了」不够 —— 必须看到那个事件
      // 真的落在它的章节锚点下面。默认是轴，「表格」那一侧保留可编辑的实体表。
      pickTab('时间线')?.click()
      await new Promise((r) => setTimeout(r, 150))
      const tlAnchor = document.querySelector('.console-pane .tl-chap')?.textContent || ''
      out.timelineMountOk =
        !!document.querySelector('.console-pane .tl-axis') &&
        document.querySelectorAll('.console-pane .tl-node').length === 1 &&
        (document.querySelector('.console-pane .tl-title')?.textContent || '').includes('挂载事件') &&
        tlAnchor.includes('第1章') &&
        // 逾期/断链的汇总条不该在这份干净数据上出现（防误报在 UI 上也要成立）
        !document.querySelector('.console-pane .tl-warn')

      const tableBtn = [...document.querySelectorAll('.console-pane .tl-ops .btn')].find(
        (el) => el.textContent.trim() === '表格'
      )
      tableBtn?.click()
      await new Promise((r) => setTimeout(r, 120))
      out.timelineTableOk =
        !!document.querySelector('.console-pane .entity-table') &&
        !document.querySelector('.console-pane .tl-axis')

      // 一致性：报告是纯计算出来的，所以这里挂载时必须已经有内容（上面造过
      // 「空章」与「AI 覆盖过的章」，那两条都会命中「章节缺摘要」）。
      // 同时确认那句「规则检查不调用 AI，不产生费用」真的在页面上 ——
      // 它是对用户的承诺，不该只存在于注释里。
      pickTab('一致性')?.click()
      await new Promise((r) => setTimeout(r, 150))
      const crText = document.querySelector('.console-pane .cr')?.textContent || ''
      out.consistencyMountOk =
        !!document.querySelector('.console-pane .cr') &&
        document.querySelectorAll('.console-pane .cr-group').length >= 1 &&
        !!document.querySelector('.console-pane .cr-item') &&
        crText.includes('不产生费用') &&
        !!document.querySelector('.console-pane .cr-ai .btn')

      // 文风与统计：两个新标签各挂一个组件。统计面板直接消费纯函数 buildStats，
      // 这里断言它真的画出了卡片与条形，而不是空壳。
      pickTab('文风')?.click()
      await new Promise((r) => setTimeout(r, 120))
      const styleOk = (document.querySelector('.console-pane .et-head h4')?.textContent || '').includes(
        '文风'
      )

      pickTab('统计')?.click()
      await new Promise((r) => setTimeout(r, 150))
      const statsText = document.querySelector('.console-pane .stats')?.textContent || ''
      const statsOk =
        !!document.querySelector('.console-pane .stats') &&
        statsText.includes('写作统计') &&
        statsText.includes('总字数') &&
        document.querySelectorAll('.console-pane .stats .card').length === 4 &&
        document.querySelectorAll('.console-pane .stats .block').length >= 5
      out.consoleStyleStatsOk = styleOk && statsOk

      // 检索（RAG）：面板挂载本身就覆盖了「setup 期抛错」这一大类缺陷
      // （见 CLAUDE.md 坑 #14）。这里只读状态、不点重建 —— 重建会往真实库
      // 的这本书里写 ragChunks，而这一步的目标只是确认组件渲染正常。
      pickTab('检索')?.click()
      await new Promise((r) => setTimeout(r, 150))
      const ragPane = document.querySelector('.console-pane .rag')
      out.consoleRagPanelOk =
        !!ragPane &&
        (ragPane.querySelector('h4')?.textContent || '').includes('本地检索') &&
        ragPane.textContent.includes('字面相似度') &&
        !!ragPane.querySelector('input[type="checkbox"]')

      // 关系图：夹具是 2 人物 + 1 势力（+ 1 地点，默认不显示），
      // 边有首领 / 所属 / 同场 / 自由文本关系。断言的是**真实画出来的东西**：
      // 圆点数量、节点计数文案、图例、过滤开关与点击详情。
      const relTab = pickTab('关系图')
      const relBadge = relTab?.querySelector('.ctab-badge')?.textContent.trim()
      out.graphTabBadgeOk = relTab?.querySelector('span')?.textContent.trim() === '关系图' && relBadge === '3'
      relTab?.click()
      await new Promise((r) => setTimeout(r, 200))
      const relPane = document.querySelector('.console-pane .rel')
      const relStatsText = relPane?.querySelector('.stat')?.textContent || ''
      out.graphRenderOk =
        !!relPane &&
        relStatsText.includes('节点 3') &&
        relStatsText.includes('人物 2') &&
        relStatsText.includes('势力 1') &&
        relPane.querySelectorAll('.rel-svg .node circle').length === 3 &&
        relPane.querySelectorAll('.rel-svg .edges line').length === 4 &&
        relPane.querySelectorAll('.legend .chip').length === 8

      // 过滤：打开「显示地点」→ 节点变 4、出现「所在」边
      const locToggle = relPane?.querySelectorAll('.rel-bar input[type="checkbox"]')?.[0]
      locToggle?.click()
      await new Promise((r) => setTimeout(r, 150))
      out.graphFilterOk =
        (document.querySelector('.console-pane .rel .stat')?.textContent || '').includes('节点 4') &&
        document.querySelectorAll('.console-pane .rel .rel-svg .node circle').length === 4 &&
        document.querySelectorAll('.console-pane .rel .rel-svg .edges line').length === 5

      // 点击节点 → 右侧详情必须列出它的关系（空面板会让图看起来能点但没用）
      // 点「林昭」这个节点（度数最高）：随便点第一个的话，布局顺序可能先给
      // 到一个只有两条边的节点，断言就变成在考验节点排序而不是详情面板。
      ;[...document.querySelectorAll('.console-pane .rel .rel-svg .node')]
        .find((el) => el.textContent.includes('林昭'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 120))
      const detailText = document.querySelector('.console-pane .rel .rel-detail')?.textContent || ''
      out.graphClickDetailOk =
        !!document.querySelector('.console-pane .rel .rel-detail h5') &&
        detailText.includes('连接') &&
        document.querySelectorAll('.console-pane .rel .rel-detail .rels li').length >= 3

      out.consoleTabsOk = peopleOk && ctxOk

      // 关闭：点右上角按钮，确认整层弹窗被移除（遮罩没被卡住）
      const closeBtn = [...document.querySelectorAll('.modal.console .modal-header .btn')].find(
        (el) => el.textContent.trim() === '关闭'
      )
      closeBtn?.click()
      await new Promise((r) => setTimeout(r, 200))
      out.consoleCloseOk = !document.querySelector('.modal.console')

      // 返回书库：顺带覆盖 handleBackToShelf → flush → closeBook 的真实编排
      const backBtn = [...document.querySelectorAll('.topbar .btn')].find(
        (el) => el.textContent.trim() === '返回书库'
      )
      backBtn?.click()
      await new Promise((r) => setTimeout(r, 300))
      out.uiBackToShelf = !!document.querySelector('.shelf') && !document.querySelector('.editor')

      // 全量备份弹窗。只挂载、不点「导出」——那会弹原生保存框；
      // 也不点「选择备份文件」——那会弹原生文件选择器（见冒烟测试纪律第 2 条）。
      const backupBtn = [...document.querySelectorAll('.shelf-tools .btn')].find(
        (el) => el.textContent.trim() === '备份'
      )
      out.backupButtonFound = !!backupBtn
      backupBtn?.click()
      await new Promise((r) => setTimeout(r, 200))
      out.backupModalOk =
        !!document.querySelector('.modal input[type="file"]') &&
        !!document.querySelector('.modal .bk-btn')
      document.querySelector('.modal .modal-header .btn')?.click()
      await new Promise((r) => setTimeout(r, 120))
      out.backupModalClosed = !document.querySelector('.modal input[type="file"]')

      // 设置里的「局域网同步」节。挂载本身只能证明它没在 setup 期抛错，
      // 所以这里真的把服务开关点一次：`.sync-code` 只在服务运行时才渲染，
      // 它出现 = 面板 → sync.js → 主进程 → HTTP 监听这条链路整条是通的。
      const settingsBtn = [...document.querySelectorAll('.topbar .btn')].find(
        (el) => el.textContent.includes('设置')
      )
      settingsBtn?.click()
      await new Promise((r) => setTimeout(r, 200))
      const modalText = document.querySelector('.modal')?.textContent || ''
      // 版本面板的提示语写着「在『设置 → 章节版本』里改」，所以那个控件必须真的在 ——
      // 断言里带上**当前值**（而不是只找「保留」两个字），这样标签与 settings 的绑定
      // 一旦断掉也会被抓到
      out.versionKeepPanelOk = modalText.includes(
        `每章最多保留：${defaultSettings.versionKeep} 版`
      )

      // WebDAV 面板：与局域网同步同时存在，且必须把「谁的服务器、密码存哪」写清楚
      const wdPanel = document.querySelector('.modal .webdav-panel')
      out.webdavPanelOk =
        !!wdPanel &&
        wdPanel.textContent.includes('自己的 WebDAV 服务器') &&
        wdPanel.textContent.includes('不经过本项目的任何服务') &&
        wdPanel.textContent.includes('不写入数据库') &&
        !!wdPanel.querySelector('input[type="password"]')

      // 插件面板：必须真的在设置里渲染出来，并把「不执行插件代码」写明。
      // 这里只读不点 —— 「打开插件目录」会拉起资源管理器（冒烟纪律第 2 条）。
      const pluginPanel = document.querySelector('.modal .plugins-panel')
      out.pluginPanelOk =
        !!pluginPanel &&
        pluginPanel.textContent.includes('绝不执行插件代码') &&
        pluginPanel.textContent.includes('重新读取') &&
        !!pluginPanel.querySelector('input[type="checkbox"]')

      const syncPanel = document.querySelector('.modal .sync-panel')
      out.syncPanelOk =
        !!syncPanel &&
        // 桌面端那副面孔：服务开关 + 端口输入 + 那句「不经过第三方服务器」的承诺
        !!syncPanel.querySelector('input[type="checkbox"]') &&
        !!syncPanel.querySelector('input[type="number"]') &&
        syncPanel.textContent.includes('不经过任何第三方服务器')

      // 轮询而不是睡固定毫秒：端口被占用时服务会向后顺延重试，最多可能要一秒多
      const waitFor = async (fn, ms = 3000) => {
        const t0 = performance.now()
        while (performance.now() - t0 < ms) {
          if (fn()) return true
          await new Promise((r) => setTimeout(r, 50))
        }
        return false
      }
      const svcToggle = syncPanel?.querySelector('input[type="checkbox"]')
      svcToggle?.click()
      await waitFor(() => !!document.querySelector('.modal .sync-code'))
      out.syncPanelToggleOk = /^\d{6}$/.test(
        document.querySelector('.modal .sync-code')?.textContent.trim() || ''
      )
      // 关掉，别让这次挂载测试给整轮留下一台没人管的服务（后面的 M 段还会再开）
      document.querySelector('.modal .sync-panel input[type="checkbox"]')?.click()
      await waitFor(() => !document.querySelector('.modal .sync-code'), 2000)
      await new Promise((r) => setTimeout(r, 100))
      out.syncPanelOffOk = !document.querySelector('.modal .sync-code')
      document.querySelector('.modal .modal-header .btn')?.click()
      await new Promise((r) => setTimeout(r, 150))
      out.settingsModalClosed = !document.querySelector('.modal .sync-panel')
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
        const acc = { text: '', err: '', done: false, aborted: false, usage: null }
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
            onUsage: (u) => (acc.usage = u),
            onError: (info) =>
              finish({
                ...acc,
                err:
                  typeof info === 'string'
                    ? info
                    : info?.detail || info?.message || '请求失败',
                errInfo: info
              }),
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

    // G5) usage 解析：两种块形状都必须认（见 llm.js 的 parseSseUsage）。
    //     这两种形状对解析器的要求是相反的，只认一种的实现会在另一家上永远显示 0。
    const uDeepseek = parseSseUsage(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_cache_hit_tokens: 4
          }
        })
    )
    const uOpenai = parseSseUsage(
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })
    )
    out.usageParseOk =
      !!uDeepseek &&
      uDeepseek.inputTokens === 10 &&
      uDeepseek.outputTokens === 2 &&
      uDeepseek.totalTokens === 12 &&
      uDeepseek.cachedTokens === 4 &&
      !!uOpenai &&
      uOpenai.inputTokens === 7 &&
      uOpenai.outputTokens === 3 &&
      // total_tokens 缺失时自己加出来，不能变成 0
      uOpenai.totalTokens === 10 &&
      // OpenAI 每个非末尾块都带 "usage": null —— 必须返回 null，不能推一个 0 出去
      parseSseUsage(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }], usage: null })
      ) === null &&
      parseSseUsage('data: [DONE]') === null &&
      parseSseUsage('not sse') === null &&
      // usage 块没有文本，且它不该被当成一个空的增量文本
      parseSseLine(
        'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })
      ) === ''

    // G5b) 错误对象契约：分类、状态码、脱敏。401 只回一句可行动的说明，
    //      服务端回显的假 Key 必须被抹掉。
    const authErr = await collect(
      { ...sseSettings, baseUrl: `http://127.0.0.1:__PORT__/auth` },
      [{ role: 'user', content: 'hi' }],
      { forceBrowser: true }
    )
    out.errorObjectOk =
      !authErr.done &&
      !!authErr.errInfo &&
      authErr.errInfo.category === 'auth' &&
      authErr.errInfo.status === 401 &&
      authErr.errInfo.retryable === false &&
      authErr.errInfo.detail.includes('[redacted]') &&
      !authErr.errInfo.detail.includes('sk-smoke-leak-123456')
    out.serverErrorCategoryOk =
      !!rErr.errInfo && rErr.errInfo.category === 'server' && rErr.errInfo.status === 500

    // G5c) 可靠封装：没收到正文时，500 自动重试一次后成功；Retry-After 被尊重。
    const runReliable = (base, extra = {}) =>
      new Promise((resolve) => {
        const acc = {
          text: '',
          retries: [],
          err: null,
          done: false,
          truncated: null,
          aborted: false,
          finishReason: ''
        }
        let settled = false
        const finish = (patch) => {
          if (settled) return
          settled = true
          resolve({ ...acc, ...patch })
        }
        const timer = setTimeout(() => finish({ err: 'timeout' }), 8000)
        chatStreamReliable({
          settings: { ...sseSettings, baseUrl: base },
          messages: [{ role: 'user', content: 'hi' }],
          // 退避在测试里不真的睡
          sleep: () => Promise.resolve(),
          ...extra,
          callbacks: {
            onDelta: (t) => (acc.text += t),
            onRetry: (r) => acc.retries.push(r),
            onDone: (p) => {
              clearTimeout(timer)
              finish({ done: true, finishReason: p?.finishReason || '' })
            },
            onTruncated: (info) => {
              clearTimeout(timer)
              finish({ truncated: info, finishReason: info?.finishReason || '' })
            },
            onError: (info) => {
              clearTimeout(timer)
              finish({ err: info })
            },
            onAborted: () => {
              clearTimeout(timer)
              finish({ aborted: true })
            }
          }
        })
      })
    const flaky = await runReliable(`http://127.0.0.1:__PORT__/flaky`)
    out.retryOnceOk =
      flaky.done &&
      flaky.text === '你好，世界！' &&
      flaky.retries.length === 1 &&
      flaky.retries[0].attempt === 1 &&
      flaky.retries[0].category === 'server' &&
      flaky.retries[0].retryAfterMs === 1000

    // 401 不重试：配置错误重试一百次也一样，而且每次都可能计费。
    const authReliable = await runReliable(`http://127.0.0.1:__PORT__/auth`)
    out.authNoRetryOk =
      !!authReliable.err &&
      authReliable.err.category === 'auth' &&
      authReliable.retries.length === 0

    // 截断：正文保留、走 onTruncated、绝不走 onDone。
    const trunc = await runReliable(`http://127.0.0.1:__PORT__/truncated`)
    out.truncatedOk =
      trunc.text === '前半段正文' &&
      !trunc.done &&
      !!trunc.truncated &&
      trunc.truncated.category === 'truncated' &&
      trunc.finishReason === 'length'

    // 流内错误块（HTTP 200）：必须变成终止错误，而不是「静默结束」。
    const streamErr = await collect(
      { ...sseSettings, baseUrl: `http://127.0.0.1:__PORT__/stream-error` },
      [{ role: 'user', content: 'hi' }],
      { forceBrowser: true }
    )
    out.streamErrorBlockOk =
      !streamErr.done && !!streamErr.errInfo && String(streamErr.err).includes('余额不足')

    // 退避：1s / 2s 指数增长且带抖动；Retry-After 优先。
    const b0 = computeBackoff(0, { random: () => 0.5 })
    const b1 = computeBackoff(1, { random: () => 0.5 })
    out.backoffOk =
      b0 === 1000 &&
      b1 === 2000 &&
      computeBackoff(0, { retryAfterMs: 5000, random: () => 0.5 }) === 5000 &&
      shouldRetry({ category: 'server', retryable: true }, { attempt: 0, hasText: false }) ===
        true &&
      shouldRetry({ category: 'server', retryable: true }, { attempt: 0, hasText: true }) ===
        false &&
      shouldRetry({ category: 'auth', retryable: false }, { attempt: 0, hasText: false }) ===
        false

    // G6) usage 经两条传输路径都能到达 onUsage。
    //     IPC 路径拿到的是 DeepSeek 形状（挂在最后一个内容块上），
    //     浏览器路径拿到的是 OpenAI 形状（choices 为空的独立块）。
    out.streamUsageIpc =
      !!rIpc.usage &&
      rIpc.usage.inputTokens === 1234 &&
      rIpc.usage.outputTokens === 56 &&
      rIpc.usage.totalTokens === 1290 &&
      rIpc.usage.cachedTokens === 100

    const rBrUse = await collect(
      { ...sseSettings, baseUrl: `http://127.0.0.1:__PORT__/usage` },
      [{ role: 'user', content: 'hi' }],
      { forceBrowser: true }
    )
    out.streamUsageBrowser =
      rBrUse.done &&
      rBrUse.text === '你好，世界！' &&
      !!rBrUse.usage &&
      rBrUse.usage.inputTokens === 777 &&
      rBrUse.usage.outputTokens === 88 &&
      rBrUse.usage.totalTokens === 865 &&
      rBrUse.usage.cachedTokens === 0

    // 关掉开关时请求里不带 stream_options，mock 也照真实服务端那样不返回用量。
    // 这条是给「服务端不认这个字段会直接 400」的兼容端点留的退路，
    // 光验证「开关字段存在」是不够的——要验证它真的改变了发出的请求。
    const rNoUse = await collect(
      { ...sseSettings, streamUsage: false },
      [{ role: 'user', content: 'hi' }]
    )
    out.streamUsageOff = rNoUse.done && rNoUse.text === '你好，世界！' && rNoUse.usage === null

    // G7) 未配价格的模型如实说「未配置价格」，不能显示成 ¥0 ——
    //     '*' 兜底条目的单价是 0，算出来的金额必然是 0，但那个 0 的意思是
    //     「不知道」，展示成「免费」是在误导用户的账单判断。
    // 到这里 store 里已经没有打开的书了（H 节删掉了它），而 recordRun 的
    // bookId 守卫会直接返回 null，所以必须显式建一本。
    const usageBook = await b.createBook({ title: '测试小说', intro: '用量核算' })
    const unpricedRun = await useGeneration().recordRun({
      bookId: usageBook.id,
      model: '某个没有配过价的模型',
      inputTokens: 1000,
      outputTokens: 1000
    })
    const pricedRun = await useGeneration().recordRun({
      bookId: usageBook.id,
      model: 'deepseek-chat',
      inputTokens: 1000,
      outputTokens: 1000
    })
    out.unpricedHonestOk =
      !!unpricedRun &&
      unpricedRun.priced === false &&
      describeRun(unpricedRun).includes('未配置价格') &&
      aggregateRuns([unpricedRun]).unpriced === 1 &&
      !!pricedRun &&
      pricedRun.priced === true &&
      describeRun(pricedRun).includes('¥') &&
      !describeRun(pricedRun).includes('未配置价格')
    await b.removeBook(usageBook.id)

    // ------------------------------------------------------------------
    // L) AI 编排器：写正文 → 提取记忆 → 按风险入库
    //
    // 全程注入假的 chat，不碰网络。这不是图快，而是**只有这样才能验证
    // 「提取失败重试一次」「中途中止不留半提交」这两条路径** —— 真实 SSE
    // 只能靠人手工点出来，而它们恰恰是出错时最需要正确的那两条。
    // 编排器把 chat 与 recordRun 都做成注入点，就是为了这一刻。
    // ------------------------------------------------------------------

    // L1) extractJson：字符串字面量感知的括号扫描。
    //     常见的错误实现是「找第一个 { 配最后一个 }」或用正则，正文里出现
    //     花括号 / 引号就会切出一个语法错误的片段，而失败的样子是
    //     「记忆静默地什么都没提取到」。
    out.extractJsonOk = (() => {
      const fenced = '好的，以下是提取结果：\n```json\n{"a":1,"b":[2,3]}\n```\n以上。'
      const braceInString = '{"text":"他想起{那句话}，又说「不必了」","n":1}'
      const quotedInString = '{"a":"say \\"hi\\" now","b":2}'
      return (
        JSON.stringify(extractJson(fenced)) === JSON.stringify({ a: 1, b: [2, 3] }) &&
        JSON.stringify(extractJson(braceInString)) ===
          JSON.stringify({ text: '他想起{那句话}，又说「不必了」', n: 1 }) &&
        JSON.stringify(extractJson(quotedInString)) ===
          JSON.stringify({ a: 'say "hi" now', b: 2 }) &&
        JSON.stringify(extractJson('[{"x":1}]')) === JSON.stringify([{ x: 1 }]) &&
        extractJson('{"a":1') === null && // 被 max_tokens 截断
        extractJson('{"a":1,}') === null && // 括号配平但 JSON 本身有语法错误
        extractJson('这一段里没有任何 JSON') === null &&
        extractJson('') === null &&
        extractJson(null) === null
      )
    })()

    // L2) 风险分级。判成高风险的都不是「改错了很难改回来」，而是**改错了
    //     用户看不出来**的那些：人物死了、势力覆灭了、世界规则被推翻，
    //     会静默改变后续每一章的生成前提。境界变化的方向无法从文本判断
    //     （「筑基三层」与「练气九层」谁高谁低没有全局顺序），所以一律高风险。
    out.riskClassifyOk = (() => {
      const R = (c) => classifyRisk(c)
      return (
        R({ entity: 'characters', field: 'status', from: 'alive', to: 'dead' }) === 'high' &&
        R({ entity: 'characters', field: 'status', from: 'alive', to: 'missing' }) === 'high' &&
        // 反向也要拦：不能让已死的人被静默复活
        R({ entity: 'characters', field: 'status', from: 'dead', to: 'alive' }) === 'high' &&
        R({ entity: 'characters', field: 'currentPower', from: '练气三层', to: '筑基一层' }) ===
          'high' &&
        R({ entity: 'factions', field: 'status', from: 'active', to: 'destroyed' }) === 'high' &&
        R({ entity: 'worldRules', field: 'rule', op: 'create', from: null, to: '灵气会枯竭' }) ===
          'high' &&
        R({ entity: 'characters', field: 'personality', from: '冷漠', to: '开朗' }) === 'low' &&
        R({ entity: 'locations', field: 'currentState', from: '完好', to: '焚毁' }) === 'low' &&
        R(null) === 'low'
      )
    })()

    // L3) 变更比对：按 id 与规范化标题两级匹配、中文标签归一、由调用方补章节归属。
    out.diffMemoryOk = (() => {
      const current = { characters: [{ id: 'c1', name: '林昭', identity: '药童', status: 'alive' }] }
      const changes = diffMemoryCandidates(
        current,
        {
          // 状态写成中文标签（模型很常这么干），必须归一到 'dead'，
          // 否则界面上的下拉框会变成一个不匹配任何选项的空值
          characters: [
            { id: 'c1', name: '林昭', status: '死亡' },
            { name: '苏九', identity: '药师' }
          ],
          foreshadowing: [{ title: '断剑', content: '剑上刻着半个字', status: '已埋下' }],
          events: [{ title: '雨夜问诊', description: '林昭夜访药庐' }]
        },
        { chapterId: 'ch9' }
      )
      const pick = (t) => changes.filter((c) => c.title === t)
      const lin = pick('林昭')
      const su = pick('苏九')
      const sword = pick('断剑')
      const ev = pick('雨夜问诊')
      return (
        lin.length === 1 &&
        lin[0].op === 'update' &&
        lin[0].id === 'c1' &&
        lin[0].field === 'status' &&
        lin[0].to === 'dead' &&
        lin[0].risk === 'high' &&
        su.length === 1 &&
        su[0].op === 'create' &&
        su[0].data.identity === '药师' &&
        su[0].risk === 'low' &&
        // chapterId / firstChapterId 是引用型字段，提取提示词明确要求模型别碰 id，
        // 所以「发生在哪一章」只能由调用方补。少了它时间线与「埋下于」永远是空的。
        ev.length === 1 &&
        ev[0].data.chapterId === 'ch9' &&
        sword.length === 1 &&
        sword[0].data.firstChapterId === 'ch9' &&
        // 空字符串不得把已有内容擦掉
        diffMemoryCandidates(
          { characters: [{ id: 'c1', name: '林昭', identity: '药童' }] },
          { characters: [{ id: 'c1', name: '林昭', identity: '' }] }
        ).length === 0 &&
        // 连名字都没有的记录不建
        diffMemoryCandidates({}, { characters: [{ identity: '药师' }] }).length === 0
      )
    })()

    // L4) 端到端（假 chat）：低风险直接入库，高风险进审阅队列
    const wfBook = await b.createBook({ title: '测试小说', intro: '编排器' })
    const wfChapter = await b.addChapterWithContent('林昭站在药庐外。', '第一章')
    // 预置一个已有人物，好让提取里对它的修改命中「更新」而不是「新建」
    await db.coll.characters.upsert(wfBook.id, {
      id: 'seed-su',
      bookId: wfBook.id,
      name: '苏九',
      identity: '药师',
      status: 'alive'
    })

    const wfInput = {
      book: wfBook,
      bookId: wfBook.id,
      chapter: wfChapter,
      chapters: [wfChapter],
      outlines: [],
      memory: {
        characters: await db.coll.characters.getAll(wfBook.id),
        worldRules: [],
        locations: [],
        factions: [],
        events: [],
        foreshadowing: []
      },
      structure: { volumes: [], arcs: [] },
      settings: s.settings,
      action: 'chapter',
      instruction: ''
    }

    const extractPayload = JSON.stringify({
      summary: '林昭夜访药庐，得知师父已死。',
      timelineEnd: '第七天夜里',
      characters: [
        {
          name: '林昭',
          identity: '药童',
          evidence: '林昭推开门，看见苏九正在碾药。'
        },
        {
          id: 'seed-su',
          name: '苏九',
          status: '死亡',
          evidence: '苏九伏在案上，已经没了气息。'
        }
      ],
      foreshadowing: [{ title: '断剑', content: '剑上刻着半个字' }],
      events: [{ title: '雨夜问诊', description: '林昭夜访药庐' }]
    })

    // 每调用一次消耗一条队列；用完就返回空流（能立刻暴露「多调了一次」）
    const capturedMsgs = []
    const fakeChat = (queue) => (opts) => {
      capturedMsgs.push(opts.messages)
      const step = queue.shift() || {}
      setTimeout(() => {
        if (step.text) opts.callbacks.onDelta?.(step.text)
        if (step.usage) opts.callbacks.onUsage?.(step.usage)
        if (step.abort) opts.callbacks.onAborted?.()
        else if (step.error) opts.callbacks.onError?.(step.error)
        else opts.callbacks.onDone?.()
      }, 0)
      return { abort: () => {} }
    }

    let ctlSync = false
    let ctlIsFn = false
    const wf = await runChapterWorkflow({
      input: wfInput,
      settings: s.settings,
      chat: fakeChat([
        {
          text: '林昭推开门，看见苏九正在碾药。',
          usage: { inputTokens: 100, outputTokens: 50 }
        },
        { text: extractPayload, usage: { inputTokens: 200, outputTokens: 30 } }
      ]),
      recordRun: useGeneration().recordRun,
      callbacks: {
        // 中止句柄必须在 runChapterWorkflow 返回**之前**就交出去，
        // 否则用户永远点不到「停止」（那时生成早结束了）。
        // 这个赋值发生在函数体第一个 await 之前，所以下面那行同步读得到。
        onControl: (h) => {
          ctlSync = true
          ctlIsFn = typeof h.abort === 'function'
        }
      }
    })

    const wfChars = await db.coll.characters.getAll(wfBook.id)
    const wfQueue = await db.coll.reviewQueue.getAll(wfBook.id)
    const wfSword = await db.coll.foreshadowing.getAll(wfBook.id)
    const wfRuns = await db.coll.generationRuns.getAll(wfBook.id)
    const wfLogs = await db.coll.memoryChangeLog.getAll(wfBook.id)
    const wfSu = wfChars.find((c) => c.id === 'seed-su')

    out.workflowSyncAbortOk = ctlSync && ctlIsFn
    out.workflowOk =
      wf.run.status === 'done' &&
      wf.output === '林昭推开门，看见苏九正在碾药。' &&
      wf.run.stages.map((x) => x.status).join(',') === 'done,done' &&
      // 四条变更：新建人物「林昭」、新建伏笔「断剑」、新建事件「雨夜问诊」，
      // 外加对苏九状态的修改
      wf.changes.length === 4 &&
      // 低风险直接入库（前三条），高风险的那条进队列
      wf.applied.length === 3 &&
      // 高风险进审阅队列：苏九 status alive → dead
      wf.queued.length === 1 &&
      wf.queued[0].entity === 'characters' &&
      wf.queued[0].from === 'alive' &&
      wf.queued[0].to === 'dead' &&
      // 正文写进 Context Builder 的 system，而不是编排器自己拼的
      capturedMsgs[0][0].content.includes('不得擅自改变人物的既有设定') &&
      // 梗概与故事内时间交给调用方写（此刻正文还没落到任何章节上）
      !!wf.chapterMeta &&
      wf.chapterMeta.summary.includes('药庐') &&
      wf.chapterMeta.timelineEnd === '第七天夜里' &&
      // 两个阶段各自一条计费记录
      wf.records.length === 2 &&
      wf.records[0].inputTokens === 100 &&
      wf.records[1].inputTokens === 200 &&
      wf.records[0].usageSource === 'provider' &&
      STAGE_LABELS.write === '写正文'

    out.workflowCommitOk =
      !!wfSu &&
      wfSu.status === 'alive' && // 高风险未确认前，库里的人物状态一个字都不许变
      wfChars.some((c) => c.name === '林昭') &&
      wfSword.length === 1 &&
      wfSword[0].firstChapterId === wfChapter.id &&
      wfQueue.length === 1 &&
      wfQueue[0].entityId === 'seed-su' &&
      wfQueue[0].status === 'pending' &&
      // generationRuns 落库，且章节归属正确（供「本章合计」聚合）
      wfRuns.length === 2 &&
      wfRuns.every((r) => r.chapterId === wfChapter.id && r.priced === true) &&
      aggregateRuns(wfRuns).totalTokens === 380

    // L4b) 证据链：AI 提取的每条记录都要带「出自正文哪句话」。
    //      没有它，用户看到一条错误的人物状态时无从核对；审阅队列里的
    //      高风险项也只能看到「alive → dead」而不知道模型据何判断。
    out.memoryEvidenceOk =
      wfChars.find((c) => c.name === '林昭')?.evidence ===
        '林昭推开门，看见苏九正在碾药。' &&
      wfChars.find((c) => c.name === '林昭')?.sourceChapterId === wfChapter.id &&
      wfChars.find((c) => c.name === '林昭')?.factLayer === 'author-fact' &&
      wfChars.find((c) => c.name === '林昭')?.confirmStatus === 'confirmed' &&
      wfQueue[0].evidence === '苏九伏在案上，已经没了气息。' &&
      wfQueue[0].chapterId === wfChapter.id &&
      // 每次自动入库都有一条 before/after 日志，撤销靠它
      wfLogs.filter((l) => l.op === 'create').length === 3 &&
      wfLogs.every((l) => l.chapterId === wfChapter.id) &&
      wfLogs.some((l) => l.evidence === '林昭推开门，看见苏九正在碾药。')

    // L4c) 撤销最近一次自动入库：删掉「断剑」这条新建，其他记录不受影响；
    //      原日志被标成已撤销，反向日志保留（历史不能凭空少一段）。
    const swordLog = wfLogs.find((l) => l.entity === 'foreshadowing' && l.op === 'create')
    const undoRes = await undoMemoryChange(wfBook.id, swordLog.id)
    const logsAfterUndo = await db.coll.memoryChangeLog.getAll(wfBook.id)
    out.memoryUndoOk =
      !!swordLog &&
      undoRes.ok === true &&
      (await db.coll.foreshadowing.getAll(wfBook.id)).length === 0 &&
      logsAfterUndo.some((l) => l.id === swordLog.id && l.undone === true) &&
      logsAfterUndo.some((l) => l.source === 'undo' && l.undoOf === swordLog.id) &&
      // 撤销一条不得波及同一批入库的其他记录
      (await db.coll.characters.getAll(wfBook.id)).some((c) => c.name === '林昭') &&
      (await db.coll.events.getAll(wfBook.id)).length === 1

    // L4d) 生成记录可复现：提示词版本、请求参数、上下文摘要必须随每次调用落库。
    //      没有它们，「同样的输入这次怎么写得不一样」就分不清是提示词改了、
    //      参数改了，还是模型自己漂了。
    out.generationTraceOk =
      wfRuns.length === 2 &&
      wfRuns.every(
        (r) =>
          r.promptVersion === PROMPT_VERSION &&
          r.params &&
          r.params.temperature === s.settings.temperature &&
          r.params.maxTokens === s.settings.maxTokens &&
          r.contextSummary &&
          r.contextSummary.tokens > 0 &&
          r.contextSummary.budget > 0 &&
          Array.isArray(r.contextSummary.layers) &&
          Array.isArray(r.contextSummary.sources)
      ) &&
      // 写正文那次上下文的来源列表能说清「都装了什么」
      wfRuns.find((r) => r.stage === 'write')?.contextSummary.sources.length > 0

    // L5) 中途中止：不得留下半提交的记忆，但钱要记（已经花出去了）
    const charsBefore = (await db.coll.characters.getAll(wfBook.id)).length
    let abortHandle = null
    let abortRun = null
    const wfAbort = await runChapterWorkflow({
      input: wfInput,
      settings: s.settings,
      chat: fakeChat([{ text: '林昭刚开口，', abort: true }, { text: extractPayload }]),
      recordRun: useGeneration().recordRun,
      callbacks: { onControl: (h) => (abortHandle = h) }
    })
    abortRun = typeof abortHandle?.abort === 'function'
    out.workflowAbortOk =
      abortRun &&
      wfAbort.run.status === 'aborted' &&
      wfAbort.run.stages.map((x) => x.status).join(',') === 'aborted,pending' &&
      wfAbort.output === '林昭刚开口，' &&
      wfAbort.changes.length === 0 &&
      wfAbort.applied.length === 0 &&
      wfAbort.queued.length === 0 &&
      wfAbort.records.length === 1 &&
      // 第二次调用压根没发生：中止就必须真的停下来，不能偷偷把提取跑完
      wfAbort.records[0].stage === 'write' &&
      (await db.coll.characters.getAll(wfBook.id)).length === charsBefore

    // L6) 提取失败不是整次生成的失败：正文已经拿到手了。
    //     模型多说一句「好的」再加围栏 JSON 是常态，所以要重试一次；
    //     两次都解析不出才降级为「本次不提取记忆」。
    const wfBad = await runChapterWorkflow({
      input: wfInput,
      settings: s.settings,
      chat: fakeChat([
        { text: '林昭推开门。', usage: { inputTokens: 10, outputTokens: 5 } },
        { text: '好的，我这就提取。' },
        { text: '很抱歉，我无法完成。' }
      ]),
      recordRun: useGeneration().recordRun
    })
    out.workflowExtractFailOk =
      wfBad.output === '林昭推开门。' &&
      // 整次运行仍是 done：把提取失败标成失败会让用户以为这一章白写了
      wfBad.run.status === 'done' &&
      wfBad.run.stages.map((x) => x.status).join(',') === 'done,error' &&
      wfBad.error.includes('JSON') &&
      wfBad.changes.length === 0 &&
      // 重试确实发生了：write + 两次 extract = 3 次调用，各记一条
      wfBad.records.length === 3

    await b.removeBook(wfBook.id)

    // ------------------------------------------------------------------
    // M) 局域网同步：主进程那一侧的 HTTP 服务
    //
    // 这一段从**渲染进程**发真实网络请求，而不是直接调主进程的函数。
    // 理由：手机端能不能连上，全部取决于 CORS 头与预检有没有发对，
    // 而那两样东西只有真发一次请求才验证得到——直接调函数等于跳过了
    // 这个功能最容易坏的地方。
    //
    // 端口用 0（让系统分配）：测试**不能**去抢 8787，开发机上很可能正开着
    // 一个真的同步服务，那样这条断言就会失败在别人的状态上。
    // ------------------------------------------------------------------
    const syncApi = window.electronAPI
    // 先显式关一次：开发机上可能开着 syncAutoStart，那会让「启动时没有监听」
    // 这条断言失败在一个与本轮改动无关的配置上。
    await syncApi.syncStop()
    const syncBefore = await syncApi.syncStatus()

    const syncUp = await syncApi.syncStart({
      port: 0,
      // 版本号由渲染层报给主进程，/hello 再把它转出去 —— 断言这一路是通的
      hello: { snapshotVersion: SNAPSHOT_VERSION, schemaVersion: SCHEMA_VERSION }
    })
    const syncBase = `http://127.0.0.1:${syncUp.port}`
    const syncCode = String(syncUp.code || '')
    // 造一个**确定**与真码不同的错码：真码本身是随机的，写死 '000000'
    // 有百万分之一的概率恰好撞上，那时「错码应当被拒」就变成了假阴性
    const wrongCode = syncCode === '000000' ? '000001' : '000000'

    out.syncServerUpOk =
      // 「不开服务时没有任何监听」——这是本项目第一个长驻端口的组件，
      // 默认关闭这条必须钉死，否则用户从没点过同步却在对外监听
      syncBefore.running === false &&
      syncBefore.port === 0 &&
      syncUp.ok === true &&
      syncUp.running === true &&
      Number.isInteger(syncUp.port) &&
      syncUp.port > 0 &&
      /^\d{6}$/.test(syncCode) &&
      Array.isArray(syncUp.addresses)

    const syncSt = await syncApi.syncStatus()
    out.syncStatusOk =
      syncSt.running === true && syncSt.port === syncUp.port && syncSt.code === syncCode

    const call = async (path, opts) => {
      try {
        const r = await fetch(syncBase + path, opts)
        let body = null
        try {
          body = await r.json()
        } catch {
          body = null
        }
        return { status: r.status, body, headers: r.headers }
      } catch (e) {
        // 连接被拒 / 被重置也走这里，status 记成 'failed' 供断言区分
        return { status: 'failed', body: null, headers: null, error: String((e && e.message) || e) }
      }
    }
    const jpost = (body, code) => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(code == null ? {} : { 'X-Pair-Code': code })
      },
      body
    })

    const hello = await call('/hello')
    out.syncHelloOk =
      hello.status === 200 &&
      hello.body?.app === 'Novel Studio' &&
      !!hello.body?.version &&
      hello.body?.snapshotVersion === SNAPSHOT_VERSION &&
      hello.body?.schemaVersion === SCHEMA_VERSION &&
      // 没有这个头，Android WebView 里读不到任何响应
      hello.headers.get('access-control-allow-origin') === '*'

    // 预检：Android WebView 的 origin 是 https://localhost，且请求带
    // X-Pair-Code 这个非简单头，所以 OPTIONS 是**必然**发生的
    const pre = await call('/sync', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-pair-code,content-type'
      }
    })
    out.syncPreflightOk =
      pre.status === 204 &&
      pre.headers.get('access-control-allow-origin') === '*' &&
      String(pre.headers.get('access-control-allow-headers') || '')
        .toLowerCase()
        .includes('x-pair-code') &&
      String(pre.headers.get('access-control-allow-methods') || '').includes('POST')

    const noCode = await call('/sync', jpost('{}'))
    const badCode = await call('/sync', jpost('{}', wrongCode))
    const goodCodeBadJson = await call('/sync', jpost('{ nope', syncCode))
    const goodCodeBadShape = await call('/sync', jpost('{"nope":1}', syncCode))
    out.syncAuthOk =
      noCode.status === 401 &&
      noCode.body?.error === 'bad-code' &&
      badCode.status === 401 &&
      badCode.body?.error === 'bad-code' &&
      // 码对了才走得到解析体这一步：400 而不是 401，说明鉴权那一关放行了。
      // 这两条同时把「体校验」也钉住了，而且不必等渲染层的 20 秒应答超时
      goodCodeBadJson.status === 400 &&
      goodCodeBadJson.body?.error === 'bad-json' &&
      goodCodeBadShape.status === 400 &&
      goodCodeBadShape.body?.error === 'bad-snapshot'

    // 服务器只认两条**精确**路径，不接受任何路径参数，其余一律 404
    const notFound = await call('/nope')
    const nearMiss = await call('/hellox')
    out.syncRoutingOk = notFound.status === 404 && nearMiss.status === 404

    // 连错 10 次进冷却。6 位码只有百万种可能，而 `Access-Control-Allow-Origin: *`
    // 意味着用户访问的任意网页都能对这个端口发请求并读到响应，冷却把穷举的成本
    // 抬到没意义。冷却期间**正确码也拒绝**——否则它就不是锁。
    for (let i = 0; i < 10; i++) await call('/sync', jpost('{}', wrongCode))
    const locked = await call('/sync', jpost('{ nope', syncCode))
    const rotated = await syncApi.syncRotateCode()
    const stAfterRotate = await syncApi.syncStatus()
    const afterRotate = await call('/sync', jpost('{ nope', rotated.code))
    out.syncLockoutOk =
      locked.status === 401 &&
      locked.body?.error === 'locked' &&
      rotated.ok === true &&
      /^\d{6}$/.test(String(rotated.code)) &&
      stAfterRotate.code === rotated.code &&
      // 「换一个配对码」同时解锁：被冷却挡住的用户只有这一个自助出口
      afterRotate.status === 400

    // 体上限 64 MB。必须**真的发一个超限的体**，而不是断言某个常量——
    // 「服务器会在读满内存之前就拒绝」这件事只有真发过才知道。
    let bigStatus = 0
    try {
      const r = await fetch(syncBase + '/sync', jpost('x'.repeat(65 * 1024 * 1024), rotated.code))
      bigStatus = r.status
    } catch {
      // **实测（syncBigStatus 记录了真实值）**：客户端还在上传时服务端就把连接
      // 断掉，Chromium 报的是网络错误，交不回那个 413。这正是「先 reject 再
      // destroy」必须保住带宽、代价由客户端承担的地方——所以手机端在上传之前
      // 要自己先看体积（见 src/services/sync.js），不能指望读这个状态码。
      // 两种都算「拒绝了」，但都必须区别于「收下了」。
      bigStatus = 'reset'
    }
    const stillAlive = await call('/hello')
    // 诊断用（不进 out.pass）：它记录的是客户端**实际**看到了什么
    out.syncBigStatus = bigStatus
    out.syncBodyLimitOk =
      (bigStatus === 413 || bigStatus === 'reset') &&
      stillAlive.status === 200 // 拒绝之后服务仍然健康

    const stopped = await syncApi.syncStop()
    const afterStop = await call('/hello')
    const stStopped = await syncApi.syncStatus()
    out.syncStopOk =
      stopped.ok === true &&
      // 端口真的关了：连接直接被拒，而不是「还听者但拒绝请求」
      afterStop.status === 'failed' &&
      stStopped.running === false &&
      stStopped.port === 0 &&
      // 码随服务一起消失，不留在内存里等下一次启动
      stStopped.code === ''
    out.syncPreloadOk =
      typeof syncApi.syncStart === 'function' &&
      typeof syncApi.syncStop === 'function' &&
      typeof syncApi.syncStatus === 'function' &&
      typeof syncApi.syncRotateCode === 'function' &&
      typeof syncApi.syncRespond === 'function' &&
      typeof syncApi.onSyncIncoming === 'function'

    // ------------------------------------------------------------------
    // N) 局域网同步：渲染层这一侧（电脑端合并 + 手机端推送）
    //
    // M 段钉的是 HTTP 层，这一段钉的是「真的有东西被合并进去」。
    //
    // 需要说明的是：这里客户端与服务端是**同一个渲染进程**，所以「本机应用
    // 远端返回的合并结果」那一步必然报 diff = {0,0,0} —— 那是收敛（幂等），
    // 不是测试没生效。真正有意义的差集在 `syncState.lastIncoming.diff`，
    // 它是主进程那一侧（也就是「手机的对手」那一侧）的合并结果。
    // ------------------------------------------------------------------
    const sync2 = await syncApi.syncStart({
      port: 0,
      hello: { snapshotVersion: SNAPSHOT_VERSION, schemaVersion: SCHEMA_VERSION }
    })
    const syncBase2 = `http://127.0.0.1:${sync2.port}`

    // 手机端「测试连接」与地址规范化。用户会把地址填成各种样子，
    // 而认不出来时必须给一句能照着改的话，不能让请求发到一个空 origin 上。
    out.syncUrlOk =
      normalizeSyncUrl('192.168.1.5:8787') === 'http://192.168.1.5:8787' &&
      normalizeSyncUrl('192.168.1.5') === `http://192.168.1.5:${defaultSettings.syncPort}` &&
      normalizeSyncUrl('http://192.168.1.5:9000') === 'http://192.168.1.5:9000' &&
      // 别的协议在这条路径上没有任何正当用途。这两条**必须**是空串而不是
      // 一个被补成 `http://file:8787` 的假地址 —— 后者语法合法、连不上，
      // 用户拿着它只会反复重试。
      normalizeSyncUrl('file:///C:/Windows/System32') === '' &&
      normalizeSyncUrl('ftp://192.168.1.5') === '' &&
      // 端口超范围由 URL 自己判死，同样回到「填得不对」那句提示
      normalizeSyncUrl('192.168.1.5:99999') === '' &&
      normalizeSyncUrl('') === '' &&
      normalizeSyncUrl('   ') === ''

    const connOk = await testConnection(`127.0.0.1:${sync2.port}`)
    const connDead = await testConnection('127.0.0.1:1')
    const connBad = await testConnection('not a host@@')
    out.syncTestConnectionOk =
      connOk.ok === true &&
      connOk.info?.protocol === 'novel-studio-sync' &&
      connOk.info?.snapshotVersion === SNAPSHOT_VERSION &&
      connDead.ok === false &&
      connBad.ok === false

    const syncBook = await b.createBook({ title: '测试小说' })
    const ch1 = await b.addChapterWithContent('第一章的正文', '第一章')
    const ch2 = await b.addChapterWithContent('第二章的正文', '第二章')
    b.selectChapter(ch2.id)
    out.syncCursorPrepOk = b.store.chapterId === ch2.id

    // 手造一份远端快照，**只放三样东西**，这样每条断言都能指认到底是谁造成的：
    //   1) 一本与本地完全相同的书（连时间戳都相同）→ 平局，本地赢，updated 应为 0
    //   2) 一条远端独有的章节 → added
    //   3) ch1 的墓碑 → removed。这是整条同步链路里最容易做错的一条：
    //      「远端有一条我这边没有的记录」与「远端要删掉我这边的一条记录」
    //      在快照里长得很不一样（后者是一条墓碑，不是「缺少记录」）。
    const remoteSnap = buildSnapshot({
      books: [{ ...b.store.book }],
      data: {
        [syncBook.id]: {
          chapters: [
            {
              id: 'remote-ch-1',
              bookId: syncBook.id,
              title: '远端加的章',
              content: '来自另一台设备',
              order: 99,
              updatedAt: Date.now()
            }
          ],
          tombstones: [{ id: ch1.id, type: 'chapters', deletedAt: Date.now() + 5000 }]
        }
      }
    })

    const push1 = await pushSnapshot(syncBase2, sync2.code, { snapshot: remoteSnap })
    const liveIds = (await db.getChapters(syncBook.id)).map((c) => c.id)
    out.syncRoundTripOk =
      push1.ok === true &&
      // 合并结果：远端多一章、本地被墓碑删掉一章，且**没有**把平局的那本书算成更新
      syncState.lastIncoming?.diff?.added === 1 &&
      syncState.lastIncoming?.diff?.updated === 0 &&
      syncState.lastIncoming?.diff?.removed === 1 &&
      liveIds.includes('remote-ch-1') &&
      !liveIds.includes(ch1.id) &&
      liveIds.includes(ch2.id) &&
      // 内存态跟着库走：applySnapshot 只写库、完全不碰 store，漏掉 reloadAfterSync
      // 的表现就是「同步完了界面还是旧的，重启才变」
      b.store.chapters.length === 2 &&
      !b.store.chapters.some((c) => c.id === ch1.id) &&
      b.store.chapters.some((c) => c.id === 'remote-ch-1') &&
      // 光标保住了：openBook() 会把 chapterId 重置成第一章。用户在第 12 章写作时
      // 被同步打断、正文突然跳到第 1 章，是比「界面没刷新」更糟的表现。
      b.store.chapterId === ch2.id

    // 再发一次同一份。两侧此时已经收敛，于是本机这一侧无事可做。
    // 这条才是幂等的证明 —— 没有它，「每次都全量重写一遍」也能让上面全绿。
    const push2 = await pushSnapshot(syncBase2, sync2.code, { snapshot: remoteSnap })
    out.syncIdempotentOk =
      push2.ok === true &&
      push2.diff.added === 0 &&
      push2.diff.updated === 0 &&
      push2.diff.removed === 0

    // N2) 同章冲突：两台设备**都改过**同一章且正文不同 → 不静默丢弃任何一边。
    //
    // 判定需要基线，所以要分两轮：
    //   ① 先同步一次两边内容相同的 ch2 —— 只建基线，不报冲突（首次同步误报
    //      会让每一对本来就不一样的章都被复制一份，是一场噪声灾难）；
    //   ② 两边分别改动 ch2 后再同步 —— 主章保留电脑版本，手机版本另存
    //      「【冲突副本】」，并写一条 syncConflicts 记录供两端处理。
    const peersBefore = await db.getSyncPeers()
    const conflictSettingBefore = s.settings.syncConflictCopies
    s.settings.syncConflictCopies = true
    // 上一次运行若中途崩过，真实库里可能残留同一台测试设备的基线。
    // 先摘掉再建，否则「首次同步不误报」这一条会失败在一个陈旧时间戳上。
    const peersClean = { ...peersBefore }
    delete peersClean['smoke-device-B']
    await db.saveSyncPeers(peersClean)

    const baseCh2 = (await db.getChapters(syncBook.id)).find((c) => c.id === ch2.id)
    const baseTime = baseCh2.updatedAt
    const baselineSnap = buildSnapshot({
      books: [{ ...b.store.book }],
      deviceId: 'smoke-device-B',
      data: {
        [syncBook.id]: {
          chapters: [{ ...baseCh2 }]
        }
      }
    })
    const baselinePush = await pushSnapshot(syncBase2, sync2.code, { snapshot: baselineSnap })
    const copiesAfterBaseline = (await db.getChapters(syncBook.id)).filter((c) =>
      String(c.title || '').startsWith(CONFLICT_TITLE_PREFIX)
    ).length

    // 电脑端（本机）先改；时间戳一定晚于基线
    await db.upsertChapter(syncBook.id, {
      ...baseCh2,
      content: '电脑端修改后的第二章',
      updatedAt: baseTime + 10
    })
    // 手机端也改。用 baseTime + 1 而不是「未来时间」：随后电脑端会把主章的
    // 时间戳抬到 Date.now()，第二轮同步才能稳定地让主章继续赢。
    const conflictSnap = buildSnapshot({
      books: [{ ...b.store.book }],
      deviceId: 'smoke-device-B',
      data: {
        [syncBook.id]: {
          chapters: [
            {
              ...baseCh2,
              content: '手机端修改后的第二章',
              updatedAt: baseTime + 1
            }
          ]
        }
      }
    })
    const conflictPush = await pushSnapshot(syncBase2, sync2.code, { snapshot: conflictSnap })
    const afterConflict = await db.getChapters(syncBook.id)
    const mainCh2 = afterConflict.find((c) => c.id === ch2.id)
    const copyChapters = afterConflict.filter((c) => !!c.conflictOf)
    const conflictRecs = await db.coll.syncConflicts.getAll(syncBook.id)
    const openRecs = conflictRecs.filter((r) => r.status === 'open')

    out.syncConflictCopyOk =
      baselinePush.ok === true &&
      copiesAfterBaseline === 0 &&
      conflictPush.ok === true &&
      conflictPush.conflicts >= 1 &&
      syncState.lastIncoming?.conflicts >= 1 &&
      mainCh2?.content === '电脑端修改后的第二章' &&
      copyChapters.length === 1 &&
      copyChapters[0].content === '手机端修改后的第二章' &&
      String(copyChapters[0].title || '').startsWith(CONFLICT_TITLE_PREFIX) &&
      copyChapters[0].conflictOf === ch2.id &&
      openRecs.length === 1 &&
      openRecs[0].chapterId === ch2.id &&
      openRecs[0].copyChapterId === copyChapters[0].id

    // 重放同一份远端快照：确定性 id + 远端时间戳让副本不会每同步一次多一份。
    const conflictAgain = await pushSnapshot(syncBase2, sync2.code, { snapshot: conflictSnap })
    const afterAgain = await db.getChapters(syncBook.id)
    out.syncConflictIdempotentOk =
      conflictAgain.ok === true &&
      afterAgain.filter((c) => !!c.conflictOf).length === 1 &&
      (await db.coll.syncConflicts.getAll(syncBook.id)).length === 1 &&
      afterAgain.find((c) => c.id === ch2.id)?.content === '电脑端修改后的第二章'

    // N3) 数据版本不一致：同步是**双向写入**，不允许「半懂不懂」地合并。
    //     低版本必须被明确拒绝（high 版在 normalizeSnapshot 就会被挡）。
    const chaptersBeforeMismatch = (await db.getChapters(syncBook.id)).length
    const lowerSnap = buildSnapshot({
      books: [{ ...b.store.book }],
      deviceId: 'smoke-device-C',
      data: { [syncBook.id]: { chapters: [{ ...mainCh2, content: '旧版本设备的正文' }] } }
    })
    lowerSnap.schemaVersion = Math.max(0, SCHEMA_VERSION - 1)
    const lowerRes = await handleIncomingSnapshot(lowerSnap)
    const higherSnap = buildSnapshot({ books: [], data: {}, deviceId: 'smoke-device-D' })
    higherSnap.schemaVersion = SCHEMA_VERSION + 1
    const higherRes = await handleIncomingSnapshot(higherSnap)
    out.syncSchemaRejectOk =
      lowerRes.ok === false &&
      lowerRes.code === 'schema-mismatch' &&
      higherRes.ok === false &&
      /版本/.test(higherRes.message || '') &&
      (await db.getChapters(syncBook.id)).length === chaptersBeforeMismatch

    // 收尾：还原开发者自己的 peer 基线与设置，别把测试的对端留在真实库里
    await db.saveSyncPeers(peersBefore)
    s.settings.syncConflictCopies = conflictSettingBefore

    // 生成中不许同步：合并是 saveChapters 整组回写，与流式写入抢同一个键，
    // 撞上就是一次静默丢稿。挡住它的代价只是让对面稍后重试，所以这条边界
    // 得真的走一遍 409，而不是只在注释里写着。
    const genSync = useGeneration()
    genSync.store.running = true
    const busyRes = await pushSnapshot(syncBase2, sync2.code, { snapshot: remoteSnap })
    genSync.store.running = false
    out.syncBusyOk =
      busyRes.ok === false &&
      busyRes.code === 'busy' &&
      // 挡住之后服务还活着，不能是「拒了一次就废了」
      (await testConnection(`127.0.0.1:${sync2.port}`)).ok === true

    // 安全断言：API Key 永不出本机。
    // 快照读的是 books / chapters / outlines / 集合 / 墓碑，里面**没有 settings** ——
    // 这不是「碰巧没有」，是有意划下的边界，所以必须钉死。
    const SECRET = 'sk-smoke-must-never-leave-this-machine'
    const savedKey = s.settings.apiKey
    s.settings.apiKey = SECRET
    const snapText = toSnapshotJson(await collectSnapshot())
    s.settings.apiKey = savedKey
    out.snapshotNoApiKeyOk = !snapText.includes(SECRET) && !snapText.includes('apiKey')

    await syncApi.syncStop()

    // ------------------------------------------------------------------
    // O) WebDAV 同步：走完整的 IPC → 主进程 davRequest → net.fetch → 内存
    //    WebDAV 服务器。不直接调主进程函数，理由与上面局域网同步那段一样：
    //    认证头、路径拼装、ETag 条件请求都是「只有真发一次才验证得到」的。
    // ------------------------------------------------------------------
    {
      const wd = window.__nsSmokeWebdav
      const wdBase = wd?.baseUrl || ''
      out.webdavMockAvailableOk =
        !!wdBase && (await window.electronAPI.webdavRequest({
          baseUrl: 'not-a-url',
          path: '/x',
          method: 'GET'
        })).code === 'EINVAL'

      const peersBeforeWd = await db.getSyncPeers()
      const wdPassword = 'smoke-webdav-pass-123'
      s.settings.webdav = {
        enabled: true,
        url: wdBase,
        username: 'smoke',
        remoteDir: 'smoke',
        autoSync: false,
        intervalSec: 300,
        conflictCopies: true,
        timeoutSec: 10,
        lastSyncAt: 0,
        lastStatus: 'idle',
        lastError: '',
        lastEtag: ''
      }

      // 1) 测试连接：目录不存在 → 自动创建 → 再探一次成功
      const wdTest = await testWebdav({ password: wdPassword })
      out.webdavMockConnectOk = wdTest.ok === true && wdTest.created === true

      // 2) 第一次同步：没有对端，只有自己的文件被上传
      const wd1 = await syncWithWebdav({ password: wdPassword, flush: async () => {} })
      const deviceId = await db.getDeviceId()
      out.webdavMockUploadOk =
        wd1.ok === true &&
        wd1.stats.added >= 0 &&
        s.settings.webdav.lastStatus === 'ok' &&
        !!s.settings.webdav.lastEtag &&
        !!deviceId &&
        !('password' in s.settings.webdav)

      // 3) 模拟另一台设备已上传自己的快照（新书 + 一章），再同步应当合并进来
      const peerBook = {
        id: 'webdav-peer-book',
        title: '测试小说', // 与清理规则一致，收尾时会被 removeBook 一并处理
        intro: '来自 WebDAV 对端',
        coverColor: '#4a90d9',
        plan: {},
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000
      }
      const peerSnap = buildSnapshot({
        books: [peerBook],
        deviceId: 'smoke-webdav-peer',
        deviceName: '测试对端设备',
        data: {
          [peerBook.id]: {
            chapters: [
              {
                id: 'webdav-peer-ch1',
                bookId: peerBook.id,
                title: '对端第一章',
                content: '这段正文只存在于 WebDAV 对端。',
                order: 1,
                updatedAt: Date.now() - 1000
              }
            ]
          }
        }
      })
      const peerPut = await window.electronAPI.webdavRequest({
        baseUrl: wdBase,
        path: '/smoke/smoke-webdav-peer.json',
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(peerSnap),
        username: 'smoke',
        password: wdPassword,
        timeoutSec: 10
      })
      const wd2 = await syncWithWebdav({ password: wdPassword, flush: async () => {} })
      const peerBookInDb = (await db.getBooks()).find((x) => x.id === peerBook.id)
      const peerChapterInDb = (await db.getChapters(peerBook.id)).find(
        (c) => c.id === 'webdav-peer-ch1'
      )
      out.webdavMockPullMergeOk =
        peerPut.ok === true &&
        wd2.ok === true &&
        wd2.stats.added >= 2 &&
        !!peerBookInDb &&
        !!peerChapterInDb &&
        wd2.peers.includes('测试对端设备') &&
        b.store.books.some((x) => x.id === peerBook.id)

      // 4) ETag 冲突：本机上传后，别人的进程改了「本机那个文件」。
      //    下一次上传带着旧 ETag 必然 412；必须重新拉取合并、取新 ETag 再传，
      //    而不是把 412 当成一次失败就结束。
      const ownPath = '/smoke/' + encodeURIComponent(deviceId) + '.json'
      const overwrite = await window.electronAPI.webdavRequest({
        baseUrl: wdBase,
        path: ownPath,
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(peerSnap),
        username: 'smoke',
        password: wdPassword,
        timeoutSec: 10
      })
      const wd3 = await syncWithWebdav({ password: wdPassword, flush: async () => {} })
      out.webdavMockEtagConflictRetryOk =
        overwrite.ok === true &&
        wd3.ok === true &&
        wd3.retries === 1 &&
        wd3.warnings.some((x) => x.includes('重新合并'))

      // 5) 生成中拒绝同步（与局域网同步同一条边界），但不算失败
      const genWd = useGeneration()
      genWd.store.running = true
      const wdBusy = await syncWithWebdav({ password: wdPassword, flush: async () => {} })
      genWd.store.running = false
      out.webdavBusyRejectedOk =
        wdBusy.ok === true && wdBusy.skipped === 'busy' && wdBusy.stats === undefined

      // 6) 密码与 API Key 都不许出现在远端快照里
      const own = await window.electronAPI.webdavRequest({
        baseUrl: wdBase,
        path: ownPath,
        method: 'GET',
        username: 'smoke',
        password: wdPassword,
        timeoutSec: 10
      })
      const SECRET_WD = 'sk-webdav-must-never-leave'
      const savedKeyWd = s.settings.apiKey
      s.settings.apiKey = SECRET_WD
      const localSnapText = toSnapshotJson(await collectSnapshot())
      s.settings.apiKey = savedKeyWd
      out.webdavSecretNotInSnapshotOk =
        own.ok === true &&
        own.status === 200 &&
        !own.body.includes(wdPassword) &&
        !own.body.includes('webdavPassword') &&
        !own.body.includes(SECRET_WD) &&
        !localSnapText.includes(SECRET_WD) &&
        !localSnapText.includes('webdavPassword')

      // 7) 状态文案能按 lastStatus 说人话
      const wdState = describeWebdavState(s.settings.webdav, Date.now())
      out.webdavStateLabelOk =
        wdState.status === 'ok' && wdState.label === '同步成功' && wdState.when === '刚刚'

      // 收尾：还原 peer 基线（WebDAV 的对端基线会写进真实库）
      await db.saveSyncPeers(peersBeforeWd)
      await b.removeBook(peerBook.id)
    }

    // ------------------------------------------------------------------
    // P) 声明式插件：目录隔离 + 四个 hook 的接入点
    //    主进程在 SMOKE_TEST 下把插件目录指向 %TEMP%\novel-studio-smoke\plugins，
    //    里面有三种文件：一个合法清单、一个坏 JSON、一个坏清单。
    //    「坏文件只影响它自己」这条纪律只有真的放三个文件才验得到。
    // ------------------------------------------------------------------
    {
      const plugDir = window.__nsSmokePluginsDir || ''
      const listed = await window.electronAPI.pluginsList()
      const norm = listed?.ok ? normalizePluginList(listed.files) : { manifests: [], errors: [] }

      out.pluginListIsolationOk =
        !!plugDir &&
        listed?.ok === true &&
        listed.dir === plugDir &&
        /novel-studio-smoke/.test(listed.dir) &&
        // 合法 1 个 + 坏 JSON + 坏清单各报一条错误，互不影响
        norm.manifests.length === 1 &&
        norm.errors.length === 2 &&
        norm.manifests[0].id === 'smoke-plugin' &&
        norm.manifests[0].hooks.contextFragments.length === 1 &&
        norm.manifests[0].hooks.rules.length === 1 &&
        norm.manifests[0].hooks.exportTemplates.length === 1 &&
        norm.manifests[0].hooks.keywordHints.length === 1

      // store 只读插件目录，不落库：load() 成功后 pluginState 就是它读到的东西
      const plugins = usePlugins()
      const loadRes = await plugins.load()
      out.pluginStoreLoadOk =
        loadRes.ok === true &&
        pluginState.manifests.length === 1 &&
        pluginState.errors.length === 2 &&
        pluginState.unsupported === false

      // 1) Context Builder：启用片段时出现 pluginContext 层，关掉时不出现。
      //    与其它层共用同一套预算与排序，所以这里验的是「层真的进了上下文」。
      const pFrags = plugins.fragments()
      const pCtx = buildContext(kInput({ pluginFragments: pFrags }), 6000)
      const pLayer = pCtx.metadata.layers.find((l) => l.id === 'pluginContext')
      out.pluginContextLayerOk =
        pFrags.length === 1 &&
        !!pLayer &&
        pLayer.tokens > 0 &&
        !pLayer.dropped &&
        pCtx.context.includes('每章至少出现一次雨声') &&
        pLayer.items === 1 &&
        pLayer.itemsDetail.some((i) => i.source.includes('冒烟插件'))

      s.settings.plugins.enabled = false
      const pFragsOff = plugins.fragments()
      const pCtxOff = buildContext(kInput({ pluginFragments: pFragsOff }), 6000)
      s.settings.plugins.enabled = true
      out.pluginDisabledNoLayerOk =
        pFragsOff.length === 0 &&
        !pCtxOff.metadata.layers.some((l) => l.id === 'pluginContext')

      // 2) 一致性：插件问题并入同一份报告，source 标成 plugin；
      //    没有插件规则时，干净数据仍然 0 条（consistencyCleanOk 的同一口径）。
      const pChapters = [
        { id: 'plugin-ch-1', order: 1, title: '雨夜', content: '院墙外传来雨声，这里有个禁词。' }
      ]
      const pIssues = plugins.issues(pChapters)
      const pReport = runRuleChecks({ chapters: pChapters, pluginRules: pIssues })
      const pClean = runRuleChecks({ chapters: pChapters, pluginRules: [] })
      out.pluginRuleIssueOk =
        pIssues.length === 1 &&
        pIssues[0].source === 'plugin' &&
        pIssues[0].severity === 'medium' &&
        pIssues[0].rule === 'plugin:smoke-plugin:taboo-word' &&
        pReport.issues.some((i) => i.source === 'plugin') &&
        pReport.stats.plugin === 1 &&
        pClean.stats.plugin === 0 &&
        !pClean.issues.some((i) => i.source === 'plugin')

      // 3) 导出模板：只做占位符替换，未知占位符原样保留，输出必须是纯文本
      const pTpls = plugins.templates()
      const pRendered = pTpls.length
        ? renderExportTemplate(pTpls[0].template, {
            book: { title: '测试小说' },
            chapters: [{ order: 1, title: '雨夜', content: '雨声落在瓦上。' }],
            date: new Date(2026, 9, 24)
          })
        : ''
      out.pluginTemplateExportOk =
        pTpls.length === 1 &&
        pTpls[0].key === 'smoke-plugin:simple' &&
        pTpls[0].ext === 'txt' &&
        pRendered.includes('《测试小说》') &&
        pRendered.includes('共 1 章') &&
        pRendered.includes('第1章 雨夜') &&
        pRendered.includes('2026-10-24') &&
        renderExportTemplate('{{titel}}', {}) === '{{titel}}'

      // 4) 关键词提示只显示、不自动进提示词；关掉插件后什么都不给
      const pHints = plugins.hints('雨声淅沥')
      s.settings.plugins.disabledIds = ['smoke-plugin']
      const pOff = {
        fragments: plugins.fragments().length,
        issues: plugins.issues(pChapters).length,
        templates: plugins.templates().length,
        hints: plugins.hints('雨声淅沥').length
      }
      s.settings.plugins.disabledIds = []
      out.pluginKeywordHintOk =
        pHints.length === 1 &&
        pHints[0].hint.includes('雨声') &&
        pHints[0].matched.includes('雨声')
      out.pluginDisabledOk =
        pOff.fragments === 0 && pOff.issues === 0 && pOff.templates === 0 && pOff.hints === 0

      // 5) 插件设置不进快照（与 API Key 同一条边界）：
      //    快照里既没有 settings，也不该出现插件目录/黑名单这类本机配置。
      const pSnapText = toSnapshotJson(await collectSnapshot())
      out.pluginSettingsNotInSnapshotOk =
        !pSnapText.includes('"plugins"') &&
        !pSnapText.includes('contextBudget') &&
        !pSnapText.includes('disabledIds') &&
        !pSnapText.includes(plugDir)
    }

    await b.removeBook(syncBook.id)

    // 收尾：把新增的设置键复位，别把开发者留在一个会被静默改写的配置上
    await resetSettings()
    // 整书墓碑同上：本节 H 也删了一本书，这里一并清掉
    await db.rawDelete('bookTombstones')

    out.pass =
      out.saveDirDefaults &&
      out.settingsBackfill &&
      out.secureKeyMigrationOk &&
      out.secureKeyReadOk &&
      out.settingsNoPlaintextKey &&
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
      out.pointerDeriveOk &&
      out.pointerPersistOk &&
      out.pointerKeepsBookUpdatedAtOk &&
      out.pointerRestoreOnOpenOk &&
      out.pointerSurvivesSyncReloadOk &&
      out.pointerFallbackAfterDeleteOk &&
      out.collCrudOk &&
      out.collTimestampsOk &&
      out.collTombstoneOk &&
      out.chapterDeleteTombstoneOk &&
      out.chapterWordCountOk &&
      out.wordCountOk &&
      out.collGuardOk &&
      out.collSerializedOk &&
      out.pricingNormalizeOk &&
      out.pricingLookupOk &&
      out.costMathOk &&
      out.generationRunPersisted &&
      out.structureOrderOk &&
      out.collCascadeOk &&
      out.bookTombstoneOk &&
      out.migrationPlanOk &&
      out.migrationAppliedOk &&
      out.migrationNoDestroyOk &&
      out.migrationIdempotentOk &&
      out.migrationDedupOk &&
      out.schemaVersionOk &&
      out.contextBudgetOk &&
      out.contextDropOk &&
      out.contextNoDupOk &&
      out.contextMessagesOk &&
      out.legacyPromptUnchanged &&
      out.mergeSnapshotOk &&
      out.snapshotCollectOk &&
      out.snapshotRoundTripOk &&
      out.snapshotParseOk &&
      out.snapshotChecksumOk &&
      out.snapshotCloneOk &&
      out.snapshotExcludesTasksOk &&
      out.preRestoreKeyOk &&
      out.snapshotStatsOk &&
      out.versionCaptureOk &&
      out.versionRestoreOk &&
      out.versionPruneOk &&
      out.versionDeleteRecoverOk &&
      out.versionGroupOk &&
      out.versionSyncOk &&
      out.timelineOrderOk &&
      out.timelineWarnOk &&
      out.timelineOverdueClearsOk &&
      out.consistencyRuleOk &&
      out.consistencyCleanOk &&
      out.consistencyEmptyOk &&
      out.consistencyReviewOk &&
      out.consistencyReviewNoPersistOk &&
      out.planCardOk &&
      out.planProposalOk &&
      out.diffOk &&
      out.planAiDraftOk &&
      out.planValidateWiredIntoStagePlanOk &&
      out.planValidateBlockSaveOk &&
      out.planValidateOverrideSavesOk &&
      out.queueEnqueuePersistOk &&
      out.queueBlocksSyncOk &&
      out.queueSerialRunOk &&
      out.queueNoAutoWriteOk &&
      out.queueResultInsertOk &&
      out.queueFailureKeepsTextOk &&
      out.queueRecoveryOk &&
      out.ragIndexChapterOk &&
      out.ragIncrementalReplaceOk &&
      out.ragDeleteChapterCleanupOk &&
      out.ragLayerInContextOk &&
      out.ragDisabledNoLayerOk &&
      out.graphCharacterNodesOk &&
      out.graphFactionLeaderEdgeOk &&
      out.graphEventCooccurrenceOk &&
      out.graphTextRelationshipConservativeOk &&
      out.graphNoDanglingEdgesOk &&
      out.graphLayoutDeterministicOk &&
      out.fixDraftOk &&
      out.fixAcceptOk &&
      out.uiCardFound &&
      out.uiWritingMounted &&
      out.queuePanelMountOk &&
      out.draftRecoveryOk &&
      out.draftLoadOk &&
      out.pagehideFlushOk &&
      out.uiFindBar &&
      out.versionPanelMountOk &&
      out.versionRestoreUiOk &&
      out.uiBackToShelf &&
      out.aiPanelUsageOk &&
      out.aiPanelUsageDetailOk &&
      out.searchButtonFound &&
      out.searchModalOk &&
      out.searchHitOk &&
      out.searchJumpOk &&
      out.searchEntityOpenOk &&
      out.consoleButtonFound &&
      out.consoleMountOk &&
      out.consoleTabsOk &&
      out.consoleStyleStatsOk &&
      out.consoleRagPanelOk &&
      out.graphTabBadgeOk &&
      out.graphRenderOk &&
      out.graphFilterOk &&
      out.graphClickDetailOk &&
      out.consoleHistoryOk &&
      out.consoleVersionsOk &&
      out.versionCompareUiOk &&
      out.timelineMountOk &&
      out.timelineTableOk &&
      out.consistencyMountOk &&
      out.consoleCloseOk &&
      out.backupButtonFound &&
      out.backupModalOk &&
      out.backupModalClosed &&
      out.versionKeepPanelOk &&
      out.webdavPanelOk &&
      out.pluginPanelOk &&
      out.pluginListIsolationOk &&
      out.pluginStoreLoadOk &&
      out.pluginContextLayerOk &&
      out.pluginDisabledNoLayerOk &&
      out.pluginRuleIssueOk &&
      out.pluginTemplateExportOk &&
      out.pluginKeywordHintOk &&
      out.pluginDisabledOk &&
      out.pluginSettingsNotInSnapshotOk &&
      out.syncPanelOk &&
      out.syncPanelToggleOk &&
      out.syncPanelOffOk &&
      out.settingsModalClosed &&
      out.uiNoSwallowedErrors &&
      out.streamIpc &&
      out.streamError &&
      out.streamBrowser &&
      out.errorObjectOk &&
      out.serverErrorCategoryOk &&
      out.retryOnceOk &&
      out.authNoRetryOk &&
      out.truncatedOk &&
      out.streamErrorBlockOk &&
      out.backoffOk &&
      out.parseOk &&
      out.usageParseOk &&
      out.streamUsageIpc &&
      out.streamUsageBrowser &&
      out.streamUsageOff &&
      out.unpricedHonestOk &&
      out.extractJsonOk &&
      out.riskClassifyOk &&
      out.diffMemoryOk &&
      out.workflowSyncAbortOk &&
      out.workflowOk &&
      out.workflowCommitOk &&
      out.memoryEvidenceOk &&
      out.memoryUndoOk &&
      out.generationTraceOk &&
      out.workflowAbortOk &&
      out.workflowExtractFailOk &&
      out.syncServerUpOk &&
      out.syncStatusOk &&
      out.syncHelloOk &&
      out.syncPreflightOk &&
      out.syncAuthOk &&
      out.syncRoutingOk &&
      out.syncLockoutOk &&
      out.syncBodyLimitOk &&
      out.syncStopOk &&
      out.syncPreloadOk &&
      out.syncUrlOk &&
      out.syncTestConnectionOk &&
      out.syncCursorPrepOk &&
      out.syncRoundTripOk &&
      out.syncIdempotentOk &&
      out.syncConflictCopyOk &&
      out.syncConflictIdempotentOk &&
      out.syncSchemaRejectOk &&
      out.syncBusyOk &&
      out.snapshotNoApiKeyOk &&
      out.webdavMockAvailableOk &&
      out.webdavMockConnectOk &&
      out.webdavMockUploadOk &&
      out.webdavMockPullMergeOk &&
      out.webdavMockEtagConflictRetryOk &&
      out.webdavBusyRejectedOk &&
      out.webdavSecretNotInSnapshotOk &&
      out.webdavStateLabelOk

    // 断言计数：以 out 上的具名断言为准。pass / error / 本字段与诊断项不算。
    // 这样 README / CLAUDE.md 里的数字可以直接引用真实值，不必手工维护。
    out.assertionCount = Object.keys(out).filter(
      (k) => !['pass', 'error', 'assertionCount', 'syncBigStatus'].includes(k)
    ).length
  } catch (e) {
    out.error = String((e && e.stack) || e)
    out.pass = false
  }
  return out
})()
