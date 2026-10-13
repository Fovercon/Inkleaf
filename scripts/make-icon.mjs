// Generates the Inkleaf icon: warm paper, an ink outline and a forest-green leaf.
// Outputs build/icon.icns via sips + iconutil (macOS only).
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const S = 1024
const MARGIN = 64
const RADIUS = 200

const PAGE = [[292, 220], [580, 220], [710, 350], [710, 805], [292, 805]]
const FOLD = [[580, 220], [580, 350], [710, 350]]
function cubic(a, b, c, d, steps = 80) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, u = 1 - t
    return [u**3*a[0] + 3*u*u*t*b[0] + 3*u*t*t*c[0] + t**3*d[0],
      u**3*a[1] + 3*u*u*t*b[1] + 3*u*t*t*c[1] + t**3*d[1]]
  })
}
const LEAF = [...cubic([470, 625], [428, 445], [650, 415], [800, 422]),
  ...cubic([800, 422], [790, 620], [602, 731], [470, 625])]
function onLine(x, y, a, b, width) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((x-a[0])*dx + (y-a[1])*dy)/(dx*dx + dy*dy)))
  return (x-a[0]-t*dx)**2 + (y-a[1]-t*dy)**2 <= (width/2)**2
}
function onOutline(x, y, poly, width) {
  return poly.some((a, i) => onLine(x, y, a, poly[(i+1)%poly.length], width))
}

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
    // A soft warm-white tile, matching the reading surface.
    const t = y / S
    const color = [Math.round(251 - 12*t), Math.round(249 - 12*t), Math.round(244 - 17*t)]
    if (inPoly(x - 9, y - 15, PAGE)) color.splice(0, 3, 225, 226, 211)
    if (inPoly(x, y, PAGE)) color.splice(0, 3, 255, 253, 247)
    if (inPoly(x, y, FOLD)) color.splice(0, 3, 224, 231, 213)
    if (onOutline(x, y, PAGE, 12) || onLine(x, y, [580, 220], [580, 350], 12) || onLine(x, y, [580, 350], [710, 350], 12)) color.splice(0, 3, 66, 85, 65)
    if (inPoly(x, y, LEAF)) color.splice(0, 3, 72, 112, 82)
    if (onLine(x, y, [413, 738], [656, 527], 14)) color.splice(0, 3, 66, 100, 73)
    raw[i] = color[0]
    raw[i + 1] = color[1]
    raw[i + 2] = color[2]
    raw[i + 3] = 255
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
