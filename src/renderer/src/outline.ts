interface OutlineItem {
  id: string
  level: number
  text: string
}

// collapsed heading ids (per app session; Obsidian-style outline folding)
const collapsed = new Set<string>()

export function buildOutline(preview: HTMLElement, nav: HTMLElement) {
  const headings = Array.from(preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
  nav.innerHTML = ''
  if (!headings.length) {
    const empty = document.createElement('div')
    empty.className = 'tree-empty'
    empty.textContent = '（无标题）'
    nav.appendChild(empty)
    return
  }

  const items: OutlineItem[] = headings.map((h) => ({
    id: h.id,
    level: Number(h.tagName[1]),
    text: h.textContent ?? '',
  }))
  const minLevel = Math.min(...items.map((i) => i.level))

  // an item is hidden when any of its ancestors is collapsed
  const stack: OutlineItem[] = []
  const hidden: boolean[] = items.map((it) => {
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop()
    const isHidden = stack.some((a) => collapsed.has(a.id))
    stack.push(it)
    return isHidden
  })

  items.forEach((it, i) => {
    if (hidden[i]) return
    const hasChildren = !!items[i + 1] && items[i + 1].level > it.level
    const row = document.createElement('div')
    row.className = 'outline-item' + (hasChildren ? ' has-children' : '')
    row.dataset.id = it.id
    row.style.paddingLeft = `${(it.level - minLevel) * 12 + 6}px`
    row.title = it.text

    const disc = document.createElement('span')
    disc.className = 'ol-disc'
    disc.textContent = hasChildren ? (collapsed.has(it.id) ? '▸' : '▾') : ''
    if (hasChildren) {
      disc.addEventListener('click', (e) => {
        e.stopPropagation()
        if (collapsed.has(it.id)) collapsed.delete(it.id)
        else collapsed.add(it.id)
        buildOutline(preview, nav)
        updateActiveHeading(preview, nav)
      })
    }

    const text = document.createElement('span')
    text.className = 'ol-text'
    text.textContent = it.text

    row.addEventListener('click', () => {
      const target = preview.querySelector(`#${CSS.escape(it.id)}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

    row.appendChild(disc)
    row.appendChild(text)
    nav.appendChild(row)
  })
}

export function updateActiveHeading(preview: HTMLElement, nav: HTMLElement) {
  const items = nav.querySelectorAll<HTMLElement>('.outline-item')
  if (!items.length) return
  const headings = Array.from(preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
  const threshold = preview.getBoundingClientRect().top + 90
  let activeHeading: HTMLElement | null = null
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= threshold) activeHeading = h
  }
  let activeEl: HTMLElement | null = null
  for (const it of Array.from(items)) {
    const isActive = !!activeHeading && it.dataset.id === activeHeading.id
    it.classList.toggle('active', isActive)
    if (isActive) activeEl = it
  }
  activeEl?.scrollIntoView({ block: 'nearest' })
}
