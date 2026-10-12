/**
 * Fullscreen image viewer for the markdown preview.
 * medium-zoom / Typora style: click an image to open it over a dimmed
 * backdrop; wheel to zoom, drag to pan, Esc or click to close.
 */

export function setupLightbox(container: HTMLElement) {
  container.addEventListener('click', (e) => {
    const img = (e.target as HTMLElement).closest('img')
    if (!img || !container.contains(img)) return
    if (img.closest('a')) return // image wrapped in a link follows the link
    if (e.metaKey || e.ctrlKey) {
      // modifier-click on a remote image opens the original in the browser
      if (/^https?:/i.test(img.src)) {
        e.preventDefault()
        window.open(img.src, '_blank', 'noopener')
      }
      return
    }
    e.preventDefault()
    e.stopPropagation()
    open(img as HTMLImageElement)
  })
}

function open(img: HTMLImageElement) {
  const overlay = document.createElement('div')
  overlay.className = 'lb-overlay'

  const big = document.createElement('img')
  big.className = 'lb-img'
  big.src = img.currentSrc || img.src
  big.alt = img.alt
  big.draggable = false

  const caption = document.createElement('div')
  caption.className = 'lb-caption'
  caption.textContent = img.alt || ''

  overlay.appendChild(big)
  if (img.alt) overlay.appendChild(caption)
  document.body.appendChild(overlay)
  document.body.classList.add('lb-open')

  let scale = 1
  let tx = 0
  let ty = 0
  const apply = () => {
    big.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    big.classList.toggle('pannable', scale > 1.01)
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    scale = Math.min(8, Math.max(0.5, scale * factor))
    if (scale <= 1.01) {
      tx = 0
      ty = 0
    }
    apply()
  }

  let dragging = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (e: PointerEvent) => {
    if (e.target !== big || scale <= 1.01) return
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    big.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    tx += e.clientX - lastX
    ty += e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    apply()
  }
  const onPointerUp = () => {
    dragging = false
  }
  const onDblClick = () => {
    scale = scale > 1.01 ? 1 : 2
    tx = 0
    ty = 0
    apply()
  }

  const close = () => {
    overlay.classList.add('lb-closing')
    overlay.removeEventListener('wheel', onWheel)
    document.removeEventListener('keydown', onKey)
    setTimeout(() => {
      overlay.remove()
      document.body.classList.remove('lb-open')
    }, 180)
  }
  const onBackdrop = (e: MouseEvent) => {
    if (e.target === overlay || e.target === caption) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }

  overlay.addEventListener('wheel', onWheel, { passive: false })
  overlay.addEventListener('pointerdown', onPointerDown)
  overlay.addEventListener('pointermove', onPointerMove)
  overlay.addEventListener('pointerup', onPointerUp)
  overlay.addEventListener('dblclick', onDblClick)
  overlay.addEventListener('click', onBackdrop)
  document.addEventListener('keydown', onKey)

  // trigger entrance transition
  requestAnimationFrame(() => overlay.classList.add('lb-visible'))
}
