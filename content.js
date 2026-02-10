class MarkerManager {
    constructor() {
        this.debounceTimeout = null;
        this.lastQuestionsSignature = '';
        this.favorites = [];
        this.site = window.WITQ.config.site;
        this.config = window.WITQ.config.config;
        this.scrollContainer = null;
        this.scrollbarContainer = null;
        this.observer = null;
        this.markers = new Map(); // Maps questionElement to markerElement

        this.initialize();
    }

    initialize() {
        window.WITQ.storage.getFavorites().then(favorites => {
            this.favorites = favorites;
            this.updateMarkers(true); // Initial marker creation
        });

        this.setupEventListeners();
        this.startObserver();
    }
    
    // --- Marker Management ---

    async updateMarkers(force = false) {
        try {
            const questions = document.querySelectorAll(this.config.questionSelector);
            const questionsForPopup = [];
            const currentQuestionElements = new Set(questions); // For efficient lookup

            // Get scrollbar container
            if (!this.scrollbarContainer) {
                this.scrollbarContainer = document.getElementById('question-scrollbar-container');
                if (!this.scrollbarContainer) {
                    this.scrollbarContainer = document.createElement('div');
                    this.scrollbarContainer.id = 'question-scrollbar-container';
                    document.body.appendChild(this.scrollbarContainer);
                }
            }

            const container = window.WITQ.dom.getScrollContainer();
            const scrollableHeight = (container === window) 
                ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) 
                : Math.max(container.scrollHeight - container.clientHeight, 1);
            
            if (questions.length === 0 || scrollableHeight <= 0) {
                 this.scrollbarContainer.style.display = 'none';
                 this.scrollbarContainer.innerHTML = '';
                 window.WITQ.storage.safeSendQuestionList([]);
                 this.markers.clear(); // Clear all tracked markers
                 return;
            } else {
                 this.scrollbarContainer.style.display = 'block';
            }

            // Remove markers for questions that no longer exist
            for (const [questionEl, markerEl] of this.markers.entries()) {
                if (!currentQuestionElements.has(questionEl) || !document.body.contains(questionEl)) {
                    markerEl.remove();
                    // Also remove the star from the question wrapper if it exists
                    const questionWrapper = questionEl.closest('.user-query') || questionEl.closest('div[data-testid^="conversation-turn"]') || questionEl;
                    const existingStar = questionWrapper ? questionWrapper.querySelector('.witq-favorite-star') : null;
                    if (existingStar) {
                        existingStar.remove();
                    }
                    this.markers.delete(questionEl);
                }
            }

            this.favorites = await window.WITQ.storage.getFavorites(); // Refresh favorites

            // Add new markers or update existing ones
            questions.forEach((question) => {
                const questionText = this.config.getQuestionText(question);
                if (!questionText) return;

                let marker = this.markers.get(question);
                if (!marker) {
                    marker = this.createMarkerElement(question, questionText, container);
                    this.scrollbarContainer.appendChild(marker);
                    this.markers.set(question, marker);
                } else {
                    this.updateMarkerElement(marker, question, questionText, container);
                }

                questionsForPopup.push({
                    id: this.getQuestionId(question, questionText, container),
                    text: questionText,
                    position: window.WITQ.dom.getQuestionPositionInContainer(question, container),
                    isQuestion: window.WITQ.config.isQuestion(questionText)
                });
            });

            window.WITQ.storage.safeSendQuestionList(questionsForPopup);
            this.lastQuestionsSignature = this.getQuestionsSignature(questions, container); // Update signature after all changes
        } catch (error) {
            // console.warn(`[WITQ] Marker update failed: ${error.message}`);
        }
    }
    
    getQuestionsSignature(questions, container) {
        const newSignature = Array.from(questions).map(q => q.innerText.trim()).join('||');
        const heightSignature = (container === window) ? document.documentElement.scrollHeight : container.scrollHeight;
        return `${newSignature}::${heightSignature}`;
    }

    createMarkerElement(question, questionText, container) {
        const marker = document.createElement('div');
        marker.className = 'question-marker';

        const tooltip = document.createElement('div');
        tooltip.className = 'question-marker-tooltip';
        marker.appendChild(tooltip);

        let hideTooltipTimer = null;
        const showTooltip = (text) => {
            clearTimeout(hideTooltipTimer);
            tooltip.innerHTML = text;
            tooltip.style.visibility = 'visible';
            tooltip.style.opacity = '0';
            void tooltip.offsetHeight; // Force reflow
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
                tooltip.innerHTML = '';
            }, 200);
        };

        marker.addEventListener('mouseenter', () => showTooltip(questionText));
        marker.addEventListener('mouseleave', hideTooltip);
        tooltip.addEventListener('mouseenter', () => clearTimeout(hideTooltipTimer));
        tooltip.addEventListener('mouseleave', hideTooltip);

        marker.addEventListener('click', () => {
            const currentContainer = window.WITQ.dom.getScrollContainer();
            const currentPos = window.WITQ.dom.getQuestionPositionInContainer(question, currentContainer);
            window.WITQ.dom.scrollToQuestionPosition(currentPos, currentContainer);
        });

        marker.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            const currentFavorites = await window.WITQ.storage.getFavorites();
            const questionId = this.getQuestionId(question, questionText, container);
            const isFavorite = currentFavorites.some(fav => fav.id === questionId);
            let updatedFavorites;
            if (isFavorite) {
                updatedFavorites = currentFavorites.filter(fav => fav.id !== questionId);
            } else {
                updatedFavorites = [...currentFavorites, { id: questionId, text: questionText, position: window.WITQ.dom.getQuestionPositionInContainer(question, container) }];
            }
            chrome.storage.local.set({ favorites: updatedFavorites });
        });

        this.updateMarkerElement(marker, question, questionText, container); // Initial update for position/favorite

        return marker;
    }

    updateMarkerElement(marker, question, questionText, container) {
        // Update question marker style
        if (window.WITQ.config.isQuestion(questionText)) {
            marker.classList.add('is-question');
        } else {
            marker.classList.remove('is-question');
        }

        // Update favorite status and star icon
        const questionId = this.getQuestionId(question, questionText, container);
        const questionWrapper = question.closest('.user-query') || question.closest('div[data-testid^="conversation-turn"]') || question;
        let existingStar = questionWrapper.querySelector('.witq-favorite-star');

        if (this.favorites.some(fav => fav.id === questionId)) {
            marker.classList.add('favorite');
            if (!existingStar) {
                const star = document.createElement('div');
                star.className = 'witq-favorite-star';
                star.textContent = '★';
                questionWrapper.appendChild(star);
            }
        } else {
            marker.classList.remove('favorite');
            if (existingStar) {
                existingStar.remove();
            }
        }

        // Update marker position
        const questionPosition = window.WITQ.dom.getQuestionPositionInContainer(question, container);
        const scrollableHeight = (container === window) 
            ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) 
            : Math.max(container.scrollHeight - container.clientHeight, 1);
        const clamped = Math.min(Math.max(questionPosition, 0), scrollableHeight);
        marker.style.top = `${(clamped / scrollableHeight) * 100}%`;
    }
    
    getQuestionId(question, questionText, container) {
        const pos = window.WITQ.dom.getQuestionPositionInContainer(question, container);
        const textPart = questionText.replace(/<div>/g, ' ').replace(/<\/div>/g, ' ').substring(0, 30);
        return `${textPart}-${Math.round(pos)}`;
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
        const observerTarget = window.WITQ.dom.getScrollContainer() === window ? document.body : window.WITQ.dom.getScrollContainer();

        if (!observerTarget) {
            setTimeout(() => this.startObserver(), 500); // Retry if target not found
            return;
        }

        this.observer = new MutationObserver((mutations) => {
            const isRelevantChange = mutations.some(mutation => {
                if (mutation.type !== 'childList') return false;
                // Check for added nodes
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && (node.matches(this.config.questionSelector) || node.querySelector(this.config.questionSelector))) {
                        return true;
                    }
                }
                // Check for removed nodes
                 for (const node of mutation.removedNodes) {
                    if (node.nodeType === 1 && (node.matches(this.config.questionSelector) || node.querySelector(this.config.questionSelector))) {
                        return true;
                    }
                }
                return false;
            });

            if (isRelevantChange) {
                clearTimeout(this.debounceTimeout);
                this.debounceTimeout = setTimeout(() => this.updateMarkers(true), 1200);
            }
        });

        this.observer.observe(observerTarget, {
            childList: true,
            subtree: true,
        });
    }
}

// Global initialization
setTimeout(() => new MarkerManager(), 2000);