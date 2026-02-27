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
                        ['img[alt]', 'div[data-testid^="file-attachment"] .font-medium'],
                        ['div[data-testid^="file-attachment"]', '.image-upload-item']
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

        const cleanFileName = (value) => {
            if (!value) return '';
            const cleaned = String(value)
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
        };

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
        const mainText = rawMainText
            .replace(/\byou\s*said\b\s*:?\s*/ig, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const parts = [];
        if (imageUploadCount > 0) {
            parts.push(imageUploadCount > 1 ? '[Uploaded images]' : '[Uploaded image]');
        }
        fileNames.forEach(name => parts.push(`[${name}]`));

        const outputLines = [];
        if (parts.length > 0) outputLines.push(...parts);
        if (mainText) outputLines.push(mainText);
        return outputLines.map(line => this.escapeHtml(line)).join('<br>');
    },

    escapeHtml: function(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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

