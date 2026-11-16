/* GIF Grabber — service worker: resolves original GIF URLs, runs the download
 * queue, assigns search-term file names (term.gif / term_1.gif / term_2.gif…),
 * skips duplicates, shows progress on the badge and notifies on completion. */
'use strict';
importScripts('lib/gg-core.js');

const QUEUE = [];
let running = false;
let cancelFlag = false;

const sleep = GG.sleep;

/* session storage must be readable from content scripts (HUD progress) */
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* older Chrome */ }

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get({ skipDupes: true });
  await chrome.storage.local.set(cur);
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
});

/* ---------------- storage helpers ---------------- */

async function getCounts() {
  const o = await chrome.storage.session.get({ gg_counts: {} });
  return o.gg_counts;
}

function setProgress(p) {
  return chrome.storage.session.set({ gg_progress: p }).catch(() => {});
}

/* ---------------- badge ---------------- */

function badgeTab(tabId, text) {
  if (tabId == null) return;
  try { chrome.action.setBadgeText({ tabId: tabId, text: text }).catch(() => {}); } catch (e) {}
}

function badgeColor(tabId, color) {
  if (tabId == null) return;
  try { chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color }).catch(() => {}); } catch (e) {}
}

/* ---------------- URL resolution ---------------- */

const resolveCache = new Map();

/** Range-GET probe: real GIF, not a 43-byte placeholder. */
async function probeGif(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-2047' }, credentials: 'omit' });
    if (!res.ok && res.status !== 206) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!GG.isGifBytes(buf)) return false;
    const cr = res.headers.get('content-range');
    const totalSize = cr
      ? parseInt(String(cr).split('/')[1], 10) || 0
      : parseInt(res.headers.get('content-length') || '0', 10);
    if (totalSize && totalSize < 2048) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function resolveUrl(rec) {
  if (!rec || !rec.site || !rec.id) return null;
  const ck = rec.site + ':' + rec.id;
  if (resolveCache.has(ck)) return resolveCache.get(ck);
  const candidates = GG.gifCandidates(rec);
  for (const c of candidates) {
    if (await probeGif(c)) {
      resolveCache.set(ck, c);
      return c;
    }
  }
  return null;
}

async function resolveAll(records) {
  const results = new Array(records.length);
  let idx = 0;
  const worker = async () => {
    while (idx < records.length) {
      const i = idx++;
      const r = records[i];
      const url = await resolveUrl(r).catch(() => null);
      results[i] = { key: r.key, url: url };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return results;
}

/* ---------------- naming ---------------- */

/**
 * term.gif for the first single save; term_1.gif, term_2.gif… from then on.
 * Batches of N get term_1…term_N (continuing the session counter per term).
 */
async function assignNames(term, total) {
  const counts = await getCounts();
  const start = counts[term] || 0;
  let names;
  if (total === 1) {
    const n = start + 1;
    names = [n === 1 ? term + '.gif' : term + '_' + (n - 1) + '.gif'];
    counts[term] = n;
  } else {
    names = [];
    for (let i = 0; i < total; i++) names.push(term + '_' + (start + i + 1) + '.gif');
    counts[term] = start + total;
  }
  await chrome.storage.session.set({ gg_counts: counts });
  return names;
}

/* ---------------- notifications ---------------- */

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: String(message || '').slice(0, 400)
    });
  } catch (e) { /* notifications unavailable */ }
}

/* ---------------- job runner ---------------- */

