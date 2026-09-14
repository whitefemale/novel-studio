// 生成应用图标 build/icon.ico（256x256，蓝白渐变 + 纸页）
// 用纯 Node 手写 PNG + ICO 封装，无需第三方依赖。
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const S = 256
const px = new Uint8Array(S * S * 4) // RGBA，初始全透明

const C_TOP = [0x6d, 0x8b, 0xff]
const C_BOT = [0x4f, 0x6e, 0xf2]

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  const na = a / 255
  px[i] = Math.round(r * na + px[i] * (1 - na))
  px[i + 1] = Math.round(g * na + px[i + 1] * (1 - na))
  px[i + 2] = Math.round(b * na + px[i + 2] * (1 - na))
  px[i + 3] = Math.min(255, Math.round(255 * na + px[i + 3] * (1 - na)))
}

// 垂直渐变打底
for (let y = 0; y < S; y++) {
  const t = y / (S - 1)
  const r = Math.round(C_TOP[0] + (C_BOT[0] - C_TOP[0]) * t)
  const g = Math.round(C_TOP[1] + (C_BOT[1] - C_TOP[1]) * t)
  const b = Math.round(C_TOP[2] + (C_BOT[2] - C_TOP[2]) * t)
  for (let x = 0; x < S; x++) blend(x, y, r, g, b, 255)
}

// 白色圆角“纸页”
function roundedRect(x0, y0, w, h, rad, r, g, b, a) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad))
      const cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad))
      const d = Math.hypot(x - cx, y - cy)
      if (d <= rad || (x >= x0 + rad && x < x0 + w - rad) || (y >= y0 + rad && y < y0 + h - rad)) {
        blend(x, y, r, g, b, a)
      } else if (d <= rad + 2) {
        blend(x, y, r, g, b, a * ((rad + 2 - d) / 2))
      }
    }
  }
}
roundedRect(70, 62, 116, 132, 16, 255, 255, 255, 255)

// 纸页上的“斜杠/笔迹”（accent 色）
for (let t = 0; t < 130; t++) {
  const x = 86 + t
  const y = 170 - t * 0.82
  blend(Math.round(x), Math.round(y), 0x4f, 0x6e, 0xf2, 255)
  blend(Math.round(x) + 1, Math.round(y), 0x4f, 0x6e, 0xf2, 235)
  blend(Math.round(x), Math.round(y) + 1, 0x4f, 0x6e, 0xf2, 235)
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c, table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  c = -1
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0 // filter: none
  px.subarray(y * S * 4, (y + 1) * S * 4).forEach((v, i) => {
    raw[y * (S * 4 + 1) + 1 + i] = v
  })
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

// ---- ICO 封装（256x256 → width/height 记为 0）----
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = 0 // width 256
entry[1] = 0 // height 256
entry[2] = 0 // palette
entry[3] = 0 // reserved
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8) // bytesInRes
entry.writeUInt32LE(6 + entry.length, 12) // imageOffset
const ico = Buffer.concat([header, entry, png])

mkdirSync(path.join(root, 'build'), { recursive: true })
writeFileSync(path.join(root, 'build', 'icon.ico'), ico)
console.log('icon.ico 已生成：', path.join(root, 'build', 'icon.ico'), `${ico.length} bytes`)
