/* GIF Grabber — content script for tenor.com & giphy.com
 * Detects GIFs (including scroll-loaded ones), adds hover download buttons,
 * runs the auto-scroll engine and shows an on-page HUD. */
(function () {
  'use strict';
  if (window.__GG_ACTIVE__) return;
  window.__GG_ACTIVE__ = true;

  const GG = globalThis.GG;
  const site = GG.detectSite(location.hostname);
  if (!site) return;

  const MAX_RECORDS = 300;
  const records = new Map();          // key -> record
  let termOverride = '';
  let lastPath = location.pathname + location.search;
  let lastBadgeCount = -1;
  let lastSeenKeys = '';

  const scrollState = { running: false, mode: 'grab', phase: 'idle', stopFlag: false };
  let hud = null;
  let hudHideTimer = null;

  /* ================= search term ================= */

  function detectTerm() {
    if (termOverride.trim()) return termOverride.trim();
    try {
      if (site === 'tenor') {
        const inp = document.querySelector('input[name="q"]');
        if (inp && inp.value.trim()) return inp.value.trim();
        const m = location.pathname.match(/^\/search\/([^/?#]+?)(?:-gifs|-stickers)?\/?$/i);
        if (m) return decodeURIComponent(m[1]).replace(/[-+]+/g, ' ').trim();
      } else {
        const m = location.pathname.match(/^\/(?:search|explore)\/([^/?#]+)/i);
        if (m) return decodeURIComponent(m[1]).replace(/[-+]+/g, ' ').trim();
        const inp = document.querySelector('header input[type="text"], input[name="q"], input[placeholder*="Search" i]');
        if (inp && inp.value.trim()) return inp.value.trim();
      }
      const t = (document.title || '').trim();
      const tm = t.match(/^(.*?)(?:\s+GIFs?|\s+Stickers?)\s*(?:[-\u2013\u2014|]|\||$)/i);
      if (tm && tm[1] && tm[1].trim()) return tm[1].trim();
    } catch (e) { /* fall through */ }
    return '';
  }

  function currentTerm() {
    return detectTerm() || (site === 'tenor' ? 'tenor' : 'giphy');
  }

  /* ================= records ================= */

  function stripQuery(u) { return String(u || '').split('?')[0]; }

  function buildThumb(parsed, url, el) {
    if (site === 'giphy') return stripQuery(url);
    if (el && el.tagName === 'IMG') return stripQuery(url);
    // video-only preview: build the webp thumb variant
    return 'https://media.tenor.com/' + parsed.id + 'AAAA1/' + (parsed.slug || 'gif') + '.webp';
  }

  function addFromUrl(rawUrl, el) {
    if (!rawUrl || /^(data:|blob:|about:)/i.test(rawUrl)) return;
    if (site === 'tenor') {
      const p = GG.parseTenorMedia(rawUrl);
      if (!p) return;
      const key = 't:' + p.id;
      let rec = records.get(key);
      if (!rec) {
        if (records.size >= MAX_RECORDS) return;
        rec = {
          key: key, site: 'tenor', id: p.id, slug: p.slug,
          src: rawUrl, thumb: buildThumb(p, rawUrl, el),
          title: (p.slug || '').replace(/[-_]+/g, ' ') || 'tenor gif'
        };
        records.set(key, rec);
        onRecordsChanged();
      } else if (el && el.tagName === 'IMG' && !rec.thumbIsImg) {
        rec.thumb = stripQuery(rawUrl);
        rec.thumbIsImg = true;
      }
      attachCard(el, rec);
    } else {
      const p = GG.parseGiphyMedia(rawUrl);
      if (!p) return;
      const key = 'g:' + p.id;
      let rec = records.get(key);
      if (!rec) {
        if (records.size >= MAX_RECORDS) return;
        const alt = el && el.getAttribute ? (el.getAttribute('alt') || '') : '';
        rec = {
          key: key, site: 'giphy', id: p.id, slug: '',
          src: stripQuery(rawUrl), thumb: stripQuery(rawUrl),
          title: alt.replace(/\s+/g, ' ').trim() || 'giphy gif'
        };
        records.set(key, rec);
        onRecordsChanged();
      }
      attachCard(el, rec);
    }
  }

  /**
   * Giphy cell scan: grid items are <a data-giphy-id="..."> wrapping
   * <picture><source srcset=webp><img src=gif></picture>. Cells may render
   * video-only previews or lazy placeholders, and Giphy virtualizes the grid
   * (off-screen cells unmount). Scanning the anchors directly gives us the ID
   * even when no <img> URL is currently parseable, and records persist in the
   * Map so virtualized-away GIFs stay in the list.
   */
  function scanGiphyCells() {
    if (site !== 'giphy') return;
    const anchors = document.querySelectorAll('a[data-giphy-id], a[href*="/gifs/"], a[href*="/stickers/"]');
    for (const a of anchors) {
      let id = (a.getAttribute('data-giphy-id') || '').trim();
      if (!id) {
        try {
          const h = new URL(a.getAttribute('href') || '', location.origin).pathname;
          const m = h.match(/\/(?:gifs|stickers)\/[^/]*?([A-Za-z0-9]{10,32})\/?$/);
          if (m) id = m[1];
        } catch (e) { /* skip */ }
      }
      if (!id || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) continue;
      const key = 'g:' + id;
      let rec = records.get(key);
      // best parseable media URL inside the cell (prefer a real .gif over webp)
      let firstUrl = '';
      let gifUrl = '';
      let alt = '';
      const probe = a.querySelectorAll('img[src], source[srcset], img[srcset], video source[src]');
      for (const el of probe) {
        if (!alt && el.tagName === 'IMG') alt = el.getAttribute('alt') || '';
        const cand = el.tagName === 'IMG'
          ? (el.getAttribute('src') || '')
          : ((el.getAttribute('srcset') || '').split(',')[0].trim().split(/\s+/)[0] || '');
        if (!cand || /^(data:|blob:|about:)/i.test(cand)) continue;
        if (GG.parseGiphyMedia(cand)) {
          if (!firstUrl) firstUrl = cand;
          if (/\.gif($|\?)/i.test(cand)) { gifUrl = cand; break; }
        }
      }
      const mediaUrl = gifUrl || firstUrl;
      if (!rec) {
        if (records.size >= MAX_RECORDS) return;
        if (!alt) alt = (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim();
        rec = {
          key: key, site: 'giphy', id: id, slug: '',
          src: mediaUrl ? stripQuery(mediaUrl) : '',
          thumb: mediaUrl ? stripQuery(mediaUrl) : ('https://media.giphy.com/media/' + id + '/200w.gif'),
          title: alt || 'giphy gif'
        };
        records.set(key, rec);
        onRecordsChanged();
      } else if (mediaUrl) {
        if (!rec.src) rec.src = stripQuery(mediaUrl);
        if (!rec.thumb || /200w\.gif$/.test(rec.thumb)) rec.thumb = stripQuery(mediaUrl);
      }
      attachCard(a, rec);
    }
  }

  function scan() {
    const nodes = document.querySelectorAll('img[src], img[srcset], video[src], source[src], source[srcset]');
    for (const el of nodes) {
      const urls = [el.getAttribute('src') || ''];
      const srcset = el.getAttribute('srcset') || '';
      if (srcset) {
        for (const part of srcset.split(',')) {
          const u = part.trim().split(/\s+/)[0];
          if (u) urls.push(u);
        }
      }
      for (const u of urls) addFromUrl(u, el);
    }
    if (site === 'giphy') scanGiphyCells();
  }

  /* ================= hover download button ================= */

  function findCard(el) {
    const a = el.closest && el.closest('a[href]');
    let card = a || el;
    for (let i = 0; i < 3 && card; i++) {
      const p = card.parentElement;
      if (!p || p === document.body) break;
      const cr = card.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      if (!pr.width || !cr.width) break;
      if (pr.width - cr.width > 24 || pr.height - cr.height > 24) break;
      card = p;
    }
    return card;
  }

  const BTN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>';

  function attachCard(el, rec) {
    const card = findCard(el);
    if (!card || card === document.body) return;
    if (card.querySelector(':scope > button.gg-btn')) return;
    card.classList.add('gg-card');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gg-btn';
    btn.title = 'Download original GIF';
    btn.setAttribute('aria-label', 'Download original GIF');
    btn.innerHTML = BTN_SVG;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('gg-busy')) return;
      btn.classList.add('gg-busy');
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({
          type: 'GG_ONE',
          record: Object.assign({}, rec, { term: currentTerm() })
        });
      } catch (err) { res = null; }
      btn.classList.remove('gg-busy');
      btn.classList.add(res && res.ok ? 'gg-ok' : 'gg-err');
      btn.title = res && res.ok ? ('Saved as ' + res.name) : ('Failed: ' + ((res && res.error) || 'unknown'));
      setTimeout(() => btn.classList.remove('gg-ok', 'gg-err'), 1400);
    }, true);
    card.appendChild(btn);
  }

  /* ================= badge / change notifications ================= */

  let badgeTimer = null;
  function onRecordsChanged() {
    if (badgeTimer) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      const c = records.size;
      if (c !== lastBadgeCount) {
        lastBadgeCount = c;
        try {
          const p = chrome.runtime.sendMessage({ type: 'GG_COUNT', count: c });
          if (p && p.catch) p.catch(() => {});
        } catch (e) { /* sw asleep */ }
      }
    }, 400);
  }

  /* ================= HUD ================= */

  function ensureHud() {
    if (hud && hud.el.isConnected) return hud;
    const el = document.createElement('div');
    el.className = 'gg-hud';
    el.innerHTML =
      '<svg class="gg-hud-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>' +
      '<div class="gg-hud-main"><div class="gg-hud-status">GIF Grabber</div>' +
      '<div class="gg-hud-bar gg-hidden"><div class="gg-hud-fill"></div></div></div>' +
      '<button class="gg-hud-stop" type="button">Stop</button>';
    document.documentElement.appendChild(el);
    hud = {
      el: el,
      status: el.querySelector('.gg-hud-status'),
      bar: el.querySelector('.gg-hud-bar'),
      fill: el.querySelector('.gg-hud-fill'),
      stop: el.querySelector('.gg-hud-stop')
    };
    hud.stop.addEventListener('click', stopAll);
    return hud;
  }

  function hudShow() {
    clearTimeout(hudHideTimer);
    const h = ensureHud();
    h.el.style.display = 'flex';
  }

  function hudHideSoon(ms) {
    clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (hud) hud.el.style.display = 'none';
    }, ms);
  }

  function hudNote(text, idle) {
    const h = ensureHud();
    hudShow();
    h.status.textContent = text;
    h.el.classList.toggle('gg-hud-idle', !!idle);
  }

  function hudProgress(done, total) {
    if (!hud) return;
    hud.bar.classList.remove('gg-hidden');
    hud.fill.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  }

  function stopAll() {
    scrollState.stopFlag = true;
    try {
      const p = chrome.runtime.sendMessage({ type: 'GG_CANCEL' });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
    hudNote('Stopping…');
  }

  /* live download progress from the background worker */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.gg_progress || !hud || hud.el.style.display === 'none') return;
    const p = changes.gg_progress.newValue;
    if (!p) return;
    if (p.phase === 'downloading') {
      hudProgress(p.done, p.total);
      hud.status.textContent = 'Downloading ' + p.done + '/' + p.total + (p.current ? ' — ' + p.current : '');
      hud.el.classList.add('gg-hud-idle');
    } else if (p.phase === 'done') {
      hudProgress(p.done, p.total);
      hud.status.textContent = 'Saved ' + p.done + '/' + p.total + (p.skipped ? ' (' + p.skipped + ' skipped)' : '');
      hud.el.classList.add('gg-hud-idle', 'gg-hud-done');
      hudHideSoon(5000);
    } else if (p.phase === 'cancelled') {
      hud.status.textContent = 'Stopped at ' + (p.done || 0) + '/' + (p.total || 0);
      hud.el.classList.add('gg-hud-idle');
      hudHideSoon(4000);
    }
  });

  /* ================= auto-scroll engine ================= */

  async function startScroll(mode) {
    if (scrollState.running) return;
    scrollState.running = true;
    scrollState.mode = mode === 'collect' ? 'collect' : 'grab';
    scrollState.phase = 'scrolling';
    scrollState.stopFlag = false;
    hudShow();
    hudNote('Auto-scroll — collecting GIFs…');
    const t0 = Date.now();
    let last = records.size;
    let still = 0;

    while (!scrollState.stopFlag) {
      window.scrollBy({ top: Math.max(320, Math.round(window.innerHeight * 0.85)), left: 0 });
      await GG.sleep(620);
      if (scrollState.stopFlag) break;
      scan();
      const n = records.size;
      scrollState.found = n;
      const de = document.documentElement;
      const atBottom = window.scrollY + window.innerHeight >= de.scrollHeight - 6;
      if (n === last && atBottom) still++;
      else if (n !== last) still = 0;
      last = n;
      hudNote('Scrolling — ' + n + ' GIF' + (n === 1 ? '' : 's') + ' found…');
      if (still >= 3 || n >= MAX_RECORDS || Date.now() - t0 > 120000) break;
    }

    scrollState.running = false;

    if (scrollState.stopFlag) {
      scrollState.phase = 'idle';
      hudNote('Stopped — ' + records.size + ' GIFs found', true);
      hudHideSoon(3500);
      return;
    }

    const found = records.size;
    if (scrollState.mode === 'grab' && found > 0) {
      scrollState.phase = 'grabbing';
      hudNote('Starting download of ' + found + ' GIFs…', true);
      try {
        await chrome.runtime.sendMessage({
          type: 'GG_BULK',
          records: Array.from(records.values()),
          term: currentTerm(),
          auto: true
        });
      } catch (e) {
        hudNote('Could not reach the downloader — reopen the popup', true);
        hudHideSoon(5000);
        scrollState.phase = 'idle';
        return;
      }
    } else {
      scrollState.phase = 'idle';
      hudNote('Found ' + found + ' GIF' + (found === 1 ? '' : 's') + ' — open GIF Grabber to download', true);
      hudHideSoon(6000);
    }
  }

  /* ================= messaging ================= */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'GG_GET':
        sendResponse({
          site: site,
          term: currentTerm(),
          count: records.size,
          records: Array.from(records.values()),
          scroll: {
            running: scrollState.running,
            mode: scrollState.mode,
            phase: scrollState.phase,
            found: records.size
          }
        });
        return false;
      case 'GG_SET_TERM':
        termOverride = String(msg.term || '');
        sendResponse({ ok: true });
        return false;
      case 'GG_RESCAN':
        scan();
        sendResponse({ count: records.size });
        return false;
      case 'GG_SCROLL_START':
        startScroll(msg.mode === 'collect' ? 'collect' : 'grab');
        sendResponse({ ok: true });
        return false;
      case 'GG_SCROLL_STOP':
        scrollState.stopFlag = true;
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && scrollState.running) stopAll();
  });

  /* ================= scanning triggers ================= */

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 220);
  }

  const mo = new MutationObserver(scheduleScan);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // safety-net rescan while the tab is visible
  setInterval(() => {
    if (document.visibilityState === 'visible') scan();
  }, 1500);

  // SPA navigation: fresh search page -> reset state
  setInterval(() => {
    const p = location.pathname + location.search;
    if (p !== lastPath) {
      lastPath = p;
      records.clear();
      lastBadgeCount = -1;
      termOverride = '';
      lastSeenKeys = '';
      document.querySelectorAll('button.gg-btn').forEach((b) => b.remove());
      scan();
    }
  }, 700);

  scan();
  window.addEventListener('load', () => { scan(); setTimeout(scan, 1500); });
})();
