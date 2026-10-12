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
  headings.forEach((h) => {
    const level = Number(h.tagName[1])
    const item = document.createElement('div')
    item.className = 'outline-item'
    item.style.paddingLeft = `${(level - 1) * 12 + 10}px`
    item.textContent = h.textContent ?? ''
    item.title = h.textContent ?? ''
    item.addEventListener('click', () => {
      h.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    nav.appendChild(item)
  })
}

export function updateActiveHeading(preview: HTMLElement, nav: HTMLElement) {
  const items = nav.querySelectorAll<HTMLElement>('.outline-item')
  if (!items.length) return
  const headings = Array.from(preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
  const threshold = preview.getBoundingClientRect().top + 90
  let activeIdx = 0
  headings.forEach((h, i) => {
    if (h.getBoundingClientRect().top <= threshold) activeIdx = i
  })
  items.forEach((it, i) => it.classList.toggle('active', i === activeIdx))
}
