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

### 6.2. Performance Refactoring

A major refactoring effort was undertaken to improve the extension's performance, especially when dealing with a large number of questions, to minimize "slowness and stuttering."

*   **Modularization of `content.js`:**
    *   The monolithic `content.js` script was broken down into a more modular and organized architecture:
        *   `src/modules/config.js`: Encapsulates site-specific configurations, `getCurrentSite`, `getSiteConfig`, `extractQuestionData`, and `isQuestion` logic.
        *   `src/modules/dom.js`: Contains DOM manipulation and scrolling utilities such as `getScrollContainer`, `getQuestionPositionInContainer`, `getScrollOffset`, and `scrollToQuestionPosition`.
        *   `src/modules/storage.js`: Houses storage-related functions, including `getFavorites` and `safeSendQuestionList`.
        *   The main `content.js` file was rewritten to contain a leaner `MarkerManager` class, which now acts as an orchestrator, utilizing the functions provided by these new modules.
    *   `manifest.json` was updated to load these modularized JavaScript files in the correct sequence, ensuring proper dependency resolution.
*   **Incremental Marker Updates:**
    *   The `MarkerManager.updateMarkers` method was significantly optimized to perform incremental updates instead of completely re-rendering all markers on every change.
    *   A `Map` (`this.markers`) was introduced to efficiently track the mapping between `questionElement`s and their corresponding `markerElement`s.
    *   The update logic now intelligently:
        *   Removes `markerElement`s (and their associated star icons) only for `questionElement`s that are no longer present in the DOM.
        *   Creates new `markerElement`s only for `questionElement`s that have newly appeared.
        *   Updates the position, favorite status, and other relevant properties of existing `markerElement`s, minimizing costly DOM manipulation.
*   **Improved `MutationObserver`:**
    *   The `MutationObserver` was refined to efficiently detect relevant DOM changes (additions and removals of question elements).
    *   The observer's target was narrowed to the chat's scroll container (instead of `document.body`), further reducing unnecessary triggers.
    *   While still triggering a debounced full `updateMarkers` call for stability in complex chat UIs, the underlying `updateMarkers` method is now highly optimized to handle these updates efficiently.