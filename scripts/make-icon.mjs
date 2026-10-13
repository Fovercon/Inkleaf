// Generates the app icon: rounded square with a blue gradient and a white "M".
// Outputs build/icon.icns via sips + iconutil (macOS only).
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const S = 1024
const MARGIN = 64
const RADIUS = 200

// "M" letter polygon (white), designed on a 1024 grid
const M_POLY = [
  [330, 700], [388, 360], [500, 545], [612, 360], [670, 700],
  [592, 700], [556, 480], [500, 610], [444, 480], [408, 700],
]

function inRoundedSquare(x, y) {
  if (x < MARGIN || y < MARGIN || x > S - MARGIN || y > S - MARGIN) return false
  const half = S / 2
  const rx = Math.max(Math.abs(x - half) - (half - MARGIN - RADIUS), 0)
  const ry = Math.max(Math.abs(y - half) - (half - MARGIN - RADIUS), 0)
  return rx * rx + ry * ry <= RADIUS * RADIUS
}

function inPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  const row = y * (S * 4 + 1)
  raw[row] = 0
  for (let x = 0; x < S; x++) {
    const i = row + 1 + x * 4
    if (!inRoundedSquare(x, y)) {
      raw[i + 3] = 0
      continue
    }
    // vertical gradient #2f55d4 -> #7b96ff with a subtle diagonal lift
    const t = y / S
    const lift = (x / S) * 0.15
    raw[i] = Math.round(47 + (123 - 47) * Math.min(1, t * 0.85 + lift))
    raw[i + 1] = Math.round(85 + (150 - 85) * Math.min(1, t * 0.85 + lift))
    raw[i + 2] = Math.round(212 + (255 - 212) * Math.min(1, t * 0.85 + lift))
    raw[i + 3] = 255
    if (inPoly(x, y, M_POLY)) {
      raw[i] = 255
      raw[i + 1] = 255
      raw[i + 2] = 255
    }
  }
}

const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
const crc32 = (buf) => {
  let crc = 0xffffffff
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type)
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const tmp = path.resolve('build')
mkdirSync(tmp, { recursive: true })
const basePng = path.join(tmp, 'icon-base.png')
writeFileSync(basePng, png)

const iconset = path.join(tmp, 'icon.iconset')
rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset, { recursive: true })
const sizes = [16, 32, 128, 256, 512]
for (const s of sizes) {
  execSync(`sips -z ${s} ${s} ${basePng} --out ${iconset}/icon_${s}x${s}.png`, { stdio: 'ignore' })
  execSync(`sips -z ${s * 2} ${s * 2} ${basePng} --out ${iconset}/icon_${s}x${s}@2x.png`, { stdio: 'ignore' })
}
execSync(`sips -z 1024 1024 ${basePng} --out ${iconset}/icon_512x512@2x.png`, { stdio: 'ignore' })
execSync(`iconutil -c icns ${iconset} -o ${path.join(tmp, 'icon.icns')}`)
console.log('icon written to build/icon.icns')
