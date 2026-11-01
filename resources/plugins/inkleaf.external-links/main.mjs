export function activate(ink) {
  ink.pipeline.registerPostProcessor(root => {
    root.querySelectorAll('a[href]').forEach(a => {
      if (!/^https?:\/\//i.test(a.getAttribute('href') || '') || a.querySelector('img') || a.hasAttribute('data-ink-external-link')) return;
      a.setAttribute('data-ink-external-link', '');
      const mark = document.createElement('span');
      mark.textContent = ' ↗';
      mark.setAttribute('aria-hidden', 'true');
      a.append(mark);
    });
  });
}
