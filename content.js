// Where is the Question? 콘텐츠 스크립트
//
// 흐름
//   1. 대화가 바뀌면(주소 변경) 상태를 비우고, 사이트가 지원하면 대화 데이터에서 질문 전체 목록을 받는다.
//   2. 화면(DOM)에 렌더된 질문은 실제 위치를 잰다. 가상화로 사라진 질문은 마지막 측정값을 기억한다.
//   3. 실측 위치 + 대화 데이터의 분량 비율로 모든 질문의 마커 위치를 계산해 스크롤바 옆에 그린다.
//   4. 마커 클릭 시 질문이 화면에 있으면 바로, 없으면 어림 위치로 점프 → 렌더되면 정확히 맞춘다.
(function() {
    const W = window.WITQ;
    const site = W && W.sites && W.sites.current();
    if (!site) return;

    const MSG = (key) => {
        try { return chrome.i18n.getMessage(key) || ''; } catch (e) { return ''; }
    };

    const unescapeHtml = (s) => String(s || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

    const normalizeForMatch = (s) =>
        W.text.stripYouSaid(unescapeHtml(s)).replace(/\s+/g, ' ').trim().toLowerCase();

    const OWN_CLASS_RE = /^witq-/;
    const isOwnNode = (node) => node.nodeType === 1 &&
        (OWN_CLASS_RE.test(node.id || '') || Array.from(node.classList || []).some(c => OWN_CLASS_RE.test(c)));

    class Controller {
        constructor() {
            this.destroyed = false;
            this.debug = false;
            this.items = new Map();       // id -> { id, pos, live, turnEl, bubbleEl, domText, domAttachments, domImages }
            this.apiList = null;          // 대화 데이터에서 받은 질문 목록 (없으면 null)
            this.apiState = 'idle';       // idle | loading | done
            this.apiToken = 0;
            this.apiRefetchTimer = null;
            this.apiRefetchedFor = '';
            this.convKey = null;
            this.sawFirstQuestion = false;
            this.lastHeight = 0;
            this.container = null;
            this.layout = { ordered: [], fractions: [], loadedStart: 0, height: 1 };
            this.markers = new Map();     // id -> marker element
            this.favorites = [];
            this.favoriteIds = new Set();
            this.migratedConv = null;
            this.navToken = 0;
            this.refreshTimer = null;
            this.popupSignature = '';
            this.tooltipHideTimer = null;

            // 이전 인스턴스(확장 재로드/구버전) 정리. 신호를 먼저 보내고 나서 내 리스너를 단다.
            window.dispatchEvent(new Event('witq:teardown'));
            this.onTeardown = () => this.destroy();
            window.addEventListener('witq:teardown', this.onTeardown);
            document.querySelectorAll('#question-scrollbar-container, #witq-scan-indicator, .witq-favorite-star')
                .forEach(el => el.remove());

            this.buildUi();
            this.init();
        }

        log(...args) {
            if (this.debug) console.log('[WITQ]', ...args);
        }

        async init() {
            try {
                const r = await chrome.storage.local.get('witqDebug');
                this.debug = !!(r && r.witqDebug);
                if (this.debug) window.__witq = this;
            } catch (e) {}
            try {
                this.favorites = await W.storage.getFavorites();
            } catch (e) {
                this.favorites = [];
            }
            if (this.destroyed) return;
            this.setupListeners();
            this.checkConversation();
        }

        // ---------------- 대화 전환 ----------------

        checkConversation() {
            if (this.destroyed) return;
            const key = W.storage.conversationKey();
            if (key === this.convKey) return;
            this.log('conversation', key);
            this.convKey = key;
            this.resetState();
            this.fetchApi();
            this.scheduleRefresh(0);
        }

        resetState() {
            this.navToken++;
            this.items.clear();
            this.apiList = null;
            this.apiState = 'idle';
            this.apiToken++;
            clearTimeout(this.apiRefetchTimer);
            this.apiRefetchTimer = null;
            this.apiRefetchedFor = '';
            this.sawFirstQuestion = false;
            this.lastHeight = 0;
            this.layout = { ordered: [], fractions: [], loadedStart: 0, height: 1 };
            this.markers.forEach(m => m.remove());
            this.markers.clear();
            this.hideTooltip(true);
            document.querySelectorAll('.witq-star').forEach(el => el.remove());
            this.rebuildFavoriteIds();
            this.popupSignature = '';
            this.bar.style.display = 'none';
        }

        async fetchApi() {
            const token = ++this.apiToken;
            this.apiState = 'loading';
            let list = null;
            try {
                list = await site.fetchQuestions();
            } catch (e) {
                this.log('fetch failed', e);
            }
            if (this.destroyed || token !== this.apiToken) return;
            this.apiList = Array.isArray(list) ? list : null;
            this.apiState = 'done';
            this.log('api list', this.apiList ? this.apiList.length : null);
            this.scheduleRefresh(0);
        }

        // 화면에 대화 데이터에 없는 새 질문이 보이면(방금 보낸 질문 등) 잠시 뒤 한 번 다시 받는다
        scheduleRefetch(unknownIds) {
            const signature = unknownIds.join(',');
            if (!signature || signature === this.apiRefetchedFor || this.apiRefetchTimer) return;
            this.apiRefetchTimer = setTimeout(() => {
                this.apiRefetchTimer = null;
                this.apiRefetchedFor = signature;
                this.fetchApi();
            }, 4000);
        }

        // ---------------- 갱신 ----------------

        scheduleRefresh(delay = 200) {
            if (this.destroyed) return;
            if (delay === 0 && this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = null;
            }
            if (this.refreshTimer) return;
            this.refreshTimer = setTimeout(() => {
                this.refreshTimer = null;
                requestAnimationFrame(() => this.refreshNow());
            }, delay);
        }

        refreshNow() {
            if (this.destroyed) return;
            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = null;
            }
            try {
                this.refresh();
            } catch (e) {
                if (this.debug) console.warn('[WITQ] refresh failed', e);
            }
        }

        refresh() {
            if (!W.storage.contextAlive()) {
                // 확장이 재로드되어 이 인스턴스는 고아가 됨
                this.destroy();
                return;
            }
            // 숨겨진 화면(새 채팅으로 갔을 때 남아있는 이전 대화 등)의 질문은 제외
            const live = site.liveQuestions().filter(q => q.turnEl && q.turnEl.getClientRects().length > 0);
            const container = W.dom.resolveContainer(site.scrollContainer(live[0] && live[0].turnEl), live[0] && live[0].turnEl);
            this.container = container;
            const height = Math.max(container.scrollHeight, 1);

            const measured = live.map(q => ({ q, pos: W.dom.positionIn(q.turnEl, container) }));
            this.applyShift(measured, height);
            this.lastHeight = height;

            for (const it of this.items.values()) {
                it.live = false;
                it.turnEl = null;
                it.bubbleEl = null;
            }
            for (const { q, pos } of measured) {
                let it = this.items.get(q.id);
                if (!it) {
                    it = { id: q.id };
                    this.items.set(q.id, it);
                }
                it.pos = pos;
                it.live = true;
                it.turnEl = q.turnEl;
                it.bubbleEl = q.bubbleEl;
                it.domText = q.text;
                it.domAttachments = q.attachments;
                it.domImages = q.images;
            }

            const ordered = this.buildOrderedList();
            const complete = !site.loadsOlderOnTop || !this.apiList || this.sawFirstQuestion;
            const result = W.layout.computeLayout(ordered, { height, complete });
            this.layout = { ordered, fractions: result.fractions, loadedStart: result.loadedStart, height };

            this.maybeMigrateFavorites(ordered);
            this.render(container);
            this.sendPopupUpdate();
        }

        // 위쪽에 예전 대화가 끼어들거나 높이 추정이 바뀌면 화면 밖 질문의 기억된 위치도 같이 밀어준다
        applyShift(measured, height) {
            const pairs = [];
            let minPrevLive = Infinity;
            for (const { q, pos } of measured) {
                const it = this.items.get(q.id);
                if (it && it.pos !== null && it.pos !== undefined) {
                    pairs.push({ prev: it.pos, now: pos });
                    minPrevLive = Math.min(minPrevLive, it.pos);
                }
            }
            const shift = W.layout.medianShift(pairs);
            if (Math.abs(shift) <= 2) return;
            const dH = height - this.lastHeight;
            // 전체 높이가 같은 만큼 늘었으면 맨 위에 내용이 추가된 것 → 모든 질문이 밀림
            const wholeShift = this.lastHeight > 0 && Math.abs(dH - shift) <= Math.max(40, Math.abs(shift) * 0.2);
            const liveIds = new Set(measured.map(m => m.q.id));
            for (const it of this.items.values()) {
                if (liveIds.has(it.id) || it.pos === null || it.pos === undefined) continue;
                if (wholeShift || it.pos > minPrevLive) it.pos += shift;
            }
        }

        buildOrderedList() {
            const fromItem = (it) => ({
                id: it.id,
                text: it.domText || '',
                attachments: it.domAttachments || [],
                images: it.domImages || 0,
                weightStart: null,
                pos: it.pos,
                live: !!it.live
            });

            if (!this.apiList) {
                return Array.from(this.items.values())
                    .filter(it => it.pos !== null && it.pos !== undefined)
                    .sort((a, b) => a.pos - b.pos)
                    .map(fromItem);
            }

            const apiIds = new Set(this.apiList.map(q => q.id));
            const starts = W.layout.weightStarts(this.apiList.map(q => q.weight));
            const ordered = this.apiList.map((q, i) => {
                const it = this.items.get(q.id);
                return {
                    id: q.id,
                    text: q.text,
                    attachments: q.attachments || [],
                    images: q.images || 0,
                    weightStart: starts[i],
                    pos: it && it.pos !== undefined ? it.pos : null,
                    live: !!(it && it.live)
                };
            });
            if (this.apiList.length > 0) {
                const first = this.items.get(this.apiList[0].id);
                if (first && first.pos !== null && first.pos !== undefined) this.sawFirstQuestion = true;
            }

            const extras = Array.from(this.items.values())
                .filter(it => !apiIds.has(it.id) && it.pos !== null && it.pos !== undefined)
                .sort((a, b) => a.pos - b.pos);
            extras.forEach(it => ordered.push(fromItem(it)));
            const unknownLive = extras.filter(it => it.live).map(it => it.id);
            if (unknownLive.length > 0) this.scheduleRefetch(unknownLive);
            return ordered;
        }

        // ---------------- 표시 ----------------

        buildUi() {
            this.bar = document.createElement('div');
            this.bar.id = 'witq-bar';
            this.bar.style.display = 'none';

            this.tooltip = document.createElement('div');
            this.tooltip.id = 'witq-tooltip';
            this.tooltipAttach = document.createElement('div');
            this.tooltipAttach.className = 'witq-tooltip-attachment';
            this.tooltipMain = document.createElement('div');
            this.tooltipMain.className = 'witq-tooltip-main';
            this.tooltip.append(this.tooltipAttach, this.tooltipMain);

            (document.body || document.documentElement).append(this.bar, this.tooltip);
        }

        render(container) {
            const { ordered, fractions } = this.layout;
            if (ordered.length === 0) {
                this.bar.style.display = 'none';
                this.markers.forEach(m => m.remove());
                this.markers.clear();
                return;
            }

            const rect = W.dom.visibleRect(container);
            this.bar.style.display = 'block';
            this.bar.style.top = `${Math.max(0, rect.top)}px`;
            this.bar.style.height = `${Math.max(0, rect.height)}px`;
            this.bar.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
            const usable = Math.max(0, rect.height - 6);

            const keep = new Set();
            ordered.forEach((entry, i) => {
                keep.add(entry.id);
                let marker = this.markers.get(entry.id);
                if (!marker) {
                    marker = this.createMarker(entry.id);
                    this.markers.set(entry.id, marker);
                    this.bar.appendChild(marker);
                }
                marker.style.top = `${Math.round(fractions[i] * usable)}px`;
                marker.classList.toggle('favorite', this.favoriteIds.has(entry.id));
                marker.classList.toggle('in-view', entry.live && this.isInView(entry.id, rect));
            });
            for (const [id, marker] of this.markers) {
                if (!keep.has(id)) {
                    marker.remove();
                    this.markers.delete(id);
                }
            }

            this.renderStars();
        }

        isInView(id, rect) {
            const it = this.items.get(id);
            if (!it || !it.turnEl) return false;
            const r = (it.bubbleEl || it.turnEl).getBoundingClientRect();
            return r.bottom > rect.top && r.top < rect.bottom;
        }

        createMarker(id) {
            const marker = document.createElement('div');
            marker.className = 'witq-marker';
            marker.addEventListener('mouseenter', () => this.showTooltip(id, marker));
            marker.addEventListener('mouseleave', () => this.hideTooltip());
            marker.addEventListener('click', (e) => {
                e.preventDefault();
                this.hideTooltip(true);
                this.navigate(id);
            });
            marker.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.toggleFavorite(id);
            });
            return marker;
        }

        attachmentLabel(entry) {
            const labels = [];
            if (entry.images > 0) {
                labels.push(entry.images > 1 ? `${MSG('imageLabel')} ×${entry.images}` : MSG('imageLabel'));
            }
            (entry.attachments || []).forEach(n => labels.push(n));
            return labels.length ? `${labels.join(', ')} ${MSG('attachmentSuffix')}` : '';
        }

        previewText(entry) {
            const text = (entry.text || '').replace(/\s+/g, ' ').trim();
            if (text) return text.length > 300 ? `${text.slice(0, 300)}…` : text;
            return this.attachmentLabel(entry) || MSG('imageAttachment');
        }

        showTooltip(id, marker) {
            clearTimeout(this.tooltipHideTimer);
            const entry = this.layout.ordered.find(o => o.id === id);
            if (!entry) return;
            const attach = this.attachmentLabel(entry);
            const text = (entry.text || '').replace(/\s+/g, ' ').trim();
            this.tooltipAttach.textContent = attach;
            this.tooltipAttach.style.display = attach ? '' : 'none';
            this.tooltipMain.textContent = text.length > 500 ? `${text.slice(0, 500)}…` : text;
            this.tooltipMain.style.display = text ? '' : 'none';
            if (!attach && !text) this.tooltipMain.textContent = MSG('imageAttachment');
            if (!attach && !text) this.tooltipMain.style.display = '';

            const m = marker.getBoundingClientRect();
            this.tooltip.style.right = `${Math.max(8, window.innerWidth - m.left + 8)}px`;
            this.tooltip.classList.add('visible');
            const h = this.tooltip.offsetHeight;
            const top = Math.min(Math.max(8, m.top + m.height / 2 - h / 2), window.innerHeight - h - 8);
            this.tooltip.style.top = `${top}px`;
        }

        hideTooltip(immediate = false) {
            clearTimeout(this.tooltipHideTimer);
            if (immediate) {
                this.tooltip.classList.remove('visible');
                return;
            }
            this.tooltipHideTimer = setTimeout(() => this.tooltip.classList.remove('visible'), 120);
        }

        // 즐겨찾기한 질문 옆 별표. 화면에 렌더된 질문에만 붙인다.
        renderStars() {
            const jobs = [];
            for (const it of this.items.values()) {
                if (!it.live || !it.turnEl) continue;
                const existing = it.turnEl.querySelector(':scope > .witq-star');
                if (!this.favoriteIds.has(it.id)) {
                    if (existing) existing.remove();
                    continue;
                }
                let star = existing;
                if (!star) {
                    if (window.getComputedStyle(it.turnEl).position === 'static') {
                        it.turnEl.style.position = 'relative';
                    }
                    star = document.createElement('div');
                    star.className = 'witq-star';
                    star.textContent = '★';
                    it.turnEl.appendChild(star);
                }
                jobs.push({ star, turn: it.turnEl, bubble: it.bubbleEl || it.turnEl });
            }
            // 측정을 먼저 모두 하고 나서 스타일을 쓴다 (레이아웃 반복 계산 방지)
            const placed = jobs.map(j => {
                const t = j.turn.getBoundingClientRect();
                const b = j.bubble.getBoundingClientRect();
                const w = j.star.offsetWidth || 40;
                return { star: j.star, left: b.left - t.left - w - 8, top: b.top - t.top };
            });
            placed.forEach(p => {
                p.star.style.left = `${p.left}px`;
                p.star.style.top = `${p.top}px`;
            });
        }

        flash(el) {
            if (!el) return;
            el.classList.remove('witq-flash');
            void el.offsetWidth; // 애니메이션 재시작
            el.classList.add('witq-flash');
            setTimeout(() => el.classList.remove('witq-flash'), 1600);
        }

        // ---------------- 이동 ----------------

        async navigate(id) {
            const token = ++this.navToken;
            const convKey = this.convKey;
            let interrupted = false;
            const onInput = () => { interrupted = true; };
            const inputEvents = ['wheel', 'touchstart', 'keydown'];
            const opts = { capture: true, passive: true };
            const valid = () => !this.destroyed && token === this.navToken && !interrupted && convKey === this.convKey;

            // 클릭 자체로 생기는 입력 이벤트는 무시하도록 다음 틱부터 감지
            setTimeout(() => inputEvents.forEach(t => window.addEventListener(t, onInput, opts)), 0);
            try {
                let lastPx = null;
                for (let attempt = 0; attempt < 15; attempt++) {
                    this.refreshNow();
                    const container = this.container;
                    if (!container) return false;
                    const it = this.items.get(id);

                    if (it && it.live && it.turnEl && it.turnEl.isConnected) {
                        const pos = W.dom.positionIn(it.turnEl, container);
                        const near = Math.abs(pos - container.scrollTop) < container.clientHeight * 2;
                        const behavior = attempt === 0 && near ? 'smooth' : 'auto';
                        W.dom.scrollTo(container, pos - site.scrollOffset, behavior);
                        if (behavior === 'smooth') await W.dom.waitForScrollEnd(container);
                        // 가상화 사이트는 이동 중/직후 주변이 다시 그려지며 위치가 밀릴 수 있어 최대 2번 보정
                        for (let i = 0; i < 2; i++) {
                            await W.dom.waitForSettle(150, 600);
                            if (!valid() || !it.turnEl || !it.turnEl.isConnected) break;
                            const again = W.dom.positionIn(it.turnEl, container) - site.scrollOffset;
                            const maxTop = container.scrollHeight - container.clientHeight;
                            const target = Math.min(Math.max(0, again), maxTop);
                            if (Math.abs(target - container.scrollTop) <= 6) break;
                            W.dom.scrollTo(container, target, 'auto');
                        }
                        this.flash(it.bubbleEl || it.turnEl);
                        this.log('nav done', { id, attempt });
                        return true;
                    }

                    // 화면에 없음: 어림 위치로 점프해서 렌더를 유도
                    const { ordered, fractions } = this.layout;
                    const idx = ordered.findIndex(o => o.id === id);
                    if (idx < 0) return false;
                    let px = (it && it.pos !== null && it.pos !== undefined)
                        ? it.pos
                        : W.layout.fractionToPixel(fractions[idx], this.layout);
                    if (px === null) px = 0; // 아직 안 불러온 위쪽 → 맨 위로 가서 예전 대화를 불러오게 한다
                    px -= site.scrollOffset;
                    if (lastPx !== null && Math.abs(px - lastPx) < 5) {
                        // 같은 자리만 맴돌면 목표 방향으로 한 화면씩 이동
                        const liveIdx = ordered.map((o, i) => (o.live ? i : -1)).filter(i => i >= 0);
                        const up = liveIdx.length > 0 && idx < liveIdx[0];
                        px = container.scrollTop + (up ? -0.8 : 0.8) * container.clientHeight;
                    }
                    lastPx = px;
                    this.log('nav jump', { id, attempt, px: Math.round(px) });
                    W.dom.scrollTo(container, px, 'auto');
                    await W.dom.waitForSettle(180, 1000);
                    if (!valid()) return false;
                }
                this.log('nav give-up', { id });
                return false;
            } finally {
                setTimeout(() => inputEvents.forEach(t => window.removeEventListener(t, onInput, opts)), 0);
            }
        }

        // ---------------- 즐겨찾기 ----------------

        rebuildFavoriteIds() {
            this.favoriteIds = new Set(
                this.favorites.filter(f => f && f.convKey === this.convKey).map(f => f.id)
            );
        }

        async toggleFavorite(id) {
            try {
                const entry = this.layout.ordered.find(o => o.id === id);
                const favorites = await W.storage.getFavorites();
                const exists = favorites.some(f => f.id === id && f.convKey === this.convKey);
                const next = exists
                    ? favorites.filter(f => !(f.id === id && f.convKey === this.convKey))
                    : [...favorites, { id, convKey: this.convKey, text: entry ? this.previewText(entry) : '' }];
                this.favorites = next;
                this.rebuildFavoriteIds();
                this.scheduleRefresh(0);
                await W.storage.setFavorites(next);
            } catch (e) {
                if (!W.storage.contextAlive()) this.destroy();
            }
        }

        // v1.8 이하 즐겨찾기는 질문 텍스트 해시를 ID로 썼다. 텍스트가 같은 질문을 찾아 새 ID로 옮긴다.
        maybeMigrateFavorites(ordered) {
            if (this.migratedConv === this.convKey || ordered.length === 0) return;
            if (this.apiState !== 'done') return;
            this.migratedConv = this.convKey;
            const ids = new Set(ordered.map(o => o.id));
            let changed = false;
            const next = this.favorites.map(f => {
                if (!f || f.convKey !== this.convKey || ids.has(f.id)) return f;
                const favText = normalizeForMatch(f.text);
                if (!favText) return f;
                const match = ordered.find(o => {
                    const t = normalizeForMatch(o.text);
                    if (!t) return false;
                    const n = Math.min(80, favText.length, t.length);
                    return t === favText || (n >= 20 && t.slice(0, n) === favText.slice(0, n));
                });
                if (!match) return f;
                changed = true;
                return Object.assign({}, f, { id: match.id });
            });
            if (changed) {
                this.log('favorites migrated');
                this.favorites = next;
                this.rebuildFavoriteIds();
                W.storage.setFavorites(next).catch(() => {});
            }
        }

        // ---------------- 팝업 ----------------

        popupQuestions() {
            return this.layout.ordered.map(o => ({ id: o.id, text: this.previewText(o) }));
        }

        sendPopupUpdate() {
            const questions = this.popupQuestions();
            const signature = this.convKey + '|' + questions.map(q => q.id).join(',');
            if (signature === this.popupSignature) return;
            this.popupSignature = signature;
            try {
                chrome.runtime.sendMessage({ type: 'questionList', questions, convKey: this.convKey }, () => {
                    void chrome.runtime.lastError; // 팝업이 닫혀 있으면 받는 쪽이 없다
                });
            } catch (e) {}
        }

        // ---------------- 이벤트 ----------------

        setupListeners() {
            this.onMessage = (message, sender, sendResponse) => {
                if (!message) return;
                if (message.type === 'getQuestions') {
                    this.refreshNow();
                    sendResponse({ questions: this.popupQuestions(), convKey: this.convKey });
                } else if (message.type === 'scrollToQuestion' && message.id) {
                    this.navigate(message.id);
                    sendResponse({ status: 'ok' });
                }
            };
            chrome.runtime.onMessage.addListener(this.onMessage);

            this.onStorage = (changes, area) => {
                if (area !== 'local') return;
                if (changes.favorites) {
                    this.favorites = changes.favorites.newValue || [];
                    this.rebuildFavoriteIds();
                    this.scheduleRefresh(0);
                }
                if (changes.witqDebug) this.debug = !!changes.witqDebug.newValue;
            };
            chrome.storage.onChanged.addListener(this.onStorage);

            this.observer = new MutationObserver(mutations => {
                const relevant = mutations.some(m =>
                    !isOwnNode(m.target) &&
                    (Array.from(m.addedNodes).some(n => !isOwnNode(n)) ||
                     Array.from(m.removedNodes).some(n => !isOwnNode(n))));
                if (relevant) this.scheduleRefresh(250);
            });
            this.observer.observe(document.body, { childList: true, subtree: true });

            this.onScroll = () => this.scheduleRefresh(120);
            document.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
            this.onResize = () => this.scheduleRefresh(150);
            window.addEventListener('resize', this.onResize);

            // 사이트의 주소 변경(pushState)은 콘텐츠 스크립트에서 직접 가로챌 수 없어 주기적으로 확인한다
            this.urlTimer = setInterval(() => this.checkConversation(), 400);
            this.onPopState = () => this.checkConversation();
            window.addEventListener('popstate', this.onPopState);
        }

        destroy() {
            if (this.destroyed) return;
            this.destroyed = true;
            this.navToken++;
            clearTimeout(this.refreshTimer);
            clearTimeout(this.apiRefetchTimer);
            clearTimeout(this.tooltipHideTimer);
            clearInterval(this.urlTimer);
            if (this.observer) this.observer.disconnect();
            window.removeEventListener('witq:teardown', this.onTeardown);
            if (this.onScroll) document.removeEventListener('scroll', this.onScroll, { capture: true });
            if (this.onResize) window.removeEventListener('resize', this.onResize);
            if (this.onPopState) window.removeEventListener('popstate', this.onPopState);
            try { if (this.onMessage) chrome.runtime.onMessage.removeListener(this.onMessage); } catch (e) {}
            try { if (this.onStorage) chrome.storage.onChanged.removeListener(this.onStorage); } catch (e) {}
            if (this.bar) this.bar.remove();
            if (this.tooltip) this.tooltip.remove();
            document.querySelectorAll('.witq-star').forEach(el => el.remove());
            if (window.__witq === this) delete window.__witq;
        }
    }

    const start = () => new Controller();
    if (document.body) start();
    else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
