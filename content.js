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

    // 대화 데이터 캐시. 같은 대화를 다시 열 때마다 전체 대화를 다시 받지 않도록 탭 단위(sessionStorage)로 기억한다.
    // ChatGPT는 대화 읽기 요청에 계정 단위 제한이 있고, 제한에 걸리면 사이트가 대화/예전 메시지를 못 불러온다
    // ("A temporary limit is preventing this chat from loading", 2026-11-24 실측). 그래서 요청을 최소화한다.
    const API_CACHE_TTL_MS = 15 * 60 * 1000;
    const API_BACKOFF_MS = 10 * 60 * 1000;
    const API_CACHE_PREFIX = 'witq:conv:';
    const memoryCache = new Map(); // convKey -> { at, list }
    let apiBlockedUntil = 0;       // 429를 받으면 한동안 대화 데이터 요청을 아예 안 한다

    function readApiCache(key) {
        let entry = memoryCache.get(key);
        if (!entry) {
            try {
                const raw = sessionStorage.getItem(API_CACHE_PREFIX + key);
                if (raw) entry = JSON.parse(raw);
            } catch (e) {}
        }
        if (!entry || !Array.isArray(entry.list) || Date.now() - entry.at > API_CACHE_TTL_MS) return null;
        memoryCache.set(key, entry);
        return entry.list;
    }

    function writeApiCache(key, list) {
        const entry = { at: Date.now(), list };
        memoryCache.set(key, entry);
        try {
            // 미리보기에는 앞부분만 쓰므로 저장 크기를 줄인다
            const slim = list.map(q => Object.assign({}, q, { text: (q.text || '').slice(0, 600) }));
            sessionStorage.setItem(API_CACHE_PREFIX + key, JSON.stringify({ at: entry.at, list: slim }));
        } catch (e) {}
    }

    function dropApiCache(key) {
        memoryCache.delete(key);
        try { sessionStorage.removeItem(API_CACHE_PREFIX + key); } catch (e) {}
    }

    const NAV_TIMEOUT_MS = 15000;

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
            this.apiTimer = null;
            this.apiRefetchTimer = null;
            this.apiRefetchedAt = 0;
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
            this.toastTimer = null;

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
            this.loadApi();
            this.scheduleRefresh(0);
        }

        resetState() {
            this.navToken++;
            this.items.clear();
            this.apiList = null;
            this.apiState = 'idle';
            this.apiToken++;
            clearTimeout(this.apiTimer);
            this.apiTimer = null;
            clearTimeout(this.apiRefetchTimer);
            this.apiRefetchTimer = null;
            this.apiRefetchedAt = 0;
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

        // 대화 데이터 준비: 캐시가 있으면 바로 쓰고, 없으면 사이트가 먼저 대화를 불러오도록 잠깐 기다렸다가 받는다
        loadApi() {
            const cached = readApiCache(this.convKey);
            if (cached) {
                this.apiList = cached;
                this.apiState = 'done';
                this.log('api list (cache)', cached.length);
                return;
            }
            if (!site.conversationId() || Date.now() < apiBlockedUntil) {
                this.apiState = 'done';
                return;
            }
            this.apiState = 'loading';
            const token = ++this.apiToken;
            clearTimeout(this.apiTimer);
            this.apiTimer = setTimeout(() => {
                this.apiTimer = null;
                this.fetchApi(token);
            }, site.fetchDelay || 0);
        }

        async fetchApi(token) {
            if (token === undefined) token = ++this.apiToken;
            const convKey = this.convKey;
            this.apiState = 'loading';
            let list = null;
            try {
                list = await site.fetchQuestions();
            } catch (e) {
                this.log('fetch failed', e);
                if (e && e.status === 429) apiBlockedUntil = Date.now() + API_BACKOFF_MS;
            }
            if (this.destroyed || token !== this.apiToken || convKey !== this.convKey) return;
            if (Array.isArray(list)) {
                this.apiList = list;
                writeApiCache(convKey, list);
            } else if (!this.apiList) {
                this.apiList = null;
            }
            this.apiState = 'done';
            this.log('api list', this.apiList ? this.apiList.length : null);
            this.scheduleRefresh(0);
        }

        // 대화 데이터에 없는 질문이 기존 질문들 사이에 보이면(질문 수정으로 갈래가 바뀜 등) 다시 받는다.
        // 맨 끝에 붙는 새 질문은 화면에서 읽은 것만으로 충분하므로 다시 받지 않는다 (요청 최소화).
        scheduleRefetch() {
            if (this.apiRefetchTimer || this.apiState !== 'done') return;
            if (Date.now() < apiBlockedUntil || Date.now() - this.apiRefetchedAt < 60000) return;
            this.apiRefetchTimer = setTimeout(() => {
                this.apiRefetchTimer = null;
                this.apiRefetchedAt = Date.now();
                dropApiCache(this.convKey);
                this.fetchApi();
            }, 3000);
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
            // 모르는 질문이 화면에 있는데 그보다 아래에 대화 데이터의 질문이 보이면 "끝에 추가"가 아니다
            const unknownLive = extras.filter(it => it.live);
            if (unknownLive.length > 0) {
                const minUnknown = Math.min(...unknownLive.map(it => it.pos));
                const knownBelow = ordered.some(o => o.live && o.weightStart !== null && o.pos > minUnknown);
                if (knownBelow) this.scheduleRefetch();
            }
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

            this.toast = document.createElement('div');
            this.toast.id = 'witq-toast';

            (document.body || document.documentElement).append(this.bar, this.tooltip, this.toast);
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
            this.bar.style.right = `${Math.max(0, window.innerWidth - rect.right + W.dom.scrollbarWidth(container))}px`;
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
        //
        // 원칙
        //   - 방향은 "지금 렌더된 질문들보다 목표가 위인지 아래인지"로만 정한다. 기억해둔 위치는 가상화/지연 로딩으로
        //     금방 틀어지므로 어림값으로만 쓰고, 위아래로 지나치면 그 사이로 범위를 좁힌다(이분 탐색).
        //   - 스크롤 전에 합성 휠 이벤트로 사이트의 "맨 아래 고정"을 푼다(ChatGPT).
        //   - 맨 위에서 예전 대화를 불러와야 하면 실제로 불러와질 때까지(최대 6초) 기다리고, 실패 표시가 뜨면 멈춘다.
        //   - 사용자가 직접 휠/터치/키 입력을 하면 즉시 중단(합성 이벤트는 무시).

        turnSignature(container) {
            const first = container.querySelector(site.turnSelector);
            const top = first ? Math.round(first.getBoundingClientRect().top) : 0;
            return `${Math.round(W.dom.scrollTop(container))}|${container.querySelectorAll(site.turnSelector).length}|${top}`;
        }

        waitForTurns(container, timeoutMs = 1000) {
            return W.dom.waitForStable(() => this.turnSignature(container), 150, timeoutMs);
        }

        scrollContainerTo(container, top, behavior) {
            const cur = W.dom.scrollTop(container);
            W.dom.nudge(container, top < cur || top <= 0 ? -1 : 1);
            W.dom.scrollTo(container, top, behavior);
        }

        // 화면에 없는 질문의 어림 위치(px, 여백 반영 전). 위쪽 아직 안 불러온 구간이면 null.
        estimatePixel(idx, container) {
            const { ordered, fractions, loadedStart, height } = this.layout;
            const entry = ordered[idx];
            const it = this.items.get(entry.id);
            const live = [];
            ordered.forEach((o, i) => {
                if (!o.live) return;
                const li = this.items.get(o.id);
                // 대화 데이터에 없는 질문(방금 보낸 질문 등)은 분량 비율이 없어 기준으로 못 쓴다
                if (li && li.pos !== null && li.pos !== undefined && o.weightStart !== null) {
                    live.push({ i, pos: li.pos, w: o.weightStart });
                }
            });
            // 대화 분량 비율이 있으면 가장 가까운 렌더된 질문 기준으로 거리 환산
            if (entry.weightStart !== null && live.length > 0) {
                const anchor = live.reduce((a, b) => (Math.abs(b.i - idx) < Math.abs(a.i - idx) ? b : a));
                const pxPerWeight = Math.max(1, height) / Math.max(0.05, 1 - (loadedStart || 0));
                const px = anchor.pos + (entry.weightStart - anchor.w) * pxPerWeight;
                if (px < 0 && site.loadsOlderOnTop && loadedStart > 0) return null;
                return Math.max(0, px);
            }
            if (it && it.pos !== null && it.pos !== undefined) return it.pos;
            return W.layout.fractionToPixel(fractions[idx], this.layout);
        }

        showToast(text) {
            if (!text) return;
            this.toast.textContent = text;
            const rect = W.dom.visibleRect(this.container || document.scrollingElement);
            this.toast.style.top = `${Math.max(8, rect.top + 12)}px`;
            this.toast.style.right = `${Math.max(24, window.innerWidth - rect.right + 24)}px`;
            this.toast.classList.add('visible');
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => this.toast.classList.remove('visible'), 3500);
        }

        async navigate(id) {
            try {
                return await this.navigateInner(id);
            } catch (e) {
                this.log('nav failed', e);
                return false;
            }
        }

        async navigateInner(id) {
            const token = ++this.navToken;
            const convKey = this.convKey;
            let interrupted = false;
            const onInput = (e) => { if (e.isTrusted) interrupted = true; };
            const inputEvents = ['wheel', 'touchstart', 'keydown'];
            const opts = { capture: true, passive: true };
            const valid = () => !this.destroyed && token === this.navToken && !interrupted && convKey === this.convKey;
            const navStart = performance.now();
            let deadline = navStart + NAV_TIMEOUT_MS;

            // 클릭 자체로 생기는 입력 이벤트는 무시하도록 다음 틱부터 감지
            setTimeout(() => inputEvents.forEach(t => window.addEventListener(t, onInput, opts)), 0);
            try {
                let lo = null;          // 목표가 이보다 아래였던 scrollTop
                let hi = null;          // 목표가 이보다 위였던 scrollTop
                let lastHeight = -1;
                let aligns = 0;
                let edgeWaits = 0;
                let smoothUsed = false;

                while (valid() && performance.now() < deadline) {
                    this.refreshNow();
                    const container = this.container;
                    if (!container) return false;
                    const cur = W.dom.scrollTop(container);
                    const view = W.dom.viewHeight(container);
                    const maxTop = W.dom.maxScrollTop(container);
                    const it = this.items.get(id);

                    // 1) 화면에 있음: 질문 윗변을 여백 위치에 맞춘다. 주변이 다시 그려지며 밀릴 수 있어 안정될 때까지 반복.
                    if (it && it.live && it.turnEl && it.turnEl.isConnected) {
                        const want = Math.min(Math.max(0, W.dom.positionIn(it.turnEl, container) - site.scrollOffset), maxTop);
                        if (Math.abs(want - cur) <= 4 || aligns >= 4) {
                            this.flash(it.bubbleEl || it.turnEl);
                            this.log('nav done', { id, aligns });
                            return true;
                        }
                        aligns++;
                        const smooth = !smoothUsed && Math.abs(want - cur) < view * 1.5;
                        smoothUsed = true;
                        this.scrollContainerTo(container, want, smooth ? 'smooth' : 'auto');
                        if (smooth) await W.dom.waitForScrollEnd(container);
                        await this.waitForTurns(container, 800);
                        continue;
                    }

                    // 2) 화면에 없음: 렌더된 질문들과 비교해 방향을 정하고 그쪽으로 이동
                    const { ordered } = this.layout;
                    const idx = ordered.findIndex(o => o.id === id);
                    if (idx < 0) return false;
                    const liveIdx = [];
                    ordered.forEach((o, i) => { if (o.live) liveIdx.push(i); });
                    let dir = 0;
                    if (liveIdx.length > 0) {
                        if (ordered[idx].weightStart === null && this.layout.ordered.some(o => o.weightStart !== null) &&
                            it && it.pos !== null && it.pos !== undefined) {
                            // 대화 데이터에 없는 질문은 목록 끝에 붙어 있어 순서로는 방향을 모른다 → 기억된 위치로 판단
                            const livePos = liveIdx.map(i => this.items.get(ordered[i].id).pos);
                            if (it.pos < Math.min(...livePos)) dir = -1;
                            else if (it.pos > Math.max(...livePos)) dir = 1;
                        } else if (idx < liveIdx[0]) dir = -1;
                        else if (idx > liveIdx[liveIdx.length - 1]) dir = 1;
                    }

                    // 위쪽 내용이 새로 불러와져 높이가 바뀌면 이전 범위는 의미가 없다
                    const height = container.scrollHeight;
                    if (lastHeight >= 0 && Math.abs(height - lastHeight) > view * 0.25) { lo = null; hi = null; }
                    lastHeight = height;
                    if (dir > 0) lo = lo === null ? cur : Math.max(lo, cur);
                    if (dir < 0) hi = hi === null ? cur : Math.min(hi, cur);
                    // 내용이 밀려 범위가 뒤집혔으면(아래 경계가 위 경계보다 아래) 새로 시작
                    if (lo !== null && hi !== null && hi <= lo) {
                        lo = dir > 0 ? cur : null;
                        hi = dir < 0 ? cur : null;
                    }

                    // 맨 위/맨 아래에 이미 닿았는데 목표가 그 너머에 있는 경우
                    if (dir < 0 && cur <= 2) {
                        // 첫 질문까지 이미 불러왔으면 더 불러올 것이 없다 (없어진 갈래의 질문 등)
                        if (!site.loadsOlderOnTop || this.sawFirstQuestion || edgeWaits >= 8) break;
                        edgeWaits++;
                        const result = await this.waitForOlder(container, valid);
                        if (result === 'failed') {
                            this.showToast(MSG('loadOlderFailed'));
                            return false;
                        }
                        if (result === 'none') break;
                        // 예전 대화가 계속 불러와지는 동안은 시간 제한을 늘려준다 (아주 긴 대화)
                        deadline = Math.min(navStart + 45000, Math.max(deadline, performance.now() + 5000));
                        continue;
                    }
                    if (dir > 0 && cur >= maxTop - 2) break;

                    const estimate = this.estimatePixel(idx, container);
                    const target = W.layout.nextScrollTarget({
                        dir,
                        estimate: estimate === null ? null : estimate - site.scrollOffset,
                        current: cur, view, maxTop, lo, hi
                    });
                    this.log('nav step', { id, dir, cur: Math.round(cur), target: Math.round(target), lo, hi });
                    if (Math.abs(target - cur) < 2) {
                        if (dir === 0) break;
                        // 범위가 다 좁혀졌는데도 안 보이면 렌더를 한 번 더 기다려 본다
                        await this.waitForTurns(container, 600);
                        if (lo !== null && hi !== null && hi - lo < 4) break;
                        continue;
                    }
                    this.scrollContainerTo(container, target, 'auto');
                    await this.waitForTurns(container, 1000);
                }
                this.log('nav give-up', { id });
                return false;
            } finally {
                setTimeout(() => inputEvents.forEach(t => window.removeEventListener(t, onInput, opts)), 0);
            }
        }

        // 맨 위에서 사이트가 예전 대화를 불러올 때까지 기다린다. 'loaded' | 'failed' | 'none'
        async waitForOlder(container, valid) {
            const sigOf = () => {
                const first = container.querySelector(site.turnSelector);
                return `${container.scrollHeight}|${first ? (first.getAttribute('data-turn-key') || first.id || first.textContent.slice(0, 40)) : ''}`;
            };
            const before = sigOf();
            // 사이트가 "맨 위에 닿음"을 알아채도록 휠 신호와 함께 다시 맨 위로
            this.scrollContainerTo(container, 0, 'auto');
            const start = performance.now();
            while (performance.now() - start < 6000) {
                await W.dom.sleep(120);
                if (!valid()) return 'none';
                if (site.loadFailed(container)) return 'failed';
                if (sigOf() !== before) {
                    await this.waitForTurns(container, 1000);
                    return 'loaded';
                }
            }
            return site.loadFailed(container) ? 'failed' : 'none';
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
            // 전체 목록(대화 데이터)이 있을 때만 "이번 대화는 끝"으로 표시. 화면에서 읽은 일부뿐이면 계속 시도
            if (this.apiList) this.migratedConv = this.convKey;
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
            clearTimeout(this.apiTimer);
            clearTimeout(this.apiRefetchTimer);
            clearTimeout(this.tooltipHideTimer);
            clearTimeout(this.toastTimer);
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
            if (this.toast) this.toast.remove();
            document.querySelectorAll('.witq-star').forEach(el => el.remove());
            if (window.__witq === this) delete window.__witq;
        }
    }

    const start = () => new Controller();
    if (document.body) start();
    else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
