// 网页 HTML → 给她读的正文（不开浏览器时用）：优先 <article> / <main>，没有就去掉页头页脚导航后的 <body>。
// 纯字符串处理，不执行页面脚本；要靠 JS 才渲染出正文的页面读不到，算「没找到」。

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", middot: '·', hellip: '…', mdash: '—', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (error) { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch (error) { return m; } })
    .replace(/&([a-z0-9#]+);/gi, (m, n) => (Object.hasOwn(ENTITIES, n.toLowerCase()) ? ENTITIES[n.toLowerCase()] : m));
}

/** 一段 HTML 的纯文字（块级标签换行） */
export function htmlText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|pre|dd|dt)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
};

/**
 * @param {string} html 整页 HTML
 * @param {string} baseUrl 页面地址（把图片的相对地址补全）
 * @returns {{ title: string, text: string, images: Array<{src:string, alt:string, w:number, h:number}> }}
 */
export function htmlArticle(html, baseUrl = '', maxChars = 4000) {
  let h = String(html || '');
  const title = htmlText((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 120);
  h = h.replace(/<(script|style|noscript|svg|template|iframe|canvas|select)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks = (tag) => [...h.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => m[1]);
  const longest = (list) => list.map((b) => ({ b, n: htmlText(b).length })).sort((a, b) => b.n - a.n)[0] || { b: '', n: 0 };
  let pick = longest(blocks('article'));
  if (pick.n < 200) {
    const main = longest(blocks('main'));
    if (main.n > pick.n) pick = main;
  }
  if (pick.n < 200) {
    const body = (h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] || h;
    pick = { b: body.replace(/<(header|footer|nav|aside|form)\b[\s\S]*?<\/\1>/gi, ' '), n: 0 };
  }
  const text = htmlText(pick.b).slice(0, maxChars);
  const images = [];
  for (const m of pick.b.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const raw = attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'src');
    if (!raw || /^data:/i.test(raw)) continue;
    let src = '';
    try { src = new URL(raw, baseUrl || undefined).toString(); } catch (error) { continue; }
    if (!/^https?:/i.test(src) || /logo|icon|avatar|sprite|banner|qrcode|ads?[/_.-]/i.test(src)) continue;
    const w = parseInt(attr(tag, 'width'), 10) || 0;
    const hgt = parseInt(attr(tag, 'height'), 10) || 0;
    if (w && hgt && (w < 320 || hgt < 200)) continue;
    const alt = (attr(tag, 'alt') || attr(tag, 'title')).trim().slice(0, 60);
    if (!alt && !(w && hgt)) continue;
    if (images.some((x) => x.src === src)) continue;
    images.push({ src: src.slice(0, 600), alt, w, h: hgt });
    if (images.length >= 6) break;
  }
  return { title, text, images };
}