async function handleOne(msg, tabId) {
  const rec = msg.record;
  if (!rec || !rec.site || !rec.id) return { ok: false, error: 'bad record' };
  const term = GG.sanitizeTerm(msg.record.term || '');
  const url = await resolveUrl(rec);
  if (!url) return { ok: false, error: 'original GIF not found' };
  const counts = await getCounts();
  const n = (counts[term] || 0) + 1;
  counts[term] = n;
  await chrome.storage.session.set({ gg_counts: counts });
  const name = n === 1 ? term + '.gif' : term + '_' + (n - 1) + '.gif';
  try {
    await chrome.downloads.download({ url: url, filename: name, conflictAction: 'uniquify', saveAs: false });
    const dl = await chrome.storage.session.get({ gg_downloaded: {} });
    dl.gg_downloaded[rec.site + ':' + rec.id] = name;
    await chrome.storage.session.set({ gg_downloaded: dl.gg_downloaded });
    badgeTab(tabId, '+1');
    badgeColor(tabId, '#16a34a');
    setTimeout(() => badgeTab(tabId, ''), 2500);
    return { ok: true, name: name };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function runJob(job) {
  const term = job.term;
  const tabId = job.tabId;
  let items = job.records;

  const settings = await chrome.storage.local.get({ skipDupes: true });
  const dl = await chrome.storage.session.get({ gg_downloaded: {} });
  const downloaded = dl.gg_downloaded;

  let skipped = 0;
  if (settings.skipDupes) {
    items = items.filter((r) => {
      const k = r.site + ':' + r.id;
      if (downloaded[k]) { skipped++; return false; }
      return true;
    });
  }

  if (!items.length) {
    await setProgress({ phase: 'done', term: term, done: 0, total: 0, ok: 0, skipped: skipped, errors: 0 });
    if (job.auto) {
      notify('GIF Grabber', skipped
        ? 'All ' + skipped + ' GIFs were already downloaded this session.'
        : 'No new GIFs to download.');
    }
    return;
  }

  const total = items.length;
  const names = await assignNames(term, total);
  badgeColor(tabId, '#7c3aed');
  await setProgress({ phase: 'downloading', term: term, done: 0, total: total, current: names[0], skipped: skipped, ok: 0, errors: 0 });

  let ok = 0;
  const errors = [];
  for (let i = 0; i < total; i++) {
    if (cancelFlag) break;
    const it = items[i];
    let url = null;
    try { url = await resolveUrl(it); } catch (e) { url = null; }
    if (!url) {
      errors.push(names[i] + ': original not found');
    } else {
      try {
        await chrome.downloads.download({ url: url, filename: names[i], conflictAction: 'uniquify', saveAs: false });
        ok++;
        downloaded[it.site + ':' + it.id] = names[i];
      } catch (e) {
        errors.push(names[i] + ': ' + ((e && e.message) || e));
      }
    }
    await setProgress({ phase: 'downloading', term: term, done: i + 1, total: total, current: names[i], skipped: skipped, ok: ok, errors: errors.length });
    badgeTab(tabId, Math.round(((i + 1) / total) * 100) + '%');
    await sleep(120);
  }

  await chrome.storage.session.set({ gg_downloaded: downloaded });

  if (cancelFlag) {
    cancelFlag = false;
    await setProgress({ phase: 'cancelled', term: term, done: ok, total: total, ok: ok, errors: errors.length, skipped: skipped });
    badgeTab(tabId, '');
    notify('GIF Grabber — stopped', 'Saved ' + ok + '/' + total + ' files before stopping.');
    return;
  }

  await setProgress({ phase: 'done', term: term, done: ok, total: total, ok: ok, errors: errors.length, skipped: skipped });
  badgeColor(tabId, '#16a34a');
  badgeTab(tabId, 'OK');
  setTimeout(() => badgeTab(tabId, ''), 4000);
  if (job.auto || total > 2) {
    notify('GIF Grabber', 'Saved ' + ok + '/' + total + ' GIFs as "' + term + '_1 … ' + term + '_' + total + '"' +
      (errors.length ? ' (' + errors.length + ' failed)' : '') + '.');
  }
}

async function kickQueue() {
  if (running) return;
  running = true;
  try {
    while (QUEUE.length && !cancelFlag) {
      const job = QUEUE.shift();
      try { await runJob(job); } catch (e) { /* keep draining */ }
    }
  } finally {
    running = false;
    if (cancelFlag) {
      cancelFlag = false;
      await setProgress({ phase: 'cancelled', done: 0, total: 0 });
    }
  }
}

function enqueue(msg, tabId) {
  const term = GG.sanitizeTerm(msg.term || '');
  const recs = (msg.records || []).filter((r) => r && r.site && r.id);
  if (!recs.length) return 0;
  QUEUE.push({ term: term, records: recs, auto: !!msg.auto, tabId: tabId });
  kickQueue();
  return recs.length;
}

/* ---------------- messaging ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const tabId = sender && sender.tab ? sender.tab.id : null;
  switch (msg.type) {
    case 'GG_COUNT':
      badgeColor(tabId, '#7c3aed');
      badgeTab(tabId, msg.count ? String(Math.min(msg.count, 999)) : '');
      sendResponse({ ok: true });
      return false;
    case 'GG_ONE':
      handleOne(msg, tabId)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'GG_BULK': {
      const n = enqueue(msg, tabId);
      sendResponse({ ok: true, queued: n });
      return false;
    }
    case 'GG_RESOLVE':
      resolveAll(msg.records || [])
        .then((results) => sendResponse({ ok: true, results: results }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'GG_CANCEL':
      cancelFlag = true;
      sendResponse({ ok: true });
      return false;
  }
  return false;
});
