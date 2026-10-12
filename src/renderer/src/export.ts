/**
 * Standalone HTML export built from the live preview DOM:
 * everything Typora users keep asking for — single file, styles inlined,
 * images and KaTeX fonts embedded as data URLs, mermaid kept as rendered SVG.
 */

const EXPORT_CSS_EXTRA = `
  html, body { margin: 0; padding: 0; background: #fff; }
  .md-preview { margin: 0 auto; padding: 48px 12px 90px; box-sizing: border-box; }
  @media print {
    .md-preview { max-width: 100%; padding: 0; }
    pre, table, figure, .mermaid-block, .katex-display { page-break-inside: avoid; }
    h1, h2, h3, h4 { page-break-after: avoid; }
  }
`

function escapeContent(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const buf = new Uint8Array(await r.arrayBuffer())
    const chunks: string[] = []
    for (let i = 0; i < buf.length; i += 0x8000) {
      chunks.push(String.fromCharCode(...buf.subarray(i, i + 0x8000)))
    }
    const type = r.headers.get('content-type') ?? 'application/octet-stream'
    return `data:${type};base64,${btoa(chunks.join(''))}`
  } catch {
    return null
  }
}

export async function buildStandaloneHtml(previewEl: HTMLElement, title: string): Promise<string> {
  let css = ''
  try {
    const res = await fetch('renderer.css')
    if (res.ok) css = await res.text()
  } catch {
    /* fall back to bare content */
  }

  const clone = previewEl.cloneNode(true) as HTMLElement

  // embed local/remote images as data URLs so the file is truly standalone
  const imgs = Array.from(clone.querySelectorAll('img'))
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? ''
    if (src.startsWith('data:')) continue
    const data = await toDataUrl(src)
    if (data) img.src = data
    else img.remove()
  }

  // embed KaTeX woff2 fonts only when the document actually contains math
  if (clone.querySelector('.katex')) {
    for (const m of [...css.matchAll(/url\((['"]?)(?:\.\/)?(assets\/[^)'"]+?\.woff2)\1\)/g)]) {
      const data = await toDataUrl(m[2])
      if (data) css = css.replace(m[0], `url(${data})`)
    }
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeContent(title)}</title>
</head>
<body data-theme="light">
<style>${css}${EXPORT_CSS_EXTRA}</style>
${clone.outerHTML}
</body>
</html>`
}
