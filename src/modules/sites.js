// 사이트별 어댑터. 공통 로직(content.js)은 아래 인터페이스만 사용한다.
//
//   name                      'chatgpt' | 'claude' | 'gemini'
//   scrollOffset              질문으로 이동할 때 위쪽에 남길 여백(px, 고정 헤더 고려)
//   loadsOlderOnTop           위로 스크롤해야 예전 대화를 불러오는 사이트인지
//   scrollContainer()         대화 스크롤 요소
//   liveQuestions()           지금 화면(DOM)에 있는 질문들, 문서 순서
//                             [{ id, turnEl, bubbleEl, text, attachments: string[], images: number }]
//   fetchQuestions()          대화 데이터에서 질문 전체 목록 (실패/미지원이면 null)
//                             [{ id, text, attachments, images, weight }]
window.WITQ = window.WITQ || {};

(function() {
    const W = window.WITQ;
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    // Claude는 SPA 전환 직후 이전 화면을 잠깐 남겨둔다(chat-stale-nav-inert). 그 안의 요소는 제외.
    // 일반 aria-hidden/inert는 기준으로 쓰지 않는다: 사이트가 대화상자를 띄우면 배경 전체에 붙기 때문.
    // 숨겨진(display:none) 이전 화면은 content.js의 크기 검사가 걸러낸다.
    const isLive = el => !el.closest('[data-testid="chat-stale-nav-inert"]');

    // 같은 셀렉터의 스크롤 영역이 여러 개일 수 있다 (SPA 전환 후 숨겨진 이전 화면).
    // 질문을 포함한 것 → 화면에 보이는 것 순으로 고른다.
    function pickContainer(selector, sample) {
        const all = Array.from(document.querySelectorAll(selector));
        if (sample) {
            const owner = all.find(c => c.contains(sample));
            if (owner) return owner;
        }
        return all.find(c => c.getClientRects().length > 0 && c.clientHeight > 0) || null;
    }

    const firstLine = (str) => String(str || '').split('\n').map(s => s.trim()).find(Boolean) || '';

    // 텍스트가 없는 질문(첨부만)도 ID를 만들 수 있게 텍스트 해시 폴백
    const fallbackId = (prefix, text, index) =>
        `${prefix}-${W.text.hashString(W.text.normalizePlainText(text || ''))}-${index}`;

    async function fetchJson(url, options) {
        const res = await fetch(url, Object.assign({ credentials: 'include' }, options || {}));
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        return res.json();
    }

    // ---------------- ChatGPT ----------------
    const chatgpt = {
        name: 'chatgpt',
        scrollOffset: 72,
        loadsOlderOnTop: true,
        _token: null,
        _tokenAt: 0,

        scrollContainer(sample) {
            return pickContainer('.thread-scroll-container, [role="region"][aria-label][data-app-action-timeline-scroll]', sample);
        },

        liveQuestions() {
            const out = [];
            document.querySelectorAll('[data-turn-key]').forEach(turn => {
                if (!isLive(turn)) return;
                const heading = turn.querySelector('[data-conversation-role="user"]');
                const bubble = turn.querySelector('[data-user-message-bubble="true"]');
                if (!heading && !bubble) return; // 사용자 질문이 없는 턴
                const userScope = (heading && heading.parentElement) || turn;
                const text = bubble ? (bubble.innerText || bubble.textContent || '').trim() : '';
                // 파일 카드: <span title="파일명">. 질문 본문 안의 title은 제외
                const attachments = [];
                userScope.querySelectorAll('span[title]').forEach(s => {
                    if (bubble && bubble.contains(s)) return;
                    const name = (s.getAttribute('title') || '').trim();
                    if (name && !attachments.includes(name)) attachments.push(name);
                });
                const images = Array.from(userScope.querySelectorAll('img'))
                    .filter(img => !(bubble && bubble.contains(img))).length;
                out.push({
                    id: turn.getAttribute('data-turn-key'),
                    turnEl: turn,
                    bubbleEl: bubble || heading,
                    text,
                    attachments,
                    images
                });
            });
            return out;
        },

        conversationId() {
            const m = location.pathname.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i);
            return m ? m[1] : null;
        },

        async accessToken() {
            if (this._token && Date.now() - this._tokenAt < 10 * 60 * 1000) return this._token;
            const session = await fetchJson('/api/auth/session');
            this._token = session && session.accessToken;
            this._tokenAt = Date.now();
            return this._token;
        },

        async fetchQuestions() {
            const id = this.conversationId();
            if (!id) return null;
            const token = await this.accessToken();
            if (!token) return null;
            const json = await fetchJson(`/backend-api/conversation/${id}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            return W.parsers.parseChatGPTConversation(json);
        }
    };

    // ---------------- Claude ----------------
    const claude = {
        name: 'claude',
        scrollOffset: 16,
        loadsOlderOnTop: false,
        _orgId: null,

        scrollContainer(sample) {
            return pickContainer('[data-autoscroll-container="true"]', sample);
        },

        liveQuestions() {
            const out = [];
            let index = 0;
            const messages = Array.from(document.querySelectorAll('[data-cds="UserMessage"]')).filter(isLive);
            // 구 DOM 폴백: UserMessage 래퍼 없이 user-message만 있는 경우
            const nodes = messages.length > 0
                ? messages
                : Array.from(document.querySelectorAll('[data-testid="user-message"]')).filter(isLive);
            nodes.forEach(node => {
                const textEl = node.matches('[data-testid="user-message"]')
                    ? node
                    : node.querySelector('[data-testid="user-message"]');
                const text = textEl ? (textEl.innerText || textEl.textContent || '').trim() : '';
                const attachments = [];
                node.querySelectorAll('[data-testid="file-thumbnail"]').forEach(t => {
                    const name = firstLine(t.innerText || t.textContent);
                    if (name && !attachments.includes(name)) attachments.push(name);
                });
                const turnEl = node.closest('[data-testid="transcript-row"]') || node;
                const id = node.getAttribute('data-turn-key') ||
                    fallbackId('claude', text || attachments.join(','), index);
                index++;
                out.push({ id, turnEl, bubbleEl: textEl || node, text, attachments, images: 0 });
            });
            return out;
        },

        conversationId() {
            const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
            return m && UUID_RE.test(m[1]) ? m[1] : null;
        },

        async fetchQuestions() {
            const id = this.conversationId();
            if (!id) return null;
            const query = 'tree=True&rendering_mode=messages&render_all_tools=true';
            const tryOrg = async (orgId) =>
                fetchJson(`/api/organizations/${orgId}/chat_conversations/${id}?${query}`);

            if (this._orgId) {
                try { return W.parsers.parseClaudeConversation(await tryOrg(this._orgId)); } catch (e) {}
            }
            // 계정이 여러 조직에 속할 수 있어 대화가 있는 조직을 찾는다
            const orgs = await fetchJson('/api/organizations');
            for (const org of orgs || []) {
                try {
                    const json = await tryOrg(org.uuid);
                    this._orgId = org.uuid;
                    return W.parsers.parseClaudeConversation(json);
                } catch (e) {}
            }
            return null;
        }
    };

    // ---------------- Gemini ----------------
    const gemini = {
        name: 'gemini',
        scrollOffset: 16,
        loadsOlderOnTop: true,

        scrollContainer(sample) {
            return pickContainer('infinite-scroller.chat-history, [data-test-id="chat-history-container"]', sample);
        },

        liveQuestions() {
            const out = [];
            let index = 0;
            document.querySelectorAll('user-query').forEach(q => {
                if (!isLive(q)) return;
                const textEl = q.querySelector('.query-text');
                let text = '';
                if (textEl) {
                    // .query-text 안에는 스크린리더용 "You said" 제목이 같이 있어 본문 줄만 모은다
                    const lines = Array.from(textEl.querySelectorAll('.query-text-line, p'))
                        .map(p => (p.textContent || '').trim()).filter(Boolean);
                    text = lines.length > 0 ? lines.join('\n') : (textEl.textContent || '');
                    text = W.text.stripYouSaid(text).trim();
                }
                const attachments = [];
                // 파일 칩: aria-label이 확장자 포함 전체 파일명
                q.querySelectorAll('button.new-file-preview-file').forEach(b => {
                    const name = (b.getAttribute('aria-label') || '').trim();
                    if (name && !attachments.includes(name)) attachments.push(name);
                });
                // 업로드한 이미지 미리보기 (파일 종류 아이콘 img.luminous-file-icon은 제외)
                const images = q.querySelectorAll('img[data-test-id="uploaded-img"], .preview-image-button img').length;
                const turnEl = q.closest('.conversation-container') || q;
                const id = (turnEl.id && turnEl !== q) ? turnEl.id
                    : fallbackId('gemini', text || attachments.join(','), index);
                index++;
                out.push({ id, turnEl, bubbleEl: textEl || q, text, attachments, images });
            });
            return out;
        },

        conversationId() {
            const m = location.pathname.match(/\/app\/([0-9a-f]+)/i);
            return m ? m[1] : null;
        },

        // Gemini 대화 데이터는 내부 RPC 형식이라 쓰지 않는다 (화면에서만 읽음)
        async fetchQuestions() {
            return null;
        }
    };

    W.sites = {
        current() {
            const host = location.hostname;
            if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return chatgpt;
            if (host === 'claude.ai') return claude;
            if (host === 'gemini.google.com') return gemini;
            return null;
        }
    };
})();
