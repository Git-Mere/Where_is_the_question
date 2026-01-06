function initialize() {
    console.log('[WITQ] Initializing content script...');
    // 이 스크립트는 ChatGPT/Gemini 페이지에 주입됩니다.

    // 디바운스용 타이머
    let debounceTimeout = null;
    let lastQuestionsSignature = '';

    // popup이 열려 있지 않을 때도 콘솔 에러가 안 뜨도록 questionList 메시지를 안전하게 보내는 함수
    function safeSendQuestionList(questionsForPopup) {
         if (!chrome.runtime || !chrome.runtime.id || !chrome.runtime.sendMessage) {
            console.warn('[WITQ] chrome.runtime.sendMessage is not available.');
            return;
         }

        try {
            console.log('[WITQ] Sending questionList to popup:', questionsForPopup);
            chrome.runtime.sendMessage(
                { type: 'questionList', questions: questionsForPopup },
                () => {
                    if (chrome.runtime.lastError) {
                        // "Could not establish connection. Receiving end does not exist." is expected if popup is not open.
                        if (!chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
                           console.warn('[WITQ] sendMessage failed:', chrome.runtime.lastError.message);
                        }
                    }
                }
            );
        } catch (e) {
            console.error('[WITQ] Exception during sendMessage:', e);
        }
    }

    function isQuestion(text) {
        if (!text || text.length < 3) return false;
        if (text.trim().endsWith('?')) return true;
        const lowerText = text.toLowerCase();
        if (lowerText.startsWith('what ') ||
            lowerText.startsWith('where ') ||
            lowerText.startsWith('when ') ||
            lowerText.startsWith('who ') ||
            lowerText.startsWith('why ') ||
            lowerText.startsWith('how ') ||
            lowerText.startsWith('is ') ||
            lowerText.startsWith('can ') ||
            lowerText.startsWith('could ') ||
            lowerText.startsWith('would ') ||
            lowerText.startsWith('do ') ||
            lowerText.startsWith('does ')) {
            return true;
        }
        return false;
    }


    // --- Storage & Event Listeners ---

    const getFavorites = () => {
        return new Promise((resolve, reject) => {
            if (!chrome.runtime || !chrome.storage) {
                return reject(new Error("Extension context not available."));
            }
            chrome.storage.local.get({ favorites: [] }, (result) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(result.favorites);
            });
        });
    };

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.favorites) {
            console.log('[WITQ] Favorites changed, re-rendering markers.');
            createQuestionMarkers(true);
        }
    });

    // --- Site-specific Configuration ---

    function getCurrentSite() {
        const { hostname } = window.location;
        if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) {
            return 'chatgpt';
        }
        if (hostname.includes('gemini.google.com')) {
            return 'gemini';
        }
        return 'unknown';
    }

    const siteConfig = {
        chatgpt: {
            questionSelector: 'div[data-message-author-role="user"]',
            getQuestionText: (questionElement) => {
                const conversationTurn = questionElement.closest('div[data-testid^="conversation-turn"]');
                if (conversationTurn) {
                    const textContentElement = conversationTurn.querySelector('.markdown.prose, .text-base, .whitespace-pre-wrap');
                     if (textContentElement && textContentElement.innerText.trim().length > 0) {
                        return textContentElement.innerText.trim();
                    }
                    if (conversationTurn.innerText.trim().length > 0) {
                        return conversationTurn.innerText.trim();
                    }
                }
                return questionElement.innerText.trim();
            }
        },
        gemini: {
            questionSelector: '.user-query',
            getQuestionText: (questionElement) => {
                // query-text-line 클래스를 가진 <p> 태그에서 텍스트 추출
                const promptTextEl = questionElement.querySelector('p.query-text-line');
                const text = promptTextEl ? promptTextEl.innerText.trim() : '';
                console.log('[WITQ] Extracted Gemini question text:', text, 'from element:', questionElement);
                return text;
            }
        },
        unknown: {
            questionSelector: 'div[data-message-author-role="user"]',
            getQuestionText: (questionElement) => questionElement.innerText.trim()
        }
    };


    // 🔹 실제로 스크롤되는 컨테이너 찾기
    function getScrollContainer() {
        const site = getCurrentSite();
        if (site === 'gemini') {
            const mainEl = document.querySelector('main');
             console.log('[WITQ] Gemini site, found mainEl:', mainEl);
            if (mainEl && mainEl.scrollHeight > mainEl.clientHeight) {
                console.log('[WITQ] Using mainEl as scroll container.');
                return mainEl;
            }
        }

        const config = siteConfig[site] || siteConfig.unknown;
        const firstQuestion = document.querySelector(config.questionSelector);

        if (!firstQuestion) {
            console.log('[WITQ] No first question found, using window as scroll container.');
            return window;
        }

        let el = firstQuestion.parentElement;
        while (el && el !== document.body) {
            const style = window.getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
                 console.log('[WITQ] Found scroll container:', el);
                return el;
            }
            el = el.parentElement;
        }
         console.log('[WITQ] No specific scroll container found, using window.');
        return window;
    }

    // 🔹 질문의 컨테이너 내 위치(px) 구하기
    function getQuestionPositionInContainer(question, container) {
        if (container === window) {
            const rect = question.getBoundingClientRect();
            return rect.top + window.scrollY;
        }
        const visibleElement = question.closest('.user-query') || question;
        let offset = 0;
        let el = visibleElement;
        while (el && el !== container) {
            offset += el.offsetTop;
            el = el.offsetParent;
        }
        return offset;
    }

    // 🔹 상단 고정 헤더 + 여유 마진만큼 보정값 구하기
    function getScrollOffset(scrollContainer) {
        const site = getCurrentSite();
        if (site === 'gemini') {
            return 20; // 약간의 여유 마진
        }

        if (scrollContainer === window) {
            const header =
                document.querySelector('header') ||
                document.querySelector('nav') ||
                document.querySelector('[data-testid="sidebar-nav"]');
            const headerHeight = header ? header.getBoundingClientRect().height : 0;
            return headerHeight + 12;
        }
        return 12;
    }

    function scrollToQuestionPosition(rawPosition, scrollContainerOverride = null) {
        const scrollContainer = scrollContainerOverride || getScrollContainer();
        const offset = getScrollOffset(scrollContainer);
        const target = Math.max(rawPosition - offset, 0);

        if (typeof scrollContainer.scrollTo === 'function') {
            scrollContainer.scrollTo({ top: target, behavior: 'smooth' });
        } else {
            scrollContainer.scrollTop = target;
        }
    }

    // 🔹 마커 생성 메인 함수
    async function createQuestionMarkers(force = false) {
        console.log(`[WITQ] Running createQuestionMarkers (force=${force})`);
        try {
            const site = getCurrentSite();
            console.log('[WITQ] Current site:', site);
            const config = siteConfig[site] || siteConfig.unknown;
            console.log('[WITQ] Using config:', config);

            const questions = document.querySelectorAll(config.questionSelector);
            console.log(`[WITQ] Found ${questions.length} question elements using selector: ${config.questionSelector}`, questions);
            const questionsForPopup = [];

            const favorites = await getFavorites();

            if (questions.length === 0) {
                const existContainer = document.getElementById('question-scrollbar-container');
                if (existContainer) {
                    existContainer.style.display = 'none';
                    existContainer.innerHTML = '';
                }
                lastQuestionsSignature = '';
                safeSendQuestionList([]);
                console.log('[WITQ] No questions found, clearing markers.');
                return;
            }

            const textSignature = Array.from(questions)
                .map(q => q.innerText.trim())
                .join('||');

            const scrollContainer = getScrollContainer();
            const heightSignature = (scrollContainer === window)
                ? document.documentElement.scrollHeight
                : scrollContainer.scrollHeight;

            const signature = `${textSignature}::${heightSignature}`;

            if (!force && signature === lastQuestionsSignature) {
                console.log('[WITQ] Signature unchanged, skipping redraw.');
                return;
            }

            lastQuestionsSignature = signature;
            console.log('[WITQ] Signature changed, redrawing markers.');


            let scrollbarContainer = document.getElementById('question-scrollbar-container');

            if (!scrollbarContainer) {
                scrollbarContainer = document.createElement('div');
                scrollbarContainer.id = 'question-scrollbar-container';
                document.body.appendChild(scrollbarContainer);
                console.log('[WITQ] Created scrollbar container.');
            }

            const scrollableHeight = (scrollContainer === window)
                ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
                : Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 1);

            if (scrollableHeight <= 0) {
                scrollbarContainer.style.display = 'none';
                scrollbarContainer.innerHTML = '';
                safeSendQuestionList([]);
                 console.log('[WITQ] Scrollable height is 0, hiding container.');
                return;
            } else {
                scrollbarContainer.style.display = 'block';
            }

            scrollbarContainer.innerHTML = '';

            questions.forEach((question, index) => {
                const marker = document.createElement('div');
                marker.className = 'question-marker';

                const questionText = config.getQuestionText(question) || `Question ${index + 1}`;
                
                if (!questionText) {
                    console.warn(`[WITQ] Empty questionText for element at index ${index}`, question);
                    return; // Don't create a marker for empty questions
                }

                console.log(`[WITQ] Processing question ${index}: "${questionText}"`);

                if (isQuestion(questionText)) {
                    marker.classList.add('is-question');
                }

                const questionPosition = getQuestionPositionInContainer(question, scrollContainer);
                const questionId = `${questionText.substring(0, 20)}-${Math.round(questionPosition)}`;

                if (favorites.some(fav => fav.id === questionId)) {
                    marker.classList.add('favorite');
                }

                const tooltip = document.createElement('div');
                tooltip.className = 'question-marker-tooltip';
                tooltip.textContent = questionText;
                marker.appendChild(tooltip);

                let hideTooltipTimer = null;

                const showTooltip = () => {
                    clearTimeout(hideTooltipTimer);
                    tooltip.style.opacity = '1';
                    tooltip.style.visibility = 'visible';
                };

                const hideTooltip = () => {
                    hideTooltipTimer = setTimeout(() => {
                        tooltip.style.opacity = '0';
                        tooltip.style.visibility = 'hidden';
                    }, 200);
                };

                marker.addEventListener('mouseenter', showTooltip);
                marker.addEventListener('mouseleave', hideTooltip);
                tooltip.addEventListener('mouseenter', showTooltip);
                tooltip.addEventListener('mouseleave', hideTooltip);

                questionsForPopup.push({
                    id: questionId,
                    text: questionText,
                    position: questionPosition,
                    isQuestion: isQuestion(questionText)
                });

                const clamped = Math.min(Math.max(questionPosition, 0), scrollableHeight);
                marker.style.top = `${(clamped / scrollableHeight) * 100}%`;

                marker.addEventListener('click', () => {
                    const currentContainer = getScrollContainer();
                    const currentPos = getQuestionPositionInContainer(question, currentContainer);
                    scrollToQuestionPosition(currentPos, currentContainer);
                });

                marker.addEventListener('contextmenu', async (e) => {
                    e.preventDefault();
                    const currentFavorites = await getFavorites();
                    const isFavorite = currentFavorites.some(fav => fav.id === questionId);
                    let updatedFavorites;

                    if (isFavorite) {
                        updatedFavorites = currentFavorites.filter(fav => fav.id !== questionId);
                    } else {
                        updatedFavorites = [...currentFavorites, { id: questionId, text: questionText, position: questionPosition }];
                    }
                    chrome.storage.local.set({ favorites: updatedFavorites });
                });

                scrollbarContainer.appendChild(marker);
            });

            safeSendQuestionList(questionsForPopup);
        } catch (error) {
            console.error('[WITQ] FATAL: Error in createQuestionMarkers:', error);
        }
    }

    // --- Initial Execution & Observers ---

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'scrollToQuestion') {
            scrollToQuestionPosition(message.position);
            sendResponse({ status: 'scrolling' });
        } else if (message.type === 'getQuestions') {
            createQuestionMarkers(true);
            sendResponse({ status: 'processing' });
        }
        return true;
    });

    window.addEventListener('resize', () => {
        clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(createQuestionMarkers, 300);
    });

    const observer = new MutationObserver((mutations) => {
        const site = getCurrentSite();
        
        const isRelevantChange = mutations.some(mutation => {
            if (mutation.type !== 'childList') return false;

            for (const addedNode of mutation.addedNodes) {
                if (addedNode.nodeType === 1) {
                    if (site === 'gemini') {
                        if (addedNode.matches('.response-container, .user-query') || addedNode.querySelector('.response-container, .user-query')) {
                            console.log('[WITQ] MutationObserver detected relevant change on Gemini:', addedNode);
                            return true;
                        }
                    } else {
                        if (addedNode.hasAttribute('data-message-author-role') || addedNode.querySelector('[data-message-author-role]')) {
                            console.log('[WITQ] MutationObserver detected relevant change on ChatGPT:', addedNode);
                            return true;
                        }
                    }
                }
            }
            return false;
        });

        if (isRelevantChange) {
            console.log('[WITQ] Relevant change detected, debouncing createQuestionMarkers.');
            clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => createQuestionMarkers(true), 1500);
        }
    });

    setTimeout(() => createQuestionMarkers(true), 1000);

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: false
    });
}

// 페이지의 자체 스크립트와 충돌을 피하기 위해 약간의 지연 후 실행
setTimeout(initialize, 2000);


