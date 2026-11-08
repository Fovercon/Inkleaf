import MarkdownIt from 'markdown-it'
import katex from '@vscode/markdown-it-katex'
import DOMPurify from 'dompurify'

// No document plugins or local-file resolver process untrusted model replies.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(katex as never, { trust: false, throwOnError: false, maxExpand: 1000, maxSize: 10 })
markdown.renderer.rules.image = (tokens, i) => {
  const token = tokens[i], src = token.attrGet('src') ?? '', alt = token.content || '图片'
  let url: URL
  try { url = new URL(src) } catch { return markdown.utils.escapeHtml(`[图片：${alt}，地址不可用]`) }
  if (url.protocol !== 'https:' || url.username || url.password || src.length > 4096) return markdown.utils.escapeHtml(`[图片：${alt}，仅支持 HTTPS]`)
  return `<button type="button" class="model-image-load" data-image-url="${markdown.utils.escapeHtml(url.href)}" data-image-alt="${markdown.utils.escapeHtml(alt)}">加载图片：${markdown.utils.escapeHtml(alt)}<small>${markdown.utils.escapeHtml(url.hostname)}</small></button>`
}
export function renderModelMarkdown(container: HTMLElement, text: string) {
  container.innerHTML = DOMPurify.sanitize(markdown.render(text), {
    ADD_ATTR: ['data-image-url', 'data-image-alt'],
    FORBID_TAGS: ['img', 'svg', 'iframe', 'object', 'embed', 'style', 'link', 'form'],
    FORBID_ATTR: ['src', 'srcset', 'ping'],
  })
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = link.getAttribute('href') ?? ''
    if (!/^https:\/\//i.test(href)) link.removeAttribute('href')
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer' }
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('.model-image-load')) {
    button.onclick = () => {
      const image = document.createElement('img')
      image.alt = button.dataset.imageAlt || '模型引用图片'; image.referrerPolicy = 'no-referrer'
      image.onload = () => { button.replaceWith(image) }
      image.onerror = () => { button.disabled = false; button.textContent = '图片加载失败，点击重试'; image.remove() }
      button.disabled = true; button.textContent = '正在加载图片…'; image.src = button.dataset.imageUrl!
    }
  }
}
