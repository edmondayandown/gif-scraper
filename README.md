# GIF Grabber — Tenor & Giphy GIF Downloader (Chrome Extension)

GIF Grabber is a Manifest V3 Chrome extension that downloads **original full-quality GIF files** from tenor.com and giphy.com, naming every file after your search term.

## Features

- **Bulk download** — the popup shows every GIF detected on the page; check the ones you want and hit Download.
- **Hover one-click save** — move your mouse over any GIF card and a download button appears in its top-left corner. One click saves the original file.
- **Auto-scroll + auto-download** — flip the Auto-scroll toggle and the extension scrolls the whole results feed for you (loading every lazily-added GIF as it goes), then automatically downloads everything it found. A small HUD on the page shows live progress with a Stop button (Esc works too).
- **Search-term file naming** — searching "cute cat" saves `cute_cat.gif` for a single file, or `cute_cat_1.gif`, `cute_cat_2.gif`, `cute_cat_3.gif`… for batches. The term is auto-detected from the page (search box, URL and title); you can edit it in the popup before downloading.
- **Original quality only** — files are resolved to the true original GIF (Tenor `AAAAC` original, Giphy `giphy.gif`), verified by signature before saving; if a variant is missing it automatically falls back through alternative CDN URLs.
- **ZIP export** — pack the selected GIFs into a single `search_term.zip` (built-in packer, no internet service involved).
- **Copy links** — copy the resolved direct GIF URLs to your clipboard.
- **Duplicate skipping** — remembers what you already saved this browser session and skips it on bulk downloads (toggle in the popup; hover saves are always allowed).
- **Live progress** — progress bar in the popup, percentage on the extension badge, and a desktop notification when a batch finishes.

## Installation (Load unpacked)

1. Download/unzip this folder (`gif-grabber`) anywhere on your computer.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `gif-grabber` folder.
5. Pin "GIF Grabber" to your toolbar (puzzle-piece icon > pin).

## How to use

1. Open [tenor.com](https://tenor.com) or [giphy.com](https://giphy.com) and search for something (e.g. `funny cat`).
2. Click the GIF Grabber icon. The popup lists the term and every GIF detected so far.
3. Pick one of:
   - **Download N** — saves the checked GIFs as `funny_cat_1.gif`, `funny_cat_2.gif`, …
   - **ZIP** — packs them into `funny_cat.zip`.
   - **Auto-scroll** — scrolls the page to load the entire feed, then auto-downloads everything (mode switch lets you choose "collect only" instead).
   - **Hover any GIF** on the page and click its download button for a quick single save (`funny_cat.gif` for the first one).
4. Chrome may ask **"Allow multiple downloads"** once per batch — click Allow, that's normal.

## Naming rules

| Situation | File name |
|---|---|
| First single save of a term | `cute_cat.gif` |
| Subsequent saves / batches | `cute_cat_1.gif`, `cute_cat_2.gif`, … |
| Term edits | Spaces and invalid filename characters become `_` |
| Name collision in Downloads | Chrome appends ` (1)`, ` (2)`, … automatically |

## Troubleshooting

- **Popup says it cannot read the page** — reload the Tenor/Giphy tab after installing or updating the extension, then click the icon again (or press "Activate on this page").
- **No GIFs in the grid** — scroll a little or press the Rescan button; infinite feeds add GIFs as you scroll.
- **A download failed** — a handful of Tenor posts are video-only; the extension verifies GIF signatures and reports those as skipped.
- **Files go to your default Downloads folder** — change it in Chrome Settings > Downloads.

## Privacy

Everything runs locally in your browser. The extension only talks to tenor.com/giphy.com pages and their media CDNs to fetch the GIFs you asked for. No analytics, no accounts, no data collection.

## File structure

```
gif-grabber/
├── manifest.json      MV3 manifest & permissions
├── background.js      download queue, URL resolution, naming, dedupe, notifications
├── content.js         GIF detection, hover buttons, auto-scroll engine, HUD
├── content.css        on-page button + HUD styles
├── popup.html/.css/.js popup UI
├── lib/gg-core.js     shared URL parsing & helpers
├── lib/zip-min.js     built-in ZIP writer (store method)
└── icons/             toolbar icons
```
