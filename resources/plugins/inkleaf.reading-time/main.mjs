export function activate(ink) {
  ink.pipeline.registerPostProcessor(root => {
    root.querySelectorAll('[data-ink-reading-time]').forEach(el => el.remove());
    const copy = root.cloneNode(true);
    copy.querySelectorAll('pre, code, style, script').forEach(el => el.remove());
    const text = copy.textContent || '';
    const count = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu) || []).length;
    const p = document.createElement('p');
    p.setAttribute('data-ink-reading-time', '');
    p.textContent = '约 ' + count + ' 字 · 阅读约 ' + Math.max(1, Math.ceil(count / 400)) + ' 分钟';
    root.prepend(p);
  });
}
