import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAutosaver,
  SAVE_STATES,
  DEFAULT_RETRY_DELAYS
} from '../../src/services/autosave.js'

const noSleep = async () => {}

test('保存成功：dirty → saving → saved，且落的是调度时的目标 id', async () => {
  const states = []
  const persisted = []
  const saver = createAutosaver({
    persist: async (id) => {
      persisted.push(id)
    },
    onState: (s, meta) => states.push({ s, id: meta?.id }),
    sleep: noSleep
  })

  saver.schedule('ch-a')
  assert.equal(saver.getState(), 'dirty')
  const res = await saver.flush()

  assert.deepEqual(res, { ok: true, id: 'ch-a', attempt: 0 })
  assert.deepEqual(persisted, ['ch-a'])
  assert.deepEqual(
    states.map((x) => x.s),
    ['dirty', 'saving', 'saved']
  )
  assert.equal(saver.getState(), 'saved')
  assert.equal(saver.getPendingId(), null)
})

test('写入失败会按注入的退避重试同一目标，成功后回到 saved', async () => {
  let calls = 0
  const states = []
  const saver = createAutosaver({
    persist: async () => {
      calls++
      if (calls < 3) throw new Error('磁盘忙')
    },
    retryDelays: [5, 10],
    onState: (s, meta) => states.push({ s, attempt: meta?.attempt, retry: !!meta?.retrying }),
    sleep: noSleep
  })

  saver.schedule('ch-1')
  const res = await saver.flush()

  assert.equal(res.ok, true)
  assert.equal(res.attempt, 2)
  assert.equal(calls, 3)
  assert.equal(saver.getState(), 'saved')
  // 每次重试前都要让界面知道「还在重试」，否则用户看到的只是卡在保存中
  assert.equal(states.filter((x) => x.retry).length, 2)
})

test('重试耗尽进入 failed，retry() 可以重新尝试并恢复', async () => {
  let fail = true
  let errors = 0
  const saver = createAutosaver({
    persist: async () => {
      if (fail) throw new Error('配额不足')
    },
    retryDelays: [1],
    sleep: noSleep,
    onError: () => errors++
  })

  saver.schedule('ch-x')
  const first = await saver.flush()
  assert.equal(first.ok, false)
  assert.equal(saver.getState(), 'failed')
  assert.equal(saver.getFailedId(), 'ch-x')
  assert.equal(errors, 1)

  fail = false
  const second = await saver.retry()
  assert.equal(second.ok, true)
  assert.equal(saver.getState(), 'saved')
  assert.equal(saver.getFailedId(), null)
})

test('旧目标在目标切换后是安全的：新调度立刻清空挂起与失败态', async () => {
  const persisted = []
  let release
  const gate = new Promise((r) => (release = r))
  const saver = createAutosaver({
    persist: async (id) => {
      persisted.push(id)
      if (id === 'old') await gate
    },
    sleep: noSleep
  })

  saver.schedule('old')
  const first = saver.flush()
  // 第一个写入还没完成时切到新章：新目标不能丢，也不能被旧写入的成功回调标成已保存
  saver.schedule('new')
  release()
  await first
  await saver.flush()

  assert.deepEqual(persisted, ['old', 'new'])
  assert.equal(saver.getState(), 'saved')
})

test('cancel 清空挂起并回到 idle', async () => {
  const persisted = []
  const saver = createAutosaver({
    persist: async (id) => persisted.push(id),
    sleep: noSleep
  })
  saver.schedule('a')
  saver.cancel()
  await saver.flush()
  assert.deepEqual(persisted, [])
  assert.equal(saver.getState(), 'idle')
})

test('状态机常量与默认退避保持文档口径', () => {
  assert.deepEqual(SAVE_STATES, ['idle', 'dirty', 'saving', 'saved', 'failed'])
  assert.deepEqual(DEFAULT_RETRY_DELAYS, [800, 1600, 3200])
})

test('empty flush 是 no-op（切章时不必为无事可做等一个往返）', async () => {
  const saver = createAutosaver({ persist: async () => {}, sleep: noSleep })
  const res = await saver.flush()
  assert.equal(res.ok, true)
  assert.equal(res.skipped, true)
})
