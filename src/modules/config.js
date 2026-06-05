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
                            // 현행 파일 칩: aria-label에 확장자 포함 전체 파일명 (예: "Instruction.pdf")
                            'button.new-file-preview-file',
                            '.file-attachment-card .filename',
                            '.file-attachment-card [data-file-name]',
                            '.file-attachment-card [title]',
                            '.file-attachment-chip .filename',
                            '.query-with-attachments-container [data-file-name]',
                            '.query-with-attachments-container [title]',
                            '.query-with-attachments-container [aria-label]',
                            '.query-with-attachments-container a[href]',
                            '.query-with-attachments-container button[title]',
                            // 파일 종류 아이콘(alt "DOCX icon" 등)은 파일명이 아니므로 제외
                            'img:not(.luminous-file-icon)'
                        ],
                        // .file-preview-container: 현행 파일 칩 영역 ("PDF", 파일명 라벨이 본문으로 새는 것 방지)
                        ['.file-attachment-card', '.upload-preview-container', '.file-preview-container']
                    );
                }
            },
            claude: {
                questionSelector: '[data-testid="user-message"], .font-user-message',
                getQuestionElements: () => {
                    const primary = Array.from(document.querySelectorAll('[data-testid="user-message"]'));

                    // 첨부 전용 턴 수집 1 (안전망): [data-test-render-count] 래퍼 중
                    // user-message가 없고 file-thumbnail이 있는 것.
                    const attachmentOnlyTurns = Array.from(
                        document.querySelectorAll('[data-test-render-count]')
                    ).filter(turn =>
                        !turn.querySelector('[data-testid="user-message"]') &&
                        turn.querySelector('[data-testid="file-thumbnail"]')
                    );

                    // 첨부 전용 턴 수집 2: 라이브 검증(2026-06-04) 결과 첨부 전용 질문은
                    // 턴 래퍼/user-message 없이 썸네일 그리드(div.grid.grid-cols-[...])만 렌더됨.
                    // 래퍼 밖 썸네일의 그리드 컨테이너를 질문 요소로 사용.
                    // form 내부는 입력창에 첨부 대기 중인 파일이므로 제외.
                    const orphanGrids = [];
                    document.querySelectorAll('[data-testid="file-thumbnail"]').forEach(th => {
                        if (th.closest('[data-test-render-count]') || th.closest('form')) return;
                        const grid = th.closest('div[class*="grid-cols"]');
                        if (grid && !orphanGrids.includes(grid)) orphanGrids.push(grid);
                    });

                    const combined = [...primary, ...attachmentOnlyTurns, ...orphanGrids];

                    if (combined.length === 0) {
                        // 폴백: 구 UI 클래스
                        return Array.from(document.querySelectorAll('.font-user-message'));
                    }

                    // 문서 순서 정렬 — 순서가 어긋나면 중복 질문 occurrence 접미사와
                    // 팝업 목록 순서가 깨지므로 compareDocumentPosition으로 정렬
                    combined.sort((a, b) => {
                        const pos = a.compareDocumentPosition(b);
                        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                        return 0;
                    });

                    return combined;
                },
                getQuestionText: (questionElement) => {
                    // 썸네일이 버블 밖([data-test-render-count] 래퍼 아래)에 있으므로
                    // 컨테이너를 래퍼 전체로 확장해 파일명과 본문을 함께 추출
                    const container = questionElement.closest('[data-test-render-count]') || questionElement;
                    return this.extractQuestionData(
                        container,
                        null,
                        // [data-testid="file-thumbnail"] h3: 깨끗한 파일명 (2026-06-04 실기기 DOM 샘플)
                        // img: 이미지 첨부 호환용 (aria-label은 ", txt, 76 lines" 등 노이즈 포함이라 사용 안 함)
                        ['[data-testid="file-thumbnail"] h3', 'img'],
                        // .sr-only: h2 "You said: ..." 본문 중복 방지
                        // [data-testid="file-thumbnail"]: 파일명·종류 라벨·줄 수가 본문으로 새는 것 방지
                        // [role="group"]: 액션 바 타임스탬프("7:25 PM") 제외 (aria-label="Message actions"는 로케일 의존)
                        ['.sr-only', '[data-testid="file-thumbnail"]', '[role="group"]']
                    );
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

