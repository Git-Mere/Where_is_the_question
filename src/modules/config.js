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
        let mainText = '';
        if (container) {
            const clone = container.cloneNode(true);
            (containerSelectorsToRemove || []).forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => el.remove());
            });
            mainText = clone.innerText.trim();
        }

        let imageUploadCount = 0;
        const fileNames = [];
        if (container) {
            (fileSelectors || []).forEach(selector => {
                container.querySelectorAll(selector).forEach(fileEl => {
                    let fileName = (fileEl.alt || fileEl.textContent || '').trim();

                    if (fileEl.tagName === 'IMG' && (fileName.toLowerCase() === 'image' || fileName.toLowerCase().startsWith('image:'))) {
                        imageUploadCount++;
                    } else if (fileName) {
                        if (!fileNames.includes(fileName)) {
                            fileNames.push(fileName);
                        }
                    }
                });
            });
        }
        
        const parts = [];
        if (imageUploadCount > 0) {
            parts.push(imageUploadCount > 1 ? '[업로드된 이미지들]' : '[업로드된 이미지]');
        }
        fileNames.forEach(name => {
            parts.push(`[${name}]`);
        });

        const fileString = parts.map(part => `<div>${part}</div>`).join('');
        const mainTextString = mainText ? `<div>${mainText}</div>` : '';

        return fileString + mainTextString;
    },

    isQuestion: function(text) {
        if (!text || text.length < 3) return false;
        const cleanText = text.replace(/<div>/g, ' ').replace(/<\/div>/g, ' ').trim();
        if (cleanText.endsWith('?')) return true;
        const lowerText = cleanText.toLowerCase();
        const prefixes = ['what ', 'where ', 'when ', 'who ', 'why ', 'how ', 'is ', 'can ', 'could ', 'would ', 'do ', 'does '];
        return prefixes.some(p => lowerText.startsWith(p));
    }
};

window.WITQ.config.initialize();
