// Google Analytics 4 — loader is in the page head; config fires on the live
// domain only, so staging traffic never pollutes the property. gtag is defined
// globally either way so form events can call it safely.
window.dataLayer = window.dataLayer || [];
window.gtag = function () { dataLayer.push(arguments); };
if (/estatelandscapers\.com\.au$/.test(location.hostname)) {
  gtag('js', new Date());
  gtag('config', 'G-NWQPY0NXEF');
}

// Mobile navigation toggle
(function () {
  var btn = document.querySelector('.nav-toggle');
  var links = document.getElementById('nav-links');
  if (!btn || !links) return;
  function setOpen(open) {
    links.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
  }
  btn.addEventListener('click', function () { setOpen(!links.classList.contains('open')); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && links.classList.contains('open')) { setOpen(false); btn.focus(); }
  });
  document.addEventListener('click', function (e) {
    if (links.classList.contains('open') && !links.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });
  links.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
})();

// Navigation highlighting.
// Plain page links: marked when you're ON that page. Anchor links (Services,
// Process): scrollspy — lit only while their section is actually in view.
(function () {
  var here = location.pathname.replace(/\/+$/, '/') || '/';
  if (!here.endsWith('/')) here += '/';
  var links = [].slice.call(document.querySelectorAll('.nav-links a'));

  // 1. Same-page anchor links become spies; other links get page marking.
  var spies = [];
  links.forEach(function (a) {
    var href = a.getAttribute('href') || '';
    var path = href.split('#')[0];
    var hash = href.indexOf('#') > -1 ? href.split('#')[1] : '';
    if (hash && (path === here || path === '')) {
      var t = document.getElementById(hash);
      if (t) spies.push({ a: a, t: t });
    } else if (!hash && path === here) {
      a.setAttribute('aria-current', 'page');
    }
  });

  // 2. Scrollspy: a section is "current" while it occupies the reading band
  //    near the top of the viewport; leaving it clears the highlight.
  if (spies.length && 'IntersectionObserver' in window) {
    function clear() { spies.forEach(function (s) { s.a.removeAttribute('aria-current'); }); }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var m = spies.filter(function (s) { return s.t === e.target; })[0];
        if (!m) return;
        if (e.isIntersecting) { clear(); m.a.setAttribute('aria-current', 'location'); }
        else if (m.a.hasAttribute('aria-current')) { m.a.removeAttribute('aria-current'); }
      });
    }, { rootMargin: '-15% 0px -65% 0px' });
    spies.forEach(function (s) { io.observe(s.t); });
  }
})();

// Current year in the footer
(function () {
  var y = document.getElementById('yr');
  if (y) y.textContent = new Date().getFullYear();
})();

// GA4 — only on the live domain, so staging never pollutes the data
(function () {
  var h = location.hostname;
  if (h !== 'www.estatelandscapers.com.au' && h !== 'estatelandscapers.com.au') return;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-NWQPY0NXEF';
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-NWQPY0NXEF');
})();

// Precise anchor offset: measure the sticky nav so jumped-to headings land exactly
// below it — no sliver of the section above showing through.
(function () {
  var nav = document.querySelector('.nav');
  if (!nav) return;
  function set() { document.documentElement.style.setProperty('--navh', nav.offsetHeight + 'px'); }
  set();
  window.addEventListener('resize', set);
})();

// Back to top — appears after a screen and a half of scroll.
(function () {
  var b = document.createElement('button');
  b.className = 'totop'; b.type = 'button'; b.setAttribute('aria-label', 'Back to top');
  b.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  document.body.appendChild(b);
  window.addEventListener('scroll', function () {
    b.classList.toggle('show', window.scrollY > window.innerHeight * 1.5);
  }, { passive: true });
})();

// First-touch attribution: remember the landing page and any campaign tags, so the
// enquiry that happens three pages later still knows where the visit came from.
(function () {
  try {
    var q = new URLSearchParams(location.search), utm = {}, has = false;
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid'].forEach(function (k) {
      if (q.get(k)) { utm[k] = q.get(k); has = true; }
    });
    if (has && !sessionStorage.getItem('el_utm')) sessionStorage.setItem('el_utm', JSON.stringify(utm));
    if (!sessionStorage.getItem('el_landing')) sessionStorage.setItem('el_landing', location.pathname + location.search);
  } catch (e) {}
})();

