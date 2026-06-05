window.WITQ = window.WITQ || {};

window.WITQ.config = {
    site: 'unknown',
    config: {},
    chatgptElementStrategy: null,

    initialize: function() {
        this.site = this.getCurrentSite();
        this.config = this.getSiteConfig(this.site);
    },

    getCurrentSite: function() {
        const { hostname } = window.location;
        if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) return 'chatgpt';
        if (hostname.includes('gemini.google.com')) return 'gemini';
        if (hostname.includes('claude.ai')) return 'claude';
        if (hostname.includes('grok.com')) return 'grok';
        return 'unknown';
    },

    getSiteConfig: function(site) {
        const siteConfigs = {
            chatgpt: {
                questionSelector: '[data-message-author-role="user"]',
                getQuestionElements: () => {
                    const strategies = {
                        role: () => Array.from(document.querySelectorAll('[data-message-author-role="user"]')),
                        nested: () => Array.from(document.querySelectorAll(
                            '[data-testid^="conversation-turn"] [data-message-author-role="user"], [data-testid^="conversation-turn"] [data-testid="user-message"]'
                        )),
                        known: () => Array.from(document.querySelectorAll(
                            '[data-testid="user-message"], [aria-label*="You said"], [aria-label*="you said"]'
                        )),
                        narration: () => Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'))
                            .filter(turn => turn.querySelector('[aria-label*="You said"], [aria-label*="you said"]')),
                        turnFallback: () => Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'))
                            .filter(turn => {
                                if (turn.querySelector('[data-message-author-role="assistant"]')) return false;
                                return !!(turn.textContent || '').trim();
                            })
                    };

                    // Reuse last successful strategy to avoid full-document multi-pass scans on every update.
                    if (this.chatgptElementStrategy && strategies[this.chatgptElementStrategy]) {
                        const cachedResult = strategies[this.chatgptElementStrategy]();
                        if (cachedResult.length > 0) return cachedResult;
                        this.chatgptElementStrategy = null;
                    }

                    const order = ['role', 'nested', 'known', 'narration', 'turnFallback'];
                    for (const key of order) {
                        const result = strategies[key]();
                        if (result.length > 0) {
                            this.chatgptElementStrategy = key;
                            return result;
                        }
                    }
                    return [];
                },
                getQuestionText: (questionElement) => {
                    const scopedUserNode =
                        questionElement.querySelector?.('[data-message-author-role="user"], [data-testid="user-message"], [aria-label*="You said"], [aria-label*="you said"]') ||
                        questionElement;
                    const conversationTurn = scopedUserNode.closest('[data-testid^="conversation-turn"]');
                    return this.extractQuestionData(
                        scopedUserNode || conversationTurn || questionElement,
                        '.text-base',
                        // .truncate.font-semibold: 현행 파일 카드의 파일명 (testid 방식은 구 DOM 호환용 유지)
                        ['img[alt]', 'div[data-testid^="file-attachment"] .font-medium', '.truncate.font-semibold'],
                        // 파일명/종류 라벨("PDF" 등)이 본문 텍스트로 새지 않게 제외
                        ['div[data-testid^="file-attachment"]', '.image-upload-item', '.truncate.font-semibold', '.truncate.text-token-text-secondary']
                    );
                }
            },
            gemini: {
                questionSelector: 'div.query-text, .user-query .query-text, .user-query-container .query-text, .query-with-attachments-container .query-text',
                getQuestionElements: () => {
                    const primary = Array.from(document.querySelectorAll(
                        'div.query-text, .user-query .query-text, .user-query-container .query-text, .query-with-attachments-container .query-text'
                    ));
                    if (primary.length > 0) return primary;

                    return Array.from(document.querySelectorAll(
                        '.user-query, .user-query-container, .query-with-attachments-container'
                    ));
                },
                getQuestionText: (questionElement) => {
                    const userQuery = questionElement.closest('.user-query') ||
                                      questionElement.closest('.user-query-container') ||
                                      questionElement.closest('.query-with-attachments-container');
                    return this.extractQuestionData(
                        userQuery || questionElement,
                        '.query-text',
                        [
                            '.file-attachment-card .filename',
                            '.file-attachment-card [data-file-name]',
                            '.file-attachment-card [title]',
                            '.file-attachment-chip .filename',
                            '.query-with-attachments-container [data-file-name]',
                            '.query-with-attachments-container [title]',
                            '.query-with-attachments-container [aria-label]',
                            '.query-with-attachments-container a[href]',
                            '.query-with-attachments-container button[title]',
                            'img'
                        ],
                        ['.file-attachment-card', '.upload-preview-container']
                    );
                }
            },
            claude: {
                questionSelector: '[data-testid="user-message"], .font-user-message',
                getQuestionElements: () => {
                    const primary = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
                    if (primary.length > 0) return primary;
                    // 폴백: 구 UI 클래스
                    return Array.from(document.querySelectorAll('.font-user-message'));
                },
                getQuestionText: (questionElement) => {
                    // 첨부 썸네일 img의 alt가 파일명인 경우가 있어 img를 파일 셀렉터로 사용
                    return this.extractQuestionData(questionElement, null, ['img'], []);
                }
            },
            grok: {
                questionSelector: 'div[id^="response-"] .message-bubble',
                getQuestionElements: () => {
                    // 행 단위로 순회: AI 답변 마커(.response-content-markdown)가 없는 행이 사용자 메시지
                    const rows = Array.from(document.querySelectorAll('div[id^="response-"]'));
                    const userBubbles = [];
                    rows.forEach(row => {
                        if (row.querySelector('.response-content-markdown')) return;
                        const bubble = row.querySelector('.message-bubble');
                        if (bubble) userBubbles.push(bubble);
                    });
                    if (userBubbles.length > 0) return userBubbles;
                    // 폴백: 오른쪽 정렬(.items-end) 행 전체
                    return rows.filter(row =>
                        row.classList.contains('items-end') || row.querySelector(':scope > .items-end')
                    );
                },
                getQuestionText: (questionElement) => {
                    return this.extractQuestionData(questionElement, null, ['img'], []);
                }
            },
            unknown: {
                questionSelector: '[data-message-author-role="user"]',
                getQuestionElements: () => Array.from(document.querySelectorAll('[data-message-author-role="user"]')),
                getQuestionText: (questionElement) => (questionElement.innerText || '').trim()
            }
        };

        return siteConfigs[site] || siteConfigs.unknown;
    },

    extractQuestionData: function(container, textSelector, fileSelectors, containerSelectorsToRemove) {
        if (!container) return '';

        let imageUploadCount = 0;
        const fileNames = [];

        const cleanFileName = window.WITQ.text.normalizeFileName;

        (fileSelectors || []).forEach(selector => {
            container.querySelectorAll(selector).forEach(fileEl => {
                const raw = (
                    fileEl.getAttribute?.('data-file-name') ||
                    fileEl.getAttribute?.('title') ||
                    fileEl.getAttribute?.('aria-label') ||
                    fileEl.alt ||
                    fileEl.textContent ||
                    ''
                ).trim();
                if (!raw) return;

                if (fileEl.tagName === 'IMG' && (raw.toLowerCase() === 'image' || raw.toLowerCase().startsWith('image:'))) {
                    imageUploadCount++;
                    return;
                }

                const cleaned = cleanFileName(raw);
                if (!cleaned) return;
                if (!fileNames.includes(cleaned)) fileNames.push(cleaned);
            });
        });

        const getCleanText = (node, excludeSelectors) => {
            let text = '';
            for (const child of node.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    text += child.textContent;
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    const shouldExclude = (excludeSelectors || []).some(sel => child.matches(sel) || child.closest(sel));
                    if (!shouldExclude) text += getCleanText(child, excludeSelectors);
                }
            }
            return text;
        };

        const rawMainText = getCleanText(container, containerSelectorsToRemove || []).trim();
        const mainText = window.WITQ.text.stripYouSaid(rawMainText).replace(/\s+/g, ' ').trim();

        // 첨부 파일명 목록 수집 — 이미지 업로드는 '이미지' 레이블, 나머지는 실제 파일명
        const attachmentLabels = [];
        if (imageUploadCount > 0) {
            attachmentLabels.push('이미지');
        }
        fileNames.forEach(name => attachmentLabels.push(name));

        const outputLines = [];
        if (attachmentLabels.length > 0) {
            // 예: "*기숙사 거주 사실 확인서.pdf 첨부" 또는 "*이미지, 보고서.pdf 첨부"
            const label = attachmentLabels.join(', ');
            outputLines.push(window.WITQ.text.escapeHtml(`*${label} 첨부`));
        }
        if (mainText) outputLines.push(window.WITQ.text.escapeHtml(mainText));
        return outputLines.join('<br>');
    },

    isQuestion: function(text) {
        if (!text || text.length < 2) return false;
        const cleanText = text.replace(/<[^>]+>/g, ' ').trim();
        if (!cleanText) return false;

        if (/\?$/.test(cleanText)) return true;

        const lowerText = cleanText.toLowerCase();
        if (/^(what|where|when|who|why|how|is|are|can|could|would|do|does|did|will|should|may|might)\s/.test(lowerText)) {
            return true;
        }

        return false;
    }
};

window.WITQ.config.initialize();

