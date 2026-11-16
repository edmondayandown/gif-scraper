/* GIF Grabber — shared helpers (content script, popup, service worker).
 * Verified against live sites (Oct 2026):
 *  - Tenor originals:  https://media.tenor.com/{11-char id}AAAAC/{slug}.gif
 *      (grid thumbs use labels AAAAM/.gif, AAAA1/.webp, AAAP1/.mp4)
 *  - Giphy originals:  https://media.giphy.com/media/{id}/giphy.gif
 */
(function (root) {
  'use strict';

  /** 'tenor' | 'giphy' | null */
  function detectSite(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (/(^|\.)tenor\.com$/.test(h)) return 'tenor';
    if (/(^|\.)giphy\.com$/.test(h)) return 'giphy';
    return null;
  }

  /**
   * Parse any media.tenor.com URL.
   * Handles: https://media.tenor.com/{id}{label}/{slug}.{ext}
   *          https://media1.tenor.com/m/{id}{label}/{slug}.{ext}
   * @returns {{id:string,label:string,slug:string}|null}
   */
  function parseTenorMedia(url) {
    try {
      const u = new URL(url, 'https://tenor.com');
      if (!/(^|\.)tenor\.com$/.test(u.hostname)) return null;
      let path = u.pathname;
      try { path = decodeURIComponent(path); } catch (e) { /* keep raw */ }
      path = path.replace(/^\/m\//, '/');
      const m = path.match(/^\/([A-Za-z0-9_-]{11})([A-Za-z0-9]{5})\/([^/?#]+)$/i);
      if (!m) return null;
      const file = m[3];
      const em = file.match(/\.(gif|webp|mp4|webm|jpg|jpeg|png)$/i);
      if (!em) return null;
      const slug = file.slice(0, file.length - em[0].length);
      return { id: m[1], label: m[2].toUpperCase(), slug: slug || '' };
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse any *.giphy.com media URL.
   * Handles /media/{id}/{name}.ext and /media/v1.{token}/{id}/{name}.ext
   * @returns {{id:string,name:string}|null}
   */
  function parseGiphyMedia(url) {
    try {
      const u = new URL(url, 'https://giphy.com');
      if (!/(^|\.)giphy\.com$/.test(u.hostname)) return null;
      const m = u.pathname.match(/\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)\.(gif|webp|mp4|webm|jpg|jpeg|png|json)$/i);
      if (!m) return null;
      return { id: m[1], name: m[2] };
    } catch (e) {
      return null;
    }
  }

  /**
   * Ordered candidate URLs for the original full-size GIF, best first.
   * Callers should probe each candidate and use the first real GIF.
   */
  function gifCandidates(rec) {
    const out = [];
    if (rec && rec.site === 'tenor') {
      const id = rec.id;
      const slug = rec.slug || 'tenor';
      out.push('https://media.tenor.com/' + id + 'AAAAC/' + slug + '.gif');
      out.push('https://media1.tenor.com/m/' + id + 'AAAAC/' + slug + '.gif');
      if (slug !== 'tenor') out.push('https://media.tenor.com/' + id + 'AAAAC/tenor.gif');
      if (rec.src && /\.gif($|\?)/i.test(rec.src)) out.push(rec.src);
    } else if (rec && rec.site === 'giphy') {
      out.push('https://media.giphy.com/media/' + rec.id + '/giphy.gif');
      out.push('https://i.giphy.com/media/' + rec.id + '/giphy.gif');
      if (rec.src && /\.gif($|\?)/i.test(rec.src)) out.push(rec.src);
    }
    return out;
  }

  /** First bytes look like a GIF87a/GIF89a file? */
  function isGifBytes(u8) {
    return !!u8 && u8.length >= 6 &&
      u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38 &&
      (u8[4] === 0x37 || u8[4] === 0x39) && u8[5] === 0x61;
  }

  /** Make a safe file-name base from a search term. */
  function sanitizeTerm(s) {
    let t = String(s || '').trim();
    if (!t) return 'gifs';
    t = t
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!t) t = 'gifs';
    return t.slice(0, 60);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  root.GG = {
    detectSite: detectSite,
    parseTenorMedia: parseTenorMedia,
    parseGiphyMedia: parseGiphyMedia,
    gifCandidates: gifCandidates,
    isGifBytes: isGifBytes,
    sanitizeTerm: sanitizeTerm,
    sleep: sleep
  };
})(globalThis);
