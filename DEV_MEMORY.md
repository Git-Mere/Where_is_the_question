# Project Memory: Where is the question

## 1. Project Overview
- **Purpose**: A Chrome extension that places markers on the scrollbar for user questions in ChatGPT and Gemini chat histories.
- **Key Features**:
    - Click markers to scroll to specific questions.
    - Right-click markers to favorite questions (adds a '★' icon).
    - Hover markers to see a tooltip of the question text.
    - Works across window resizes, session switches, and new chats.

## 2. Technical Architecture
- **`manifest.json`**: Extension configuration (currently v1.2).
- **`content.js`**: Core logic managed by the `MarkerManager` class.
    - Handles `MutationObserver`, marker creation/updates, and event listeners.
    - Uses `WeakMap` for performance-optimized data caching.
- **`src/modules/`**:
    - **`config.js`**: Site-specific selectors and text extraction.
        - Aggressively strips accessibility prefixes like "You said", "당신이 말함", etc.
    - **`dom.js`**: DOM utilities for scroll container detection and coordinate calculation.
        - Identifies specific chat containers for ChatGPT (`div[role="presentation"]`) and other services.
    - **`storage.js`**: Wrapper for `chrome.storage.local`.

## 3. Key Technical Standards
- **Stable ID System**: Question IDs are generated using `(Truncated Text) + (Index)`. This ensures stability during window resizes where pixel positions change.
- **Positioning Logic**: Uses `(Element Y Position) / (Total Content Height)` to place markers. This allows markers to appear correctly even in short chats or new sessions where no scrollbar is visible yet.
- **SPA Support**: Monitors `location.href` changes and `popstate` events to reset and rebuild markers when the user switches chat sessions without a full page reload.
- **Relative Anchoring**: Favorite stars are placed in parent containers with `position: relative` to ensure they stay pinned to the correct message element.

## 4. Recent Session Updates (Feb 26, 2026)
- **Aggressive Prefix Removal**: Fixed issue where tooltips showed accessibility labels.
- **Container Detection**: Explicitly added support for ChatGPT's complex scroll structure to fix navigation (click-to-scroll).
- **Initialization Timing**: Added staggered updates (1s, 3s after load) to catch late-rendering messages in new chat sessions.
- **Responsive Handling**: Optimized `MutationObserver` and cache TTL (500ms) to ensure markers update instantly when typing in small window modes.

## 5. Deployment Readiness
- Version 1.2 logic is fully implemented and tested for both major chat platforms.
- Performance refactoring is complete, minimizing layout thrashing during long conversations.
