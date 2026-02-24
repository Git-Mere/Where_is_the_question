window.WITQ = window.WITQ || {};

window.WITQ.config = {
    site: 'unknown',
    config: {},

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
                questionSelector: 'div[data-message-author-role="user"]',
                getQuestionText: (questionElement) => {
                    const conversationTurn = questionElement.closest('div[data-testid^="conversation-turn"]');
                    return this.extractQuestionData(conversationTurn || questionElement, 
                        '.text-base', 
                        ['img[alt]', 'div[data-testid^="file-attachment"] .font-medium'],
                        ['div[data-testid^="file-attachment"]', '.image-upload-item']
                    );
                }
            },
            gemini: {
                questionSelector: 'div.query-text',
                getQuestionText: (questionElement) => {
                    const userQuery = questionElement.closest('.user-query');
                    return this.extractQuestionData(userQuery || questionElement, 
                        '.query-text',
                        ['.file-attachment-card .filename', 'img'],
                        ['.file-attachment-card', '.upload-preview-container']
                    );
                }
            },
            unknown: {
                questionSelector: 'div[data-message-author-role="user"]',
                getQuestionText: (questionElement) => questionElement.innerText.trim()
            }
        };
        return siteConfigs[site] || siteConfigs.unknown;
    },

    extractQuestionData: function(container, textSelector, fileSelectors, containerSelectorsToRemove) {
        if (!container) return '';

        // 1. Collect file/image information
        let imageUploadCount = 0;
        const fileNames = [];
        
        (fileSelectors || []).forEach(selector => {
            container.querySelectorAll(selector).forEach(fileEl => {
                let fileName = (fileEl.alt || fileEl.textContent || '').trim();
                if (fileEl.tagName === 'IMG' && (fileName.toLowerCase() === 'image' || fileName.toLowerCase().startsWith('image:'))) {
                    imageUploadCount++;
                } else if (fileName) {
                    if (!fileNames.includes(fileName)) fileNames.push(fileName);
                }
            });
        });

        // 2. Extract main text efficiently without cloneNode
        // We'll use a simple recursive function to get text, skipping 'toRemove' elements
        const getCleanText = (node, excludeSelectors) => {
            let text = '';
            for (let child of node.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    text += child.textContent;
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    const shouldExclude = excludeSelectors.some(sel => child.matches(sel) || child.closest(sel));
                    if (!shouldExclude) {
                        text += getCleanText(child, excludeSelectors);
                    }
                }
            }
            return text;
        };

        const mainText = getCleanText(container, containerSelectorsToRemove || []).trim();
        
        const parts = [];
        if (imageUploadCount > 0) {
            parts.push(imageUploadCount > 1 ? '[업로드된 이미지들]' : '[업로드된 이미지]');
        }
        fileNames.forEach(name => parts.push(`[${name}]`));

        const fileString = parts.map(part => `<div>${part}</div>`).join('');
        const mainTextString = mainText ? `<div>${mainText}</div>` : '';

        return fileString + mainTextString;
    },

    isQuestion: function(text) {
        if (!text || text.length < 3) return false;
        const cleanText = text.replace(/<[^>]+>/g, ' ').trim();
        
        // Match common question marks at the end
        if (/[?？]$/.test(cleanText)) return true;

        const lowerText = cleanText.toLowerCase();
        // Common English question starters
        const engPrefixes = /^(what|where|when|who|why|how|is|can|could|would|do|does|did|will|should|may|might)\s/i;
        if (engPrefixes.test(lowerText)) return true;

        // Korean question markers (simple check for endings)
        const korEndings = /[가까나오죠요]\?*$/;
        if (korEndings.test(cleanText)) return true;

        return false;
    }
};

window.WITQ.config.initialize();
