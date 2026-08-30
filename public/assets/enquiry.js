// Enquiry form engine — used by /residential/quote/ and /commercial/tender/.
// Multipart POST to the quote tool. Handles steps, qualification, drag-drop and
// mobile file/photo upload, per-upload progress, attribution, and GA4 events.
(function () {
  var form = document.getElementById('enquiry');
  if (!form) return;
  var API = form.dataset.endpoint || 'https://quotes.estatelandscapers.com.au/api/public/enquiry';
  var AUD = form.dataset.audience || 'residential';
  var MAX_FILE = 50 * 1024 * 1024, MAX_TOTAL = 100 * 1024 * 1024, MAX_COUNT = 20;
  var OK_EXT = /\.(pdf|zip|jpe?g|png|heic|heif|webp|dwg|docx?|xlsx?)$/i;

  function ev(name, params) { try { if (typeof gtag === 'function') gtag('event', name, params || {}); } catch (e) {} }

  // Live region: announces step changes, errors and upload progress to screen readers.
  var live = document.createElement('div');
  live.className = 'sr-only'; live.setAttribute('aria-live', 'polite');
  form.appendChild(live);
  function say(t) { live.textContent = ''; setTimeout(function () { live.textContent = t; }, 60); }
  ev(AUD === 'commercial' ? 'tender_started' : 'quote_started');

  // ---- steps ----
  var panels = [].slice.call(form.querySelectorAll('.steppanel'));
  var cur = 0;
  var stepNames = ['About the project', 'Your contact details', 'Files and message'];
  function show(i) {
    cur = i;
    panels.forEach(function (p, n) { p.classList.toggle('on', n === i); });
    var bar = document.getElementById('stepnum');
    if (bar) bar.textContent = (i + 1);
    window.scrollTo({ top: form.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
    var p = panels[i]; if (p) { p.setAttribute('tabindex', '-1'); p.focus({ preventScroll: true }); }
    if (panels.length > 1) say('Step ' + (i + 1) + ' of ' + panels.length + ': ' + (stepNames[i] || ''));
  }
  function bad(el, msg) {
    var f = el.closest('.field'); if (!f) return;
    f.classList.add('bad');
    var e = f.querySelector('.err'); if (e && msg) e.textContent = msg;
  }
  function clearBad(p) { p.querySelectorAll('.field.bad').forEach(function (f) { f.classList.remove('bad'); }); }
  form.addEventListener('input', function (e) {
    var f = e.target.closest('.field'); if (f) f.classList.remove('bad');
  });

  function validPanel(p) {
    clearBad(p);
    var ok = true, firstBad = null;
    p.querySelectorAll('[data-req]').forEach(function (el) {
      if (!el.value.trim()) { bad(el, el.dataset.req); ok = false; firstBad = firstBad || el; }
    });
    var em = p.querySelector('input[type="email"]');
    if (em && em.value) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em.value)) { bad(em, 'That email doesn\u2019t look right.'); ok = false; firstBad = firstBad || em; }
      else {
        var m = em.value.toLowerCase().match(/@(gmial|gamil|gmal|hotmial|outlok|yaho|gnail)\./);
        if (m) { bad(em, 'Did you mean a common provider? Double-check the spelling after the @.'); ok = false; firstBad = firstBad || em; }
      }
    }
    var ph = p.querySelector('input[type="tel"]');
    if (ph && ph.value.trim()) {
      var d = ph.value.replace(/[\s()\-]/g, '');
      if (!/^(\+?61|0)[2-478]\d{8}$/.test(d)) { bad(ph, 'That doesn\u2019t look like an Australian number \u2014 check the digits.'); ok = false; firstBad = firstBad || ph; }
    }
    if (!ok) {
      var n = p.querySelectorAll('.field.bad').length;
      say(n + (n === 1 ? ' field needs' : ' fields need') + ' attention.');
      if (firstBad) firstBad.focus();
    }
    return ok;
  }

  form.addEventListener('click', function (e) {
    var next = e.target.closest('[data-next]');
    var back = e.target.closest('[data-back]');
    if (next) { e.preventDefault(); if (validPanel(panels[cur]) && gate()) show(cur + 1); }
    if (back) { e.preventDefault(); show(cur - 1); }
  });

  // ---- chips (single-select groups) ----
  form.querySelectorAll('.chips').forEach(function (g) {
    g.addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c) return;
      e.preventDefault();
      g.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
      c.setAttribute('aria-pressed', 'true');
      var hid = document.getElementById(g.dataset.for);
      if (hid) { hid.value = c.dataset.v; hid.closest('.field').classList.remove('bad'); }
    });
  });

  // ---- qualification gate (residential only) ----
  var declined = document.getElementById('declined');
  function gate() {
    if (AUD !== 'residential' || cur !== 0 || !declined) return true;
    var jt = (document.getElementById('jobType') || {}).value || '';
    var bg = (document.getElementById('budget') || {}).value || '';
    var out = /maintenance/i.test(jt) || /under/i.test(bg);
    if (out) {
      declined.style.display = 'block';
      panels[0].querySelector('.formnav').style.display = 'none';
      ev('quote_referred_out', { job_type: jt, budget: bg });
      return false;
    }
    return true;
  }
  var undecl = document.getElementById('undecline');
  if (undecl) undecl.addEventListener('click', function (e) {
    e.preventDefault();
    declined.style.display = 'none';
    panels[0].querySelector('.formnav').style.display = 'flex';
    form.querySelectorAll('.chips').forEach(function (g) { g.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); }); });
    ['jobType', 'budget'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
  });

  // ---- files ----
  var box = document.getElementById('filebox');
  var input = document.getElementById('fileinput');
  var list = document.getElementById('filelist');
  var files = [];
  function fmt(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB'; }
  function draw() {
    if (!list) return;
    list.innerHTML = '';
    files.forEach(function (f, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="fn"></span><span class="fs">' + fmt(f.size) +
        '</span><button type="button" aria-label="Remove file">×</button>';
      li.querySelector('.fn').textContent = f.name;
      li.querySelector('button').addEventListener('click', function () { files.splice(i, 1); draw(); });
      list.appendChild(li);
    });
    var note = document.getElementById('filenote');
    if (note) {
      var total = files.reduce(function (s, f) { return s + f.size; }, 0);
      note.textContent = files.length ? files.length + ' file' + (files.length > 1 ? 's' : '') + ' · ' + fmt(total) + ' of 100 MB' : '';
    }
  }
  function add(fl) {
    var msgs = [];
    [].slice.call(fl).forEach(function (f) {
      if (!OK_EXT.test(f.name)) { msgs.push(f.name + ': type not accepted'); return; }
      if (f.size > MAX_FILE) { msgs.push(f.name + ' is over 50 MB'); return; }
      if (files.length >= MAX_COUNT) { msgs.push('Maximum ' + MAX_COUNT + ' files'); return; }
      var total = files.reduce(function (s, x) { return s + x.size; }, 0);
      if (total + f.size > MAX_TOTAL) { msgs.push('100 MB total reached — email the rest through'); return; }
      files.push(f);
    });
    draw();
    var warn = document.getElementById('filewarn');
    if (warn) { warn.textContent = msgs.join('. '); warn.style.display = msgs.length ? 'block' : 'none'; }
  }
  if (box && input) {
    box.addEventListener('click', function () { input.click(); });
    box.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { add(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) { box.addEventListener(t, function (e) { e.preventDefault(); box.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (t) { box.addEventListener(t, function (e) { e.preventDefault(); box.classList.remove('drag'); }); });
    box.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) add(e.dataTransfer.files); });
  }

  // ---- files: reject empties (a 0-byte upload session can never complete) ----
  var _origAdd = add;

  // ---- submit: two steps. JSON first (lead is captured even if uploads later fail),
  // then each file goes from THIS BROWSER straight to Microsoft, then we report back. ----
  function jfetch(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
      });
  }
  var CHUNK = 5 * 1024 * 1024; // multiple of 320 KiB, as Graph requires
  function putFile(f, uploadUrl, onBytes) {
    var pos = 0;
    function step() {
      if (pos >= f.size) return Promise.resolve();
      var end = Math.min(pos + CHUNK, f.size);
      return fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': 'bytes ' + pos + '-' + (end - 1) + '/' + f.size },
        body: f.slice(pos, end)
      }).then(function (r) {
        if (!r.ok && r.status !== 202) throw new Error('upload ' + r.status);
        onBytes(end - pos); pos = end; return step();
      });
    }
    return step();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validPanel(panels[cur])) return;
    files = files.filter(function (f) { return f.size > 0; });
    var btn = form.querySelector('[type="submit"]');
    btn.disabled = true; btn.textContent = 'Sending\u2026';

    var body = { audience: AUD, files: files.map(function (f) { return { name: f.name, size: f.size }; }) };
    ['name', 'phone', 'email', 'suburb', 'address', 'jobType', 'budget', 'timeline', 'message', 'company', 'website']
      .forEach(function (k) { var el = form.querySelector('[name="' + k + '"]'); if (el) body[k] = el.value; });
    // Commercial extras: composed into fields the tool already stores, so the
    // estimator sees them structured at the top of the lead.
    function val(n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ''; }
    if (AUD === 'commercial') {
      var head = [];
      if (val('projectStatus')) head.push('Status: ' + val('projectStatus'));
      if (val('projectName')) head.push('Project: ' + val('projectName'));
      if (val('principal')) head.push('Principal/builder: ' + val('principal'));
      if (head.length) body.message = head.join(' \u00b7 ') + '\n\n' + (body.message || '');
      var tl = [];
      if (val('tenderClose')) tl.push('Tender closes ' + val('tenderClose'));
      if (val('commencement')) tl.push('commencement ' + val('commencement'));
      if (tl.length) body.timeline = ((body.timeline || '') + ' \u00b7 ' + tl.join(' \u00b7 ')).replace(/^ \u00b7 /, '');
    }
    try {
      body.page = sessionStorage.getItem('el_landing') || location.pathname;
      body.utm = JSON.parse(sessionStorage.getItem('el_utm') || '{}');
    } catch (err) { body.page = location.pathname; }

    var meter = document.getElementById('upmeter');
    var barI = meter ? meter.querySelector('.bar i') : null;
    var pct = meter ? meter.querySelector('.pct') : null;

    function finish(ref, note) {
      ev(AUD === 'commercial' ? 'tender_submitted' : 'quote_submitted', { files: files.length });
      say('Enquiry sent successfully.');
      form.style.display = 'none';
      var done = document.getElementById('done');
      var refEl = document.getElementById('doneref');
      if (refEl && ref) refEl.textContent = ref;
      if (note && done) {
        var p = document.createElement('p');
        p.style.cssText = 'margin-top:10px;font-weight:700;color:#8a5a00';
        p.textContent = note;
        done.appendChild(p);
      }
      if (done) { done.style.display = 'block'; done.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    function fail(msg) {
      btn.disabled = false; btn.textContent = btn.dataset.label || 'Send enquiry';
      if (meter) meter.classList.remove('on');
      var warn = document.getElementById('sendwarn');
      if (warn) {
        warn.style.display = 'block';
        warn.textContent = msg || 'That didn\u2019t send \u2014 check your connection and try again, or email enquiry@estatelandscapers.com.au with your details.';
      }
      ev('enquiry_failed');
    }

    jfetch(API, body).then(function (j) {
      if (j._status >= 300 || !j.ok) return fail(j.error);
      var ref = j.ref;
      var uploads = j.uploads || [];
      if (!files.length) return finish(ref);
      if (!uploads.length) return finish(ref, j.message ||
        'We couldn\u2019t attach your files \u2014 please email them to enquiry@estatelandscapers.com.au quoting ' + ref + '.');

      if (meter) meter.classList.add('on');
      var total = files.reduce(function (s, f) { return s + f.size; }, 0), sent = 0;
      var okNames = [], badNames = [], i = 0;
      function tick(n) {
        sent += n;
        var v = Math.min(100, Math.round(sent / total * 100));
        if (barI) barI.style.width = v + '%';
        if (pct) pct.textContent = 'file ' + Math.min(i + 1, files.length) + ' of ' + files.length + ' \u00b7 ' + v + '%';
        if (v % 25 === 0) say('Uploading, ' + v + ' percent.');
      }
      function next() {
        if (i >= files.length) {
          return jfetch(API + '/' + encodeURIComponent(ref) + '/complete',
            { uploaded: okNames, failed: badNames }).catch(function () {})
            .then(function () {
              finish(ref, badNames.length
                ? 'These files didn\u2019t upload: ' + badNames.join(', ') + ' \u2014 please email them through quoting ' + ref + '.'
                : null);
            });
        }
        var f = files[i];
        var u = uploads.find(function (x) { return x && x.name && f.name.indexOf(x.name.split(' ')[0]) > -1; }) || uploads[i];
        var p = (u && u.uploadUrl)
          ? putFile(f, u.uploadUrl, tick).then(function () { okNames.push(f.name); })
                                        .catch(function () { badNames.push(f.name); tick(0); })
          : Promise.resolve(badNames.push(f.name));
        return p.then(function () { i++; return next(); });
      }
      next();
    }).catch(function () { fail(); });
  });
})();
