'use strict'

/**
 * 校验 README 截图确实存在且是有效的 PNG。
 *
 * 只做四件事：存在、PNG 魔数、1440×900、体积下限。
 * 不进 CI —— 截图是人工产物，CI 里没有 GUI 就生成不了；
 * 但这个脚本让「改了截图却没提交」「提交了一张 404 占位图」这两种
 * 情况在本地就能被发现。
 */

const fs = require('fs')
const path = require('path')

const DOCS = path.join(__dirname, '..', 'docs')
const EXPECTED = [
  'shelf.png',
  'editor.png',
  'story-console.png',
  'memory.png',
  'timeline.png',
  'foreshadowing.png',
  'ai-workflow.png'
]
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MIN_BYTES = 20 * 1024
const WIDTH = 1440
const HEIGHT = 900

let failed = 0
for (const name of EXPECTED) {
  const file = path.join(DOCS, name)
  const fail = (msg) => {
    failed++
    console.error(`✗ ${name}：${msg}`)
  }
  if (!fs.existsSync(file)) {
    fail('文件不存在（先运行 npm run screenshots）')
    continue
  }
  const buf = fs.readFileSync(file)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('不是有效的 PNG（魔数不匹配）')
    continue
  }
  // IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (width !== WIDTH || height !== HEIGHT) {
    fail(`尺寸是 ${width}×${height}，应为 ${WIDTH}×${HEIGHT}`)
    continue
  }
  if (buf.length < MIN_BYTES) {
    fail(`只有 ${(buf.length / 1024).toFixed(1)}KB，界面可能没渲染出来`)
    continue
  }
  console.log(`✓ ${name}  ${width}×${height}  ${(buf.length / 1024).toFixed(1)}KB`)
}

if (failed) {
  console.error(`\n${failed} 张截图未通过校验`)
  process.exit(1)
}
console.log(`\n${EXPECTED.length} 张截图全部通过`)
