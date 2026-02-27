class MarkerManager {
    constructor() {
        this.debounceTimeout = null;
        this.updateRafId = null;
        this.pendingForceUpdate = false;
        this.isUpdating = false;
        this.pendingUpdateAfterRun = false;
        this.minUpdateInterval = 180;
        this.lastUpdateTime = 0;
        this.favorites = [];
        this.site = window.WITQ.config.site;
        this.config = window.WITQ.config.config;
        this.scrollbarContainer = null;
        this.observer = null;
        this.observerTarget = null;
        this.observerRetryTimer = null;
        this.markers = new Map(); // Maps questionElement to markerElement
        this.questionDataCache = new WeakMap(); // Cache for parsed question data
        this.lastUrl = location.href;
        this.warmupTimers = [];

        this.initialize();
    }

    async initialize() {
        try {
            this.favorites = await window.WITQ.storage.getFavorites();
            this.scheduleUpdate(true, 0);
            this.scheduleWarmupUpdates();
        } catch (e) {}

        this.setupEventListeners();
        this.startObserver();
    }
    
    // --- Marker Management ---

    getQuestions() {
        if (this.config && typeof this.config.getQuestionElements === 'function') {
            return this.config.getQuestionElements();
        }
        return Array.from(document.querySelectorAll(this.config.questionSelector));
    }

    getQuestionWrapper(questionEl) {
        if (!questionEl) return null;
        if (this.site === 'gemini') {
            return questionEl.closest('.user-query-container') ||
                   questionEl.closest('.query-with-attachments-container') ||
                   questionEl.closest('.user-query') ||
                   questionEl;
        }
        if (this.site === 'chatgpt') {
            return questionEl.closest('[data-testid^="conversation-turn"]') || questionEl;
        }
        return questionEl;
    }

    escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    normalizeFileName(name) {
        if (!name) return '';
        const cleaned = String(name)
            .replace(/^\s*\[[^\]]*icon[^\]]*\]\s*/i, '')
            .replace(/^\s*\([^\)]*icon[^\)]*\)\s*/i, '')
            .replace(/^\s*[a-z0-9]+\s*icon\s*/i, '')
            .trim();
        if (!cleaned) return '';
        if (/\.[a-z0-9]{2,8}$/i.test(cleaned)) return cleaned;
        const maybeExt = cleaned.match(/([a-z0-9]{2,8})$/i);
        if (maybeExt && cleaned.length > maybeExt[1].length) {
            return cleaned.replace(/([a-z0-9]{2,8})$/i, '.$1');
        }
        return cleaned;
    }

    buildStructuredTextFromPlain(plain) {
        if (!plain) return '';
        const withoutIcons = String(plain)
            .replace(/\[[^\]]*icon[^\]]*\]/ig, ' ')
            .replace(/\([^\)]*icon[^\)]*\)/ig, ' ')
            .trim();

        const splitByYouSaid = withoutIcons.split(/\byou\s*said\b\s*:?\s*/i);
        if (splitByYouSaid.length >= 2) {
            const left = this.normalizeFileName(splitByYouSaid[0].trim());
            const right = splitByYouSaid.slice(1).join(' ').trim();
            if (left && right) {
                return `[${this.escapeHtml(left)}]<br>${this.escapeHtml(right)}`;
            }
        }

        const removedYouSaid = withoutIcons.replace(/\byou\s*said\b\s*:?\s*/ig, ' ').replace(/\s+/g, ' ').trim();
        const fileThenQuestion =
            removedYouSaid.match(/^(.+?\.[a-z0-9]{2,8})\s+(.+)$/i) ||
            removedYouSaid.match(/^(.+?[a-z0-9]{2,8})(.+)$/i);
        if (fileThenQuestion) {
            const fileName = this.normalizeFileName(fileThenQuestion[1]);
            const question = fileThenQuestion[2].trim();
            if (fileName && question) {
                return `[${this.escapeHtml(fileName)}]<br>${this.escapeHtml(question)}`;
            }
        }

        return this.escapeHtml(removedYouSaid);
    }

    scheduleWarmupUpdates() {
        this.cancelWarmupUpdates();
        [180, 900].forEach(delay => {
            const timerId = setTimeout(() => this.scheduleUpdate(true, 0), delay);
            this.warmupTimers.push(timerId);
        });
    }

    cancelWarmupUpdates() {
        this.warmupTimers.forEach(timerId => clearTimeout(timerId));
        this.warmupTimers = [];
    }

    scheduleUpdate(force = false, delay = 0) {
        this.pendingForceUpdate = this.pendingForceUpdate || force;
        clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
            if (this.updateRafId !== null) return;
            this.updateRafId = requestAnimationFrame(() => {
                this.updateRafId = null;
                const elapsed = Date.now() - this.lastUpdateTime;
                if (elapsed < this.minUpdateInterval) {
                    this.scheduleUpdate(this.pendingForceUpdate, this.minUpdateInterval - elapsed);
                    return;
                }
                const forceNow = this.pendingForceUpdate;
                this.pendingForceUpdate = false;
                this.lastUpdateTime = Date.now();
                this.updateMarkers(forceNow);
            });
        }, delay);
    }

    async updateMarkers(force = false) {
        if (this.isUpdating) {
            this.pendingUpdateAfterRun = this.pendingUpdateAfterRun || force;
            return;
        }
        this.isUpdating = true;
        try {
            // Detect session switch (URL change)
            if (this.lastUrl !== location.href) {
                this.lastUrl = location.href;
                this.resetMarkers();
                this.scheduleWarmupUpdates();
                this.startObserver();
            }

            const questions = this.getQuestions();
            
            this.ensureScrollbarContainer();

            if (questions.length === 0) {
                 if (this.markers.size === 0) {
                    this.scrollbarContainer.style.display = 'none';
                 }
                 this.scrollbarContainer.innerHTML = '';
                 window.WITQ.storage.safeSendQuestionList([]);
                 this.markers.clear();
                 return;
            }

            this.scrollbarContainer.style.display = 'block';
            if (this.warmupTimers.length > 0) this.cancelWarmupUpdates();

            const container = window.WITQ.dom.getScrollContainer();
            // Use total height of the scrollable area for consistent positioning
            const totalHeight = (container === window) 
                ? Math.max(document.documentElement.scrollHeight, window.innerHeight, 1) 
                : Math.max(container.scrollHeight, container.clientHeight, 1);

            const currentQuestionElements = new Set(questions);
            const questionsForPopup = [];

            // 1. Cleanup old markers
            for (const [questionEl, markerEl] of this.markers.entries()) {
                if (!currentQuestionElements.has(questionEl) || !document.body.contains(questionEl)) {
                    this.removeMarker(questionEl, markerEl);
                }
            }

            // 2. Add/Update markers
            questions.forEach((question, index) => {
                const data = this.getOrUpdateQuestionData(question, container, index);
                if (!data || !data.text) return;

                let marker = this.markers.get(question);
                if (!marker) {
                    marker = this.createMarkerElement(question, index, container);
                    this.scrollbarContainer.appendChild(marker);
                    this.markers.set(question, marker);
                } else {
                    this.updateMarkerElement(marker, question, data, container, totalHeight);
                }

                questionsForPopup.push({
                    id: data.id,
                    text: data.text,
                    position: data.position,
                    isQuestion: data.isQuestion
                });
            });

            window.WITQ.storage.safeSendQuestionList(questionsForPopup);
        } catch (error) {
            // console.warn(`[WITQ] Marker update failed`, error);
        } finally {
            this.isUpdating = false;
            if (this.pendingUpdateAfterRun) {
                const nextForce = this.pendingUpdateAfterRun;
                this.pendingUpdateAfterRun = false;
                this.scheduleUpdate(nextForce, 120);
            }
        }
    }

    resetMarkers() {
        if (this.scrollbarContainer) {
            this.scrollbarContainer.innerHTML = '';
            this.scrollbarContainer.style.display = 'none';
        }
        this.markers.clear();
        window.WITQ.storage.safeSendQuestionList([]);
    }

    ensureScrollbarContainer() {
        if (!this.scrollbarContainer) {
            this.scrollbarContainer = document.getElementById('question-scrollbar-container');
            if (!this.scrollbarContainer) {
                this.scrollbarContainer = document.createElement('div');
                this.scrollbarContainer.id = 'question-scrollbar-container';
                document.body.appendChild(this.scrollbarContainer);
            }
        }
    }

    removeMarker(questionEl, markerEl) {
        markerEl.remove();
        const questionWrapper = this.getQuestionWrapper(questionEl);
        const existingStar = questionWrapper ? questionWrapper.querySelector('.witq-favorite-star') : null;
        if (existingStar) existingStar.remove();
        this.markers.delete(questionEl);
    }

    getOrUpdateQuestionData(question, container, index) {
        let cached = this.questionDataCache.get(question);
        const currentPos = window.WITQ.dom.getQuestionPositionInContainer(question, container);
        
        if (!cached || Math.abs(cached.position - currentPos) > 1 || cached.index !== index) {
            const plainFallback = (question.innerText || question.textContent || '').trim();
            if (!plainFallback) return null;
            const fastText = this.buildStructuredTextFromPlain(plainFallback);
            
            cached = {
                text: fastText,
                detailedText: null,
                position: currentPos,
                index,
                id: this.generateQuestionId(plainFallback, index),
                isQuestion: window.WITQ.config.isQuestion(plainFallback)
            };
            this.questionDataCache.set(question, cached);
        }
        return cached;
    }

    ensureDetailedQuestionText(question, data) {
        if (!data || data.detailedText) return data;
        let detailed = this.config.getQuestionText(question);
        const hasRenderableText = !!(detailed && detailed.replace(/<[^>]+>/g, '').trim());
        if (!hasRenderableText) {
            const plainFallback = (question.innerText || question.textContent || '').trim();
            if (plainFallback) {
                detailed = this.buildStructuredTextFromPlain(plainFallback);
            } else {
                return data;
            }
        }
        data.detailedText = detailed;
        return data;
    }

    formatTooltipHtml(raw) {
        if (!raw) return '';
        let html = String(raw);
        html = html.replace(/&lt;br\s*\/?&gt;/ig, '<br>');
        html = html.replace(/<\/div>\s*<div>/ig, '<br>');
        html = html.replace(/^<div>/i, '').replace(/<\/div>$/i, '');

        // Remove accessibility/icon noise that may still leak from host DOM text.
        html = html
            .replace(/\[[^\]]*icon[^\]]*\]\s*/ig, '')
            .replace(/\([^\)]*icon[^\)]*\)\s*/ig, '')
            .replace(/\byou\s*said\b\s*:?\s*/ig, ' ')
            .trim();

        // Ensure a hard line break between file token and question text.
        if (!/<br\s*\/?>/i.test(html)) {
            // [file.ext] question...
            html = html.replace(/(\[[^\]]+\])\s+(.+)/, '$1<br>$2');
            // file.ext question... (no brackets)
            html = html.replace(/(\b[^\s<>]+\.[a-z0-9]{2,8}\b)\s+(.+)/i, '$1<br>$2');
            // file.extQuestion... (no whitespace)
            html = html.replace(/(\b[^\s<>]+\.[a-z0-9]{2,8}\b)(?=[^\s<])/i, '$1<br>');
            // [file.ext]Question... (no whitespace)
            html = html.replace(/(\[[^\]]+\])(?=[^\s<])/, '$1<br>');
        }

        return html;
    }

    generateQuestionId(text, index) {
        const textPart = text.replace(/<[^>]+>/g, ' ').substring(0, 30);
        return `${textPart}-${index}`;
    }

    createMarkerElement(question, initialIndex, initialContainer) {
        const marker = document.createElement('div');
        marker.className = 'question-marker';

        const tooltip = document.createElement('div');
        tooltip.className = 'question-marker-tooltip';
        marker.appendChild(tooltip);

        let hideTooltipTimer = null;
        const showTooltip = () => {
            clearTimeout(hideTooltipTimer);
            const currentContainer = window.WITQ.dom.getScrollContainer();
            const questions = this.getQuestions();
            const currentIndex = questions.indexOf(question);
            const currentData = this.getOrUpdateQuestionData(question, currentContainer, currentIndex);
            
            if (!currentData) return;

            this.ensureDetailedQuestionText(question, currentData);
            tooltip.innerHTML = this.formatTooltipHtml(currentData.detailedText || currentData.text);
            tooltip.style.visibility = 'visible';
            tooltip.style.opacity = '0';
            
            const rect = tooltip.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const topThreshold = 60;
            
            if (rect.top < topThreshold) {
                tooltip.style.top = '0px';
                tooltip.style.transform = 'translateY(0)';
            } else if (rect.bottom > viewportHeight - 10) {
                tooltip.style.top = 'auto';
                tooltip.style.bottom = '0px';
                tooltip.style.transform = 'translateY(0)';
            } else {
                tooltip.style.top = '50%';
                tooltip.style.bottom = 'auto';
                tooltip.style.transform = 'translateY(-50%)';
            }
            tooltip.style.opacity = '1';
        };

        const hideTooltip = () => {
            hideTooltipTimer = setTimeout(() => {
                tooltip.style.opacity = '0';
                tooltip.style.visibility = 'hidden';
            }, 200);
        };

        marker.addEventListener('mouseenter', showTooltip);
        marker.addEventListener('mouseleave', hideTooltip);
        tooltip.addEventListener('mouseenter', () => clearTimeout(hideTooltipTimer));
        tooltip.addEventListener('mouseleave', hideTooltip);

        marker.addEventListener('click', () => {
            const currentContainer = window.WITQ.dom.getScrollContainer();
            const questions = this.getQuestions();
            const currentIndex = questions.indexOf(question);
            const currentData = this.getOrUpdateQuestionData(question, currentContainer, currentIndex);
            if (currentData) {
                window.WITQ.dom.scrollToQuestionPosition(currentData.position, currentContainer);
            }
        });

        marker.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            const currentContainer = window.WITQ.dom.getScrollContainer();
            const questions = this.getQuestions();
            const currentIndex = questions.indexOf(question);
            const currentData = this.getOrUpdateQuestionData(question, currentContainer, currentIndex);
            if (!currentData) return;

            const currentFavorites = await window.WITQ.storage.getFavorites();
            const isFavorite = currentFavorites.some(fav => fav.id === currentData.id);
            const updatedFavorites = isFavorite 
                ? currentFavorites.filter(fav => fav.id !== currentData.id)
                : [...currentFavorites, { id: currentData.id, text: currentData.text, position: currentData.position }];
            
            chrome.storage.local.set({ favorites: updatedFavorites });
            this.favorites = updatedFavorites;
            this.scheduleUpdate(true, 60);
        });

        const container_ = initialContainer || window.WITQ.dom.getScrollContainer();
        const totalHeight = (container_ === window) 
            ? Math.max(document.documentElement.scrollHeight, window.innerHeight, 1) 
            : Math.max(container_.scrollHeight, container_.clientHeight, 1);
        
        // Initial data for placement
        const initialData = this.getOrUpdateQuestionData(question, container_, initialIndex);
        if (initialData) {
            this.updateMarkerElement(marker, question, initialData, container_, totalHeight);
        }
        return marker;
    }

    updateMarkerElement(marker, question, data, container, totalHeight) {
        marker.classList.toggle('is-question', data.isQuestion);

        const isFavorite = this.favorites.some(fav => fav.id === data.id);
        marker.classList.toggle('favorite', isFavorite);

        const questionWrapper = this.getQuestionWrapper(question);
        const existingStar = questionWrapper ? questionWrapper.querySelector('.witq-favorite-star') : null;

        if (isFavorite) {
            if (!existingStar && questionWrapper) {
                const star = document.createElement('div');
                star.className = 'witq-favorite-star';
                star.textContent = '★';
                questionWrapper.appendChild(star);
            }
        } else if (existingStar) {
            existingStar.remove();
        }

        const clamped = Math.min(Math.max(data.position, 0), totalHeight);
        marker.style.top = `${(clamped / totalHeight) * 100}%`;
    }

    // --- Event Handling & State ---
    
    setupEventListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'scrollToQuestion') {
                window.WITQ.dom.scrollToQuestionPosition(message.position);
                sendResponse({ status: 'scrolling' });
            } else if (message.type === 'getQuestions') {
                this.scheduleUpdate(true, 0);
                sendResponse({ status: 'processing' });
            }
            return true;
        });

        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes.favorites) {
                this.favorites = changes.favorites.newValue || [];
                this.scheduleUpdate(true, 0);
            }
        });

        window.addEventListener('resize', () => {
            this.startObserver();
            this.scheduleUpdate(true, 180);
        });

        // SPA Navigation support: Listen for session switches via popstate or title changes
        window.addEventListener('popstate', () => {
            this.startObserver();
            this.scheduleWarmupUpdates();
            this.scheduleUpdate(true, 0);
        });

        // Some SPA navigations use pushState/replaceState without popstate.
        window.addEventListener('witq:urlchange', () => {
            this.startObserver();
            this.scheduleWarmupUpdates();
            this.scheduleUpdate(true, 0);
        });
    }

    startObserver() {
        const container = window.WITQ.dom.getScrollContainer();
        if (container === window) {
            if (!this.observerRetryTimer) {
                this.observerRetryTimer = setTimeout(() => {
                    this.observerRetryTimer = null;
                    this.startObserver();
                }, 500);
            }
            return;
        }
        const observerTarget = container;
        if (!observerTarget) return;

        if (this.observer && this.observerTarget === observerTarget) return;
        if (this.observer) this.observer.disconnect();
        this.observerTarget = observerTarget;

        this.observer = new MutationObserver((mutations) => {
            const hasChange = mutations.some(m => m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length));

            if (hasChange || this.lastUrl !== location.href) {
                this.scheduleUpdate(false, 120);
            }
        });

        this.observer.observe(observerTarget, {
            childList: true,
            subtree: true
        });
    }
}

// SPA URL change hook for pushState/replaceState
if (!window.__WITQ_HISTORY_HOOKED__) {
    window.__WITQ_HISTORY_HOOKED__ = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const emitUrlChange = () => window.dispatchEvent(new Event('witq:urlchange'));

    history.pushState = function(...args) {
        const result = originalPushState.apply(this, args);
        emitUrlChange();
        return result;
    };

    history.replaceState = function(...args) {
        const result = originalReplaceState.apply(this, args);
        emitUrlChange();
        return result;
    };
}

// Global initialization with a safer delay
if (document.readyState === 'complete') {
    new MarkerManager();
} else {
    window.addEventListener('load', () => new MarkerManager());
}