// Hero reveal, two phases. Phase 1 (p 0-0.45): the text scrolls away and the
// band grows to full viewport, anchored on the TOP of the photo (sky and roof).
// Phase 2 (p 0.45-1): pinned full-screen, scroll pans DOWN through the photo to
// its bottom, then the page releases into the next section.
(function () {
  var reveal = document.querySelector('.fdh-reveal');
  var band = document.querySelector('.fdh-band');
  if (!reveal || !band) return;
  if (!/\bjs\b/.test(document.documentElement.className)) return; // boot script decides motion
  var ticking = false;
  function ease(t) { return t * t * (3 - 2 * t); }
  function frame() {
    ticking = false;
    var vh = window.innerHeight;
    var travel = reveal.offsetHeight - vh;
    if (travel <= 0) return;
    var p = Math.max(0, Math.min(1, -reveal.getBoundingClientRect().top / travel));
    var grow = ease(Math.min(1, p / 0.45));            // phase 1
    var pan = p <= 0.45 ? 0 : ease((p - 0.45) / 0.55); // phase 2
    band.style.setProperty('--ph', grow.toFixed(4));
    band.style.backgroundPosition = 'center ' + (10 + pan * 84).toFixed(2) + '%';
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  frame();
})();

// Cursor: dot glued to the mouse, ring chasing with easing, both blend-inverted
// so they read over any background; grows over interactive elements. Fine
// pointers only, and only when the boot script allowed motion (html.js).
(function () {
  if (!/\bjs\b/.test(document.documentElement.className)) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  var dot = document.createElement('div'); dot.id = 'cur';
  var ring = document.createElement('div'); ring.id = 'cuf';
  document.body.appendChild(dot); document.body.appendChild(ring);
  document.documentElement.classList.add('cur-on');
  var mx = -40, my = -40, fx = -40, fy = -40;
  document.addEventListener('mousemove', function (e) {
    mx = e.clientX; my = e.clientY;
    dot.style.left = mx + 'px'; dot.style.top = my + 'px';
  }, { passive: true });
  (function chase() {
    fx += (mx - fx) * 0.13; fy += (my - fy) * 0.13;
    ring.style.left = fx + 'px'; ring.style.top = fy + 'px';
    requestAnimationFrame(chase);
  })();
  document.addEventListener('mouseover', function (e) {
    if (e.target.closest('a, button, .chip, .card, .fd-door, input, select, textarea, .filebox'))
      document.documentElement.classList.add('cur-hover');
  }, { passive: true });
  document.addEventListener('mouseout', function (e) {
    if (e.target.closest('a, button, .chip, .card, .fd-door, input, select, textarea, .filebox'))
      document.documentElement.classList.remove('cur-hover');
  }, { passive: true });
})();

// Reveal on scroll: content blocks below the fold rise in as they enter view,
// staggered within their group. Above-the-fold content is never touched, so
// nothing flashes; without JS or with reduced motion, everything is static.
(function () {
  if (!/\bjs\b/.test(document.documentElement.className)) return;
  if (!('IntersectionObserver' in window)) return;
  var els = document.querySelectorAll('.card, .steps li, .faq li, .fd-row .tx, .fd-door, .g2 > div, .plate');
  var vh = window.innerHeight, list = [];
  els.forEach(function (el) {
    if (el.getBoundingClientRect().top > vh * 0.88) { el.classList.add('rv'); list.push(el); }
  });
  if (!list.length) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var el = en.target, sibs = el.parentElement ? [].slice.call(el.parentElement.children) : [];
      var i = Math.max(0, sibs.indexOf(el));
      el.style.transitionDelay = Math.min(i * 70, 350) + 'ms';
      el.classList.add('v');
      io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  list.forEach(function (el) { io.observe(el); });
})();
