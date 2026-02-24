class MarkerManager {
    constructor() {
        this.debounceTimeout = null;
        this.favorites = [];
        this.site = window.WITQ.config.site;
        this.config = window.WITQ.config.config;
        this.scrollbarContainer = null;
        this.observer = null;
        this.markers = new Map(); // Maps questionElement to markerElement
        this.questionDataCache = new WeakMap(); // Cache for parsed question data

        this.initialize();
    }

    async initialize() {
        try {
            this.favorites = await window.WITQ.storage.getFavorites();
            this.updateMarkers(true);
        } catch (e) {}

        this.setupEventListeners();
        this.startObserver();
    }
    
    // --- Marker Management ---

    async updateMarkers(force = false) {
        try {
            const questions = document.querySelectorAll(this.config.questionSelector);
            if (questions.length === 0 && this.markers.size === 0) {
                if (this.scrollbarContainer) this.scrollbarContainer.style.display = 'none';
                return;
            }

            const container = window.WITQ.dom.getScrollContainer();
            const scrollableHeight = (container === window) 
                ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) 
                : Math.max(container.scrollHeight - container.clientHeight, 1);
            
            this.ensureScrollbarContainer();

            if (questions.length === 0 || scrollableHeight <= 0) {
                 this.scrollbarContainer.style.display = 'none';
                 this.scrollbarContainer.innerHTML = '';
                 window.WITQ.storage.safeSendQuestionList([]);
                 this.markers.clear();
                 return;
            }

            this.scrollbarContainer.style.display = 'block';
            this.favorites = await window.WITQ.storage.getFavorites();

            const currentQuestionElements = new Set(questions);
            const questionsForPopup = [];

            // 1. Cleanup old markers
            for (const [questionEl, markerEl] of this.markers.entries()) {
                if (!currentQuestionElements.has(questionEl) || !document.body.contains(questionEl)) {
                    this.removeMarker(questionEl, markerEl);
                }
            }

            // 2. Add/Update markers
            questions.forEach((question) => {
                const data = this.getOrUpdateQuestionData(question, container);
                if (!data || !data.text) return;

                let marker = this.markers.get(question);
                if (!marker) {
                    marker = this.createMarkerElement(question, data, container);
                    this.scrollbarContainer.appendChild(marker);
                    this.markers.set(question, marker);
                } else {
                    this.updateMarkerElement(marker, question, data, container, scrollableHeight);
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
        }
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
        const questionWrapper = questionEl.closest('.user-query') || questionEl.closest('div[data-testid^="conversation-turn"]') || questionEl;
        const existingStar = questionWrapper ? questionWrapper.querySelector('.witq-favorite-star') : null;
        if (existingStar) existingStar.remove();
        this.markers.delete(questionEl);
    }

    getOrUpdateQuestionData(question, container) {
        let cached = this.questionDataCache.get(question);
        const currentPos = window.WITQ.dom.getQuestionPositionInContainer(question, container);
        
        // Re-extract only if position changed significantly or not cached
        if (!cached || Math.abs(cached.position - currentPos) > 1) {
            const text = this.config.getQuestionText(question);
            if (!text) return null;
            
            cached = {
                text,
                position: currentPos,
                id: this.generateQuestionId(text, currentPos),
                isQuestion: window.WITQ.config.isQuestion(text)
            };
            this.questionDataCache.set(question, cached);
        }
        return cached;
    }

    generateQuestionId(text, position) {
        const textPart = text.replace(/<[^>]+>/g, ' ').substring(0, 30);
        return `${textPart}-${Math.round(position)}`;
    }

    createMarkerElement(question, data, container) {
        const marker = document.createElement('div');
        marker.className = 'question-marker';

        const tooltip = document.createElement('div');
        tooltip.className = 'question-marker-tooltip';
        marker.appendChild(tooltip);

        let hideTooltipTimer = null;
        const showTooltip = () => {
            clearTimeout(hideTooltipTimer);
            tooltip.innerHTML = data.text;
            tooltip.style.visibility = 'visible';
            tooltip.style.opacity = '0';
            
            // Minimal reflow for positioning
            const rect = tooltip.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            
            if (rect.top < 10) {
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
            const currentData = this.getOrUpdateQuestionData(question, currentContainer);
            if (currentData) {
                window.WITQ.dom.scrollToQuestionPosition(currentData.position, currentContainer);
            }
        });

        marker.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            const currentFavorites = await window.WITQ.storage.getFavorites();
            const isFavorite = currentFavorites.some(fav => fav.id === data.id);
            const updatedFavorites = isFavorite 
                ? currentFavorites.filter(fav => fav.id !== data.id)
                : [...currentFavorites, { id: data.id, text: data.text, position: data.position }];
            
            chrome.storage.local.set({ favorites: updatedFavorites });
        });

        const container_ = window.WITQ.dom.getScrollContainer();
        const scrollableHeight = (container_ === window) 
            ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) 
            : Math.max(container_.scrollHeight - container_.clientHeight, 1);
        
        this.updateMarkerElement(marker, question, data, container_, scrollableHeight);
        return marker;
    }

    updateMarkerElement(marker, question, data, container, scrollableHeight) {
        // Toggle question class
        marker.classList.toggle('is-question', data.isQuestion);

        // Update favorite status and star icon
        const isFavorite = this.favorites.some(fav => fav.id === data.id);
        marker.classList.toggle('favorite', isFavorite);

        const questionWrapper = question.closest('.user-query') || question.closest('div[data-testid^="conversation-turn"]') || question;
        let existingStar = questionWrapper.querySelector('.witq-favorite-star');

        if (isFavorite) {
            if (!existingStar) {
                const star = document.createElement('div');
                star.className = 'witq-favorite-star';
                star.textContent = '★';
                questionWrapper.appendChild(star);
            }
        } else if (existingStar) {
            existingStar.remove();
        }

        // Update marker position using pre-calculated scrollableHeight
        const clamped = Math.min(Math.max(data.position, 0), scrollableHeight);
        marker.style.top = `${(clamped / scrollableHeight) * 100}%`;
    }
    
    // --- Event Handling & State ---
    
    setupEventListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'scrollToQuestion') {
                window.WITQ.dom.scrollToQuestionPosition(message.position);
                sendResponse({ status: 'scrolling' });
            } else if (message.type === 'getQuestions') {
                this.updateMarkers(true);
                sendResponse({ status: 'processing' });
            }
            return true;
        });

        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes.favorites) {
                this.updateMarkers(true);
            }
        });

        window.addEventListener('resize', () => {
            clearTimeout(this.debounceTimeout);
            this.debounceTimeout = setTimeout(() => this.updateMarkers(true), 300);
        });
    }

    startObserver() {
        const container = window.WITQ.dom.getScrollContainer();
        const observerTarget = container === window ? document.body : container;

        if (!observerTarget) {
            setTimeout(() => this.startObserver(), 500);
            return;
        }

        this.observer = new MutationObserver((mutations) => {
            const isRelevant = mutations.some(m => 
                m.type === 'childList' && 
                ([...m.addedNodes, ...m.removedNodes].some(node => 
                    node.nodeType === 1 && (node.matches(this.config.questionSelector) || node.querySelector(this.config.questionSelector))
                ))
            );

            if (isRelevant) {
                clearTimeout(this.debounceTimeout);
                this.debounceTimeout = setTimeout(() => this.updateMarkers(true), 1000);
            }
        });

        this.observer.observe(observerTarget, { childList: true, subtree: true });
    }
}

// Global initialization with a safer delay
if (document.readyState === 'complete') {
    new MarkerManager();
} else {
    window.addEventListener('load', () => new MarkerManager());
}