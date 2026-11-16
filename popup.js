/* GIF Grabber — popup logic: live state, selectable thumbnail grid,
 * bulk download, ZIP packing, copy links, auto-scroll control. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const GG = globalThis.GG;

  let tabId = null;
  let site = null;
  let records = [];
  const selected = new Set();
  const knownKeys = new Set();
  let pollTimer = null;
  let zipBusy = false;
  let lastKeys = '';

  /* ---------------- tab / state access ---------------- */

  async function getTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (e) {
      return null;
    }
  }

  async function fetchState() {
    if (tabId == null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'GG_GET' });
    } catch (e) {
      return null;
    }
  }

  async function injectContent() {
    try { await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['content.css'] }); } catch (e) {}
    try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['lib/gg-core.js', 'content.js'] }); } catch (e) {}
  }

  /* ---------------- rendering ---------------- */

  function showEmpty(text, showRetry) {
    $('#empty').classList.remove('hidden');
    $('#main').classList.add('hidden');
    $('#emptyText').textContent = text;
    $('#retryBtn').classList.toggle('hidden', !showRetry);
  }

  function showMain() {
    $('#empty').classList.add('hidden');
    $('#main').classList.remove('hidden');
  }

  function renderSite() {
    const b = $('#siteBadge');
    b.textContent = site === 'tenor' ? 'TENOR' : site === 'giphy' ? 'GIPHY' : '—';
  }

  function updateTermField(term) {
    const el = $('#term');
    if (document.activeElement !== el) el.value = term || '';
  }

  function syncSelection() {
    const alive = new Set(records.map((r) => r.key));
    for (const k of Array.from(selected)) if (!alive.has(k)) selected.delete(k);
    for (const k of Array.from(knownKeys)) if (!alive.has(k)) knownKeys.delete(k);
    for (const r of records) {
      if (!knownKeys.has(r.key)) {
        knownKeys.add(r.key);
        selected.add(r.key);
      }
    }
  }

  function renderGrid() {
    const grid = $('#grid');
    grid.innerHTML = '';
    if (!records.length) {
      grid.innerHTML = '<div class="grid-empty">No GIFs detected yet — scroll the page a little or press Rescan.</div>';
    } else {
      for (const r of records) {
        const cell = document.createElement('label');
        cell.className = 'cell' + (selected.has(r.key) ? '' : ' off');
        cell.title = r.title || '';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = r.thumb || '';
        img.alt = '';
        img.onerror = () => { img.style.visibility = 'hidden'; };
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(r.key);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(r.key);
          else selected.delete(r.key);
          cell.classList.toggle('off', !cb.checked);
          updateButtons();
        });
        cell.append(img, cb);
        grid.append(cell);
      }
    }
    updateButtons();
  }

  function renderGridIfChanged() {
    const keys = records.map((r) => r.key).join('|') + '#' + records.length;
    if (keys === lastKeys) return;
    lastKeys = keys;
    syncSelection();
    renderGrid();
  }

  function updateButtons() {
    $('#countLabel').textContent = records.length + ' GIF' + (records.length === 1 ? '' : 's');
    $('#dlLabel').textContent = zipBusy ? 'Working…' : 'Download' + (selected.size ? ' ' + selected.size : '');
    $('#dlBtn').disabled = zipBusy;
    $('#zipBtn').disabled = zipBusy;
  }

  function renderAuto(state) {
    const t = $('#autoToggle');
    const seg = $('#modeSeg');
    t.checked = !!state.running;
    seg.classList.toggle('disabled', !!state.running);
    if (!state.running) {
      const want = state.mode === 'collect' ? 'collect' : 'grab';
      const radio = document.querySelector('input[name=mode][value="' + want + '"]');
      if (radio) radio.checked = true;
    }
    const s = $('#autoStatus');
    if (state.running && state.phase === 'scrolling') s.textContent = 'Scrolling — ' + state.found + ' found…';
    else if (state.running) s.textContent = 'Working — you can close this popup';
    else s.textContent = 'Off';
  }

  function showProgress(v) {
    const box = $('#progress');
    if (!v || v.phase === 'idle') {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const labelMap = {
      resolving: 'Resolving originals…',
      zipping: 'Packing ZIP…',
      downloading: 'Downloading…',
      done: 'Complete',
      cancelled: 'Stopped'
    };
    $('#phaseLabel').textContent = labelMap[v.phase] || v.phase;
    const total = v.total || 0;
    const done = v.done || 0;
    $('#counter').textContent = total ? done + '/' + total : '';
    $('#fill').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    $('#fill').classList.toggle('ok', v.phase === 'done');
    $('#fill').classList.toggle('err', v.phase === 'cancelled');
    const bits = [];
    if (v.current) bits.push(v.current);
    if (v.skipped) bits.push(v.skipped + ' skipped');
    if (v.errors) bits.push(v.errors + ' failed');
    $('#subLabel').textContent = bits.join(' · ');
    if (v.phase === 'done' || v.phase === 'cancelled') {
      setTimeout(() => box.classList.add('hidden'), 5000);
    }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t.__t);
    t.__t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  /* ---------------- actions ---------------- */

  function currentTermInput() {
    return $('#term').value || '';
  }

  async function downloadSelected() {
    const items = records.filter((r) => selected.has(r.key));
    if (!items.length) {
      toast('Nothing selected');
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: 'GG_BULK', records: items, term: currentTermInput(), auto: false });
      toast('Queued ' + items.length + ' download' + (items.length === 1 ? '' : 's'));
    } catch (e) {
      toast('Failed to queue downloads');
    }
  }

  function numberNames(term, k) {
    if (k === 1) return [term + '.gif'];
    const names = [];
    for (let i = 0; i < k; i++) names.push(term + '_' + (i + 1) + '.gif');
    return names;
  }

  async function doZip() {
    if (zipBusy) return;
    const items = records.filter((r) => selected.has(r.key));
    if (!items.length) {
      toast('Nothing selected');
      return;
    }
    if (items.length > 120 && !confirm('Packing ' + items.length + ' GIFs can use a lot of memory. Continue?')) return;
    zipBusy = true;
    updateButtons();
    const term = GG.sanitizeTerm(currentTermInput() || 'gifs');
    try {
      showProgress({ phase: 'resolving', done: 0, total: items.length });
      const res = await chrome.runtime.sendMessage({ type: 'GG_RESOLVE', records: items });
      const results = res && res.ok ? res.results : [];
      const good = items.filter((it, i) => results[i] && results[i].url).map((it, i) => ({ name: it, url: results[i].url }));
      if (!good.length) {
        toast('Could not resolve original GIF URLs');
        showProgress(null);
        return;
      }
      const names = numberNames(term, good.length);
      const zip = new MiniZip();
      showProgress({ phase: 'zipping', done: 0, total: good.length });
      for (let i = 0; i < good.length; i++) {
        const resp = await fetch(good[i].url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + names[i]);
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (!GG.isGifBytes(buf)) throw new Error('Not a GIF file: ' + names[i]);
        zip.add(names[i], buf);
        showProgress({ phase: 'zipping', done: i + 1, total: good.length, current: names[i] });
      }
      const blob = zip.finish();
      const blobUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({ url: blobUrl, filename: term + '.zip', conflictAction: 'uniquify', saveAs: false });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 90000);
      showProgress({ phase: 'done', done: good.length, total: good.length });
      toast('Saved ' + term + '.zip');
    } catch (e) {
      toast('ZIP failed: ' + (e && e.message ? e.message : e));
      showProgress(null);
    } finally {
      zipBusy = false;
      updateButtons();
    }
  }

  async function copyLinks() {
    const items = records.filter((r) => selected.has(r.key));
    if (!items.length) {
      toast('Nothing selected');
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GG_RESOLVE', records: items });
      const results = res && res.ok ? res.results : [];
      const urls = results.filter((r) => r && r.url).map((r) => r.url);
      if (!urls.length) {
        toast('Could not resolve original URLs');
        return;
      }
      await navigator.clipboard.writeText(urls.join('\n'));
      toast('Copied ' + urls.length + ' link' + (urls.length === 1 ? '' : 's'));
    } catch (e) {
      toast('Copy failed');
    }
  }

  /* ---------------- refresh loop ---------------- */

  async function refresh() {
    const st = await fetchState();
    if (!st) {
      const tab = await getTab();
      const host = tab && tab.url ? String(tab.url).replace(/^[a-z]+:\/\//i, '').split('/')[0].toLowerCase() : '';
      const supported = /(^|\.)tenor\.com$/.test(host) || /(^|\.)giphy\.com$/.test(host);
      if (supported) {
        showEmpty('GIF Grabber could not read this page. Reload the page, then click the icon again.', true);
      } else {
        showEmpty('Open tenor.com or giphy.com, search for GIFs, then click the GIF Grabber icon.', false);
      }
      return;
    }
    site = st.site;
    records = st.records || [];
    renderSite();
    showMain();
    updateTermField(st.term);
    renderGridIfChanged();
    renderAuto(st.scroll || { running: false, phase: 'idle', found: 0, mode: 'grab' });
  }

  /* ---------------- init ---------------- */

  async function init() {
    const tab = await getTab();
    tabId = tab ? tab.id : null;

    const store = await chrome.storage.local.get({ skipDupes: true });
    $('#skipDupes').checked = store.skipDupes;
    $('#skipDupes').addEventListener('change', (e) => {
      chrome.storage.local.set({ skipDupes: e.target.checked });
    });

    $('#dlBtn').addEventListener('click', downloadSelected);
    $('#zipBtn').addEventListener('click', doZip);
    $('#copyBtn').addEventListener('click', copyLinks);
    $('#rescanBtn').addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'GG_RESCAN' });
        toast('Rescanned');
      } catch (e) {
        toast('Cannot reach this page');
      }
      refresh();
    });
    $('#retryBtn').addEventListener('click', async () => {
      await injectContent();
      setTimeout(refresh, 600);
    });
    $('#allBtn').addEventListener('click', () => {
      for (const r of records) selected.add(r.key);
      renderGrid();
    });
    $('#noneBtn').addEventListener('click', () => {
      selected.clear();
      renderGrid();
    });

    let termTimer = null;
    $('#term').addEventListener('input', (e) => {
      clearTimeout(termTimer);
      termTimer = setTimeout(() => {
        try {
          chrome.tabs.sendMessage(tabId, { type: 'GG_SET_TERM', term: e.target.value });
        } catch (err) { /* page gone */ }
      }, 350);
    });

    $('#autoToggle').addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        if (on) {
          const mode = (document.querySelector('input[name=mode]:checked') || {}).value || 'grab';
          try {
            await chrome.tabs.sendMessage(tabId, { type: 'GG_SET_TERM', term: $('#term').value });
          } catch (err) { /* ignore */ }
          await chrome.tabs.sendMessage(tabId, { type: 'GG_SCROLL_START', mode: mode });
        } else {
          await chrome.tabs.sendMessage(tabId, { type: 'GG_SCROLL_STOP' });
        }
      } catch (err) {
        toast('Cannot control auto-scroll here');
        e.target.checked = false;
      }
      refresh();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.gg_progress) showProgress(changes.gg_progress.newValue);
    });

    await refresh();
    pollTimer = setInterval(refresh, 900);
    window.addEventListener('unload', () => clearInterval(pollTimer));
  }

  init();
})();
