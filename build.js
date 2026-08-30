#!/usr/bin/env node
/* Estate Landscapers — zero-dependency static build.
   src/pages/**  +  src/partials/**  +  src/layout.html  →  public/**
   Run: node build.js
   Shared chrome (nav, footer, utility bar) lives in ONE partial each — edit once,
   every page changes. Pages carry only their own content and a CONFIG header. */
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'public');

const read = f => fs.readFileSync(f, 'utf8');
const partial = n => read(path.join(SRC, 'partials', n + '.html'));

function render(tpl, vars) {
  let prev = null, cur = tpl, guard = 0;
  while (cur !== prev) {
    if (++guard > 12) throw new Error('include loop on ' + vars.PATH);
    prev = cur;
    cur = cur.replace(/\{\{include ([\w-]+)\}\}/g, (_, n) => partial(n));
    cur = cur.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
      if (!(k in vars)) throw new Error('missing {{' + k + '}} on ' + vars.PATH);
      return vars[k];
    });
  }
  return cur;
}

const walk = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

const layout = read(path.join(SRC, 'layout.html'));
const PHOTOS = [];
const IMAGES = [];
function pageSlug(p) { return p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\//g, '-').replace(/\.html$/, ''); }
function swapPhotos(html, cpath) {
  const slug = pageSlug(cpath);
  let i = 0;
  return html.replace(/<div class="slot">([\s\S]*?)<\/div>/g, (m, inner) => {
    i++;
    const name = slug + '-' + i;
    const desc = ((inner.match(/<span>([\s\S]*?)<\/span>/) || [,''])[1] || '')
      .replace(/<br\s*\/?\s*>/g, ' ').replace(/\s+/g, ' ').trim();
    const dir = path.join(OUT, 'assets', 'img');
    const all = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const file = all.find(f => {
      const m2 = f.match(/^(.+?)(?:--.+)?\.(webp|jpe?g|png)$/i);
      return m2 && m2[1] === name;
    });
    PHOTOS.push({ page: cpath, name: name, desc: desc, done: !!file, file: file || null });
    if (!file) return m;
    const words = (file.match(/--(.+)\.\w+$/) || [])[1];
    const alt = words ? words.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()) : desc;
    if (file) IMAGES.push({ page: cpath, src: '/assets/img/' + file, alt: alt });
    const load = i === 1 ? ' fetchpriority="high"' : ' loading="lazy"';
    return '<img src="/assets/img/' + file + '" alt="' + alt.replace(/"/g, '&quot;') + '"' + load + '>';
  });
}
const STAMP = new Date().toISOString().slice(0, 16) + 'Z';
const SITEMAP_PATHS = [];
let n = 0;
for (const f of walk(path.join(SRC, 'pages'))) {
  const s = read(f);
  const m = s.match(/^<!--CONFIG\s*([\s\S]*?)-->\s*/);
  if (!m) throw new Error('no CONFIG header in ' + f);
  const c = JSON.parse(m[1]);
  const body = s.slice(m[0].length);
  const vars = {
    TITLE: c.title || '', DESC: c.description || '', PATH: c.path,
    PAGE_URL: 'https://www.estatelandscapers.com.au' + c.path,
    NAV: c.nav ? '{{include nav-' + c.nav + '}}' : '',
    ROBOTS: c.noindex ? '<meta name="robots" content="noindex">' : '',
    FOOTER: c.footer ? '{{include footer-' + c.footer + '}}' : '',
    BODY: body
  };
  let html = c.raw ? render(body, vars) : render(layout, vars);
  html = swapPhotos(html, c.path);
  // Cache-busting: assets carry the build stamp, so a deploy is visible instantly
  // even though assets themselves are cached for speed.
  html = html.replace(/\/assets\/(site\.css|site\.js|enquiry\.js)(?!\?)/g,
    '/assets/$1?v=' + STAMP.replace(/[^0-9]/g, ''));
  html = html.replace('</html>', '<!-- estate build ' + STAMP + ' · ' + c.path + ' -->\n</html>');
  if (!global.__built) global.__built = new Set();
  if (global.__built.has(c.path)) throw new Error('DUPLICATE PAGE PATH: ' + c.path + ' built twice (second source: ' + f + ')');
  global.__built.add(c.path);
  const out = c.path.endsWith('.html')
    ? path.join(OUT, c.path.replace(/^\//, ''))
    : path.join(OUT, c.path.replace(/^\//, ''), 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log('built ' + c.path);
  if (!c.path.endsWith('.html') && !c.noindex) SITEMAP_PATHS.push(c.path);
  n++;
}
// ---- sanity: the build must contain a homepage, and no two pages may share a path
if (!fs.existsSync(path.join(OUT, 'index.html')))
  throw new Error('BUILD FAILED SANITY CHECK: public/index.html was not produced — the homepage is missing.');
SITEMAP_PATHS.sort();
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
  SITEMAP_PATHS.map(p => {
    const imgs = IMAGES.filter(x => x.page === p).map(x =>
      '    <image:image><image:loc>https://www.estatelandscapers.com.au' + x.src + '</image:loc></image:image>').join('\n');
    return '  <url><loc>https://www.estatelandscapers.com.au' + p + '</loc><lastmod>' + today + '</lastmod>' +
      (imgs ? '\n' + imgs + '\n  ' : '') + '</url>';
  }).join('\n') + '\n</urlset>\n');
console.log(n + ' pages built into public/ · sitemap.xml: ' + SITEMAP_PATHS.length + ' URLs');
// PHOTOS.md — the live shot list: regenerated every build, ticks itself off
const byPage = {};
PHOTOS.forEach(p => { (byPage[p.page] = byPage[p.page] || []).push(p); });
let md = '# Photo slots — the shot list\n\n';
md += 'Save an image as `public/assets/img/<name>.jpg` (or .webp/.png), push, and it\n';
md += 'appears in its slot automatically on the next build. This file regenerates on\n';
md += 'every build and ticks itself: ' + PHOTOS.filter(p => p.done).length + ' of ' + PHOTOS.length + ' slots filled.\n\n';
md += 'Best size: 1600px wide, JPG/WebP, under 400 KB (squoosh.app does this in-browser).\n';
md += 'Height is flexible — every slot crops to fit, so keep the subject centred.\n';
md += 'Exact shapes if you want them: heroes and homepage rows ~1600x1200, service\n';
md += 'cards ~1600x1000, the two homepage doors ~1600x900 (subject mid-frame; text\n';
md += 'overlays the bottom), and ONLY the four \"Recent post\" slots are square (1200x1200).\n\n';
md += 'SEO NAMING: keep the slot key, then add real words after a double dash:\n';
md += '  home-2--engineered-retaining-wall-piers-kellyville.jpg\n';
md += 'The words become the alt text and travel into Google Images. Filled slots are\n';
md += 'added to the image sitemap automatically.\n\n';
Object.keys(byPage).sort().forEach(pg => {
  md += '## ' + pg + '\n\n';
  byPage[pg].forEach(p => {
    md += '- [' + (p.done ? 'x' : ' ') + '] `' + p.name + '.jpg` — ' + (p.desc || 'see page') + '\n';
  });
  md += '\n';
});
fs.writeFileSync(path.join(__dirname, 'PHOTOS.md'), md);
console.log('PHOTOS.md: ' + PHOTOS.filter(p => p.done).length + '/' + PHOTOS.length + ' slots filled');
