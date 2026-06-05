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

        // 첨부 종류(확장자) 목록 수집 — 중복 제거, 순서 유지
        const attachmentTypes = [];
        if (imageUploadCount > 0) {
            attachmentTypes.push('이미지');
        }
        fileNames.forEach(name => {
            const extMatch = name.match(/\.([a-z0-9]{2,8})$/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : '파일';
            if (!attachmentTypes.includes(ext)) attachmentTypes.push(ext);
        });

        const outputLines = [];
        if (attachmentTypes.length > 0) {
            // 예: "*png 첨부" 또는 "*이미지, pdf 첨부"
            const label = attachmentTypes.join(', ');
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

