# Project Memory: Where is the question

## 1. Project Overview
- Purpose: Chrome extension that marks user questions on the scrollbar in ChatGPT and Gemini.
- Core UX:
  - Click marker -> scroll to question.
  - Right-click marker -> favorite toggle (star + in-message overlay).
  - Hover marker -> tooltip preview.
  - Works across SPA route changes, chat switches, and resize.

## 2. Current Version and Packaging
- Manifest version: MV3.
- Extension version: `1.3` (`manifest.json`).
- Runtime entrypoints:
  - Content script chain: `src/modules/config.js`, `src/modules/dom.js`, `src/modules/storage.js`, `content.js`
  - Popup: `popup.html`, `popup.js`, `popup.css`
  - Locales required by `default_locale`: `_locales/en`, `_locales/ko`
- Web Store upload zip path used in this repo:
  - `dist/where_is_the_question_webstore_v1.3.zip`

## 3. Architecture Snapshot
- `content.js` (`MarkerManager`)
  - Marker lifecycle management (`Map`), question cache (`WeakMap`), favorites sync.
  - SPA URL-change handling (`popstate` + patched `history.pushState/replaceState` event).
  - Update scheduling and throttling via `scheduleUpdate` + `requestAnimationFrame`.
  - Warm-up updates for first-render race conditions in new sessions.
- `src/modules/config.js`
  - Site-specific question selectors/parsers (ChatGPT/Gemini split).
  - ChatGPT question element strategy cache (`chatgptElementStrategy`) to avoid repeated full-document scans.
  - Attachment/file name extraction and tooltip text composition.
- `src/modules/dom.js`
  - Scroll container detection and position mapping.
  - Site-specific offsets for scroll targeting.

## 4. Major Changes in This Session (2026-02-27)
- Site behavior split strengthened:
  - ChatGPT and Gemini question detection/collection paths are separately handled to reduce regression ping-pong.
- Performance-focused refactor:
  - Coalesced updates with RAF + minimum interval.
  - Reduced warm-up frequency and added warm-up cancellation once questions are found.
  - Observer narrowed to active scroll container (avoid broad body-level heavy observation when possible).
  - Removed repeated favorites storage read on each update path.
- First-message/new-chat stability improvements:
  - URL/session switch handling rebuilds markers and re-primes update warm-up.
- Gemini attachment tooltip cleanup:
  - Strips accessibility noise and icon tokens (`[... ICON]`, `( ... icon )`, `You said`).
  - Generalized file-name normalization for multiple extensions, not only PDF.
  - Tooltip formatter now enforces file/question separation with `<br>` in fallback rendering paths.
- Note:
  - Tooltip line-break behavior depends on incoming host DOM text shape; a final formatting pass exists in `content.js` (`formatTooltipHtml`) to force split when possible.

## 5. Open Caveats / Next Session Priorities
- Re-verify Gemini tooltip output for all attachment patterns (`pdf/docx/xlsx/pptx`) using real DOM samples from current production UI.
- If line breaks still collapse in certain UI variants:
  - adjust tooltip CSS (`white-space`) and/or
  - strengthen parser split rule using exact container node boundaries rather than plain-text heuristics.
- Keep performance budget first: avoid broad `querySelectorAll` fallback chains inside hot update loops unless cached.
