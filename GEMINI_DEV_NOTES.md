# Gemini Development Notes for "Where is the question" Extension

## 1. Extension's Purpose

This Chrome extension is designed to help users navigate long chat histories in services like ChatGPT and Gemini. It works by placing markers on the scrollbar that correspond to each of the user's questions in the chat. Clicking on a marker instantly scrolls the page to the position of that specific question, making it easy to find previous prompts in a lengthy conversation.

## 2. Gemini Integration Work Summary

The main challenge for making the extension work on Gemini was identifying the correct HTML elements for user questions. Unlike ChatGPT, Gemini's page structure is different and its class names are generated dynamically.

Here's a summary of the steps taken to achieve Gemini compatibility:

1.  **Initial Analysis:** The initial attempt used selectors like `.user-query` and `.prompt-text`, which were based on assumptions and initial observations. These turned out to be incorrect or unreliable, as they failed to find any question elements.
2.  **User-assisted HTML Inspection:** With the user's help, we inspected the live HTML of the Gemini chat page. The user provided the `outerHTML` for a user's chat message and its parent elements.
3.  **Identifying the Correct Selectors:** Based on the provided HTML, we found that:
    *   The most reliable container for a user's question is a `<div>` with the class `query-text`.
    *   The text of the question itself is within this `div`.

## 3. Current Gemini Configuration (`content.js`)

To make the extension work on Gemini, the `siteConfig` object in `content.js` was updated as follows:

```javascript
// content.js

const siteConfig = {
    // ... (chatgpt config)
    gemini: {
        // This selector targets the container of the user's prompt text.
        questionSelector: 'div.query-text',

        // This function extracts the text from the selected element.
        getQuestionText: (questionElement) => {
            const text = questionElement.innerText.trim();
            // The console.log below was kept for future debugging.
            console.log('[WITQ] Extracted Gemini question text:', text, 'from element:', questionElement);
            return text;
        }
    },
    // ... (unknown config)
};
```

## 4. How to Debug Gemini in the Future

If the extension breaks on Gemini again (which is possible, as Google may update the site's structure), follow these steps:

1.  **Check the logs:** The `content.js` script contains extensive logging (prefixed with `[WITQ]`). Open the developer console on the Gemini page and look for these logs. The most important log to check is `[WITQ] Found X question elements using selector: ...`. If `X` is 0, the `questionSelector` is no longer working.
2.  **Inspect the HTML:** If the selector is broken, you'll need to find the new one.
    *   Right-click on a user's message on the Gemini page and select "Inspect".
    *   Examine the highlighted element and its parents to find a new, stable class name for the container of the user's message.
    *   Look for class names like `query-text`, `user-prompt`, `message`, etc.
3.  **Update `siteConfig.gemini`:** Once you've found a new selector, update the `questionSelector` and, if necessary, the `getQuestionText` function in `content.js`.

---

## 5. Recent Changes

*   **Popup UI Update:**
    *   Removed the "Show questions only" checkbox and its associated filtering logic from the popup as it was deemed unnecessary.
    *   The popup heading was changed from "내 질문 목록" to "My questions" for English localization.
*   **Documentation:**
    *   The `README.md` file was updated to be bilingual (Korean/English).
    *   Installation instructions in `README.md` were updated to point directly to the Chrome Web Store, removing the steps for local installation.
*   **Popup Styling:**
    *   Restored and combined styles for `popup.css` to fix a display issue where the question list was not appearing correctly.

---

## 6. Session Updates (Feb 9, 2026)

This session focused on implementing several key improvements and a major performance refactoring.

### 6.1. Feature Enhancements

*   **Tooltip Positioning Fix:**
    *   Implemented dynamic positioning for the question marker tooltip in `content.js` to prevent it from rendering off-screen (e.g., behind the taskbar or bookmarks bar).
    *   Adjusted `content.css` to accommodate these dynamic positioning changes.
*   **Favorite Question Star Icon:**
    *   Replaced the previous yellow background highlight for favorited questions with a prominent star icon (`★`).
    *   Modified `content.js` to dynamically add and remove this star element next to favorited questions.
    *   Updated `content.css` to style the star's appearance, size (now significantly larger), and position (adjusted to be more to the right and downwards as per user feedback).
*   **Enhanced Tooltip Content for File Attachments:**
    *   Improved `extractQuestionData` logic to correctly extract and display attached filenames alongside the main question text.
    *   Implemented special handling for generic image placeholders: `[업로드된 이미지]` for single image uploads and `[업로드된 이미지들]` for two or more.
    *   Refactored tooltip content generation to return HTML strings (using `<div>` tags for each entry) and updated `showTooltip` to use `innerHTML`. This ensures proper newline formatting for each filename and the question text.
    *   Modified `content.css` by removing conflicting text truncation properties (`-webkit-box`, `-webkit-line-clamp`, `white-space: pre-line`) from `.question-marker-tooltip` to allow the `div`-based HTML structure to render correctly.

### 6.2. Performance Refactoring (Previous)

A major refactoring effort was undertaken to improve the extension's performance, especially when dealing with a large number of questions, to minimize "slowness and stuttering." (Details omitted for brevity, see history).

### 6.3. Performance & Logic Optimization (Feb 24, 2026)

This session focused on deep performance optimization and fixing UI bugs.

*   **Deep Performance Refactoring:**
    *   **`MarkerManager` (content.js):**
        *   Implemented `WeakMap` (`questionDataCache`) to cache parsed question data (text, ID, position), significantly reducing redundant parsing.
        *   Minimized Layout Thrashing by batching DOM reads (e.g., container dimensions) outside of loops.
        *   Optimized `MutationObserver` to more precisely filter relevant DOM changes.
    *   **`src/modules/config.js`:**
        *   Optimized `extractQuestionData` by replacing the expensive `cloneNode(true)` method with a direct, recursive text node traversal.
        *   Enhanced `isQuestion` logic with more robust regex, including improved support for Korean question endings (`-까`, `-나`, `-요` 등).
    *   **`src/modules/dom.js`:**
        *   Implemented aggressive caching for the scroll container (2-second TTL) to drastically reduce calls to `window.getComputedStyle`.
        *   Refactored `getQuestionPositionInContainer` to use `getBoundingClientRect` for faster and more accurate calculations.
*   **Popup UI Bug Fix:**
    *   Modified `popup.js` to strip HTML tags (like `<div>`) from the question list, ensuring a clean text-only display in the popup.
*   **Documentation:**
    *   Updated `README.md` to include a troubleshooting tip (both English and Korean) advising users to refresh the page if the extension doesn't work correctly.
*   **Version Bump:**
    *   Updated `manifest.json` version to `1.2` for Chrome Web Store release.