// Lọc HTML trước khi đưa lên trang (văn bản soạn tự do, file Word, AI soạn, giấy in): chống chèn mã độc (XSS)
// đánh cắp phiên đăng nhập. Chỉ giữ định dạng văn bản; bỏ script, khung nhúng, form, sự kiện on*, liên kết javascript:.
const DROP = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA',
  'SELECT', 'OPTION', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'PORTAL', 'DIALOG']);
const URL_ATTR = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'srcset', 'data', 'ping']);
const safeUrl = (name: string, v: string) => {
  const s = v.replace(/[\u0000- ]+/g, '').toLowerCase();
  if (/^(javascript|vbscript|livescript|file):/.test(s)) return false;
  if (s.startsWith('data:')) return name === 'src' && /^data:image\/(png|jpe?g|gif|webp);/.test(s);
  return true;
};
const cache = new Map<string, string>();

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  const hit = cache.get(html);
  if (hit !== undefined) return hit;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');   // DOMParser không chạy script
  const walk = (el: Element) => {
    for (const ch of Array.from(el.children)) {
      if (DROP.has(ch.tagName.toUpperCase())) { ch.remove(); continue; }
      for (const a of Array.from(ch.attributes)) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction' || (URL_ATTR.has(n) && !safeUrl(n, a.value))
            || (n === 'style' && /expression\s*\(|javascript:|url\s*\(\s*['"]?\s*(?!data:image\/)/i.test(a.value))) ch.removeAttribute(a.name);
      }
      if (ch.tagName === 'A') { ch.setAttribute('rel', 'noopener noreferrer'); if (ch.getAttribute('target')) ch.setAttribute('target', '_blank'); }
      if (ch.tagName === 'STYLE' && /@import|url\s*\(\s*['"]?\s*(?!data:image\/)|expression\s*\(/i.test(ch.textContent ?? '')) { ch.remove(); continue; }
      walk(ch);
    }
  };
  walk(doc.body);
  const out = doc.body.innerHTML;
  if (cache.size > 200) cache.clear();
  cache.set(html, out);
  return out;
}
