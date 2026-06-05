class MarkerManager {
    constructor() {
        this.debounceTimeout = null;
        this.updateRafId = null;
        this.pendingForceUpdate = false;
        this.isUpdating = false;
        this.pendingUpdateAfterRun = false;
        this.minUpdateInterval = 180;
        this.lastUpdateTime = 0;
        this.favorites = [];
        this.site = window.WITQ.config.site;
        this.config = window.WITQ.config.config;
        this.scrollbarContainer = null;
        this.observer = null;
        this.observerTarget = null;
        this.observerRetryTimer = null;
        this.observerRetryCount = 0;
        // ID 기반 마커 맵: id -> { marker, element|null, position, text, isQuestion }
        this.markers = new Map();
        this.questionDataCache = new WeakMap(); // DOM 요소 -> 파싱된 데이터 캐시
        this.lastUrl = location.href;
        this.warmupTimers = [];

        // 스캔 상태 추적
        this.isScanning = false;
        this.scannedKeys = new Set(); // 이미 스캔 완료된 대화 키

        // 리사이즈 재측정용: 마지막 뷰포트 크기 + 디바운스 타이머
        this.lastViewport = { w: window.innerWidth, h: window.innerHeight };
        this.resizeDebounceTimer = null;

        // 디버그 로그 토글 (사용자 재현 시 수동으로 true)
        this.debug = false;

        // 내비게이션 연타 가드: 새 클릭이 이전 이동을 취소하기 위한 토큰
        this.navToken = 0;

        // 고아 인스턴스 방지: 새 스크립트가 teardown 이벤트를 쏘면 이전 인스턴스 정리.
        // 이 인스턴스도 이후 teardown을 수신하면 스스로 정리한다.
        this.destroyed = false;
        window.dispatchEvent(new Event('witq:teardown'));
        window.addEventListener('witq:teardown', () => this.destroy(), { once: true });

        this.initialize();
    }

    async initialize() {
        // 디버그 플래그 영속화: 자동 스캔/첫 갱신 전에 먼저 반영
        try {
            const r = await chrome.storage.local.get('witqDebug');
            if (r && r.witqDebug) this.debug = true;
        } catch (e) {}

        try {
            this.favorites = await window.WITQ.storage.getFavorites();
            this.scheduleUpdate(true, 0);
            this.scheduleWarmupUpdates();
        } catch (e) {}

        this.setupEventListeners();
        this.startObserver();
    }

    destroy() {
        this.destroyed = true;
        if (this.observer) this.observer.disconnect();
        clearTimeout(this.debounceTimeout);
        clearTimeout(this.observerRetryTimer);
        clearTimeout(this.resizeDebounceTimer);
        this.cancelWarmupUpdates();
        if (this.updateRafId !== null) {
            cancelAnimationFrame(this.updateRafId);
            this.updateRafId = null;
        }
    }

    // --- Marker Management ---

    getQuestions() {
        return this.config.getQuestionElements();
    }

    getQuestionWrapper(questionEl) {
        if (!questionEl) return null;
        if (this.site === 'gemini') {
            return questionEl.closest('.user-query-container') ||
                   questionEl.closest('.query-with-attachments-container') ||
                   questionEl.closest('.user-query') ||
                   questionEl;
        }
        if (this.site === 'chatgpt') {
            return questionEl.closest('[data-testid^="conversation-turn"]') || questionEl;
        }
        if (this.site === 'claude') {
            // 각 메시지를 감싸는 렌더 래퍼 (없으면 질문 요소 자체)
            return questionEl.closest('[data-test-render-count]') || questionEl;
        }
        if (this.site === 'grok') {
            return questionEl.closest('div[id^="response-"]') || questionEl;
        }
        return questionEl;
    }

    // 질문 요소의 식별용 플레인 텍스트.
    // 텍스트가 전혀 없는 질문(이미지만 첨부)은 innerText가 빈 문자열이라
    // 마커 생성에서 누락되므로 '이미지 첨부' 대체 식별자를 사용한다.
    // 이미지만 있는 질문이 여러 개면 generateQuestionId의 occurrence 접미사가 구분한다.
    getPlainIdentity(question) {
        const plain = (question.innerText || question.textContent || '').trim();
        if (plain) return plain;
        const scope = this.getQuestionWrapper(question) || question;
        if (scope.querySelector('img')) return '이미지 첨부';
        return '';
    }

    buildStructuredTextFromPlain(plain) {
        if (!plain) return '';
        // 아이콘 노이즈 제거 후 you said 제거, 공백 정리, HTML 이스케이프
        const withoutIcons = String(plain)
            .replace(/\[[^\]]*icon[^\]]*\]/ig, ' ')
            .replace(/\([^\)]*icon[^\)]*\)/ig, ' ')
            .trim();
        const cleaned = window.WITQ.text.stripYouSaid(withoutIcons).replace(/\s+/g, ' ').trim();
        return window.WITQ.text.escapeHtml(cleaned);
    }

    scheduleWarmupUpdates() {
        this.cancelWarmupUpdates();
        [180, 900, 2000, 4000].forEach(delay => {
            const timerId = setTimeout(() => this.scheduleUpdate(true, 0), delay);
            this.warmupTimers.push(timerId);
        });
    }

    cancelWarmupUpdates() {
        this.warmupTimers.forEach(timerId => clearTimeout(timerId));
        this.warmupTimers = [];
    }

    scheduleUpdate(force = false, delay = 0) {
        if (this.destroyed) return;
        this.pendingForceUpdate = this.pendingForceUpdate || force;
        clearTimeout(this.debounceTimeout);
        this.debounceTimeout = setTimeout(() => {
            if (this.updateRafId !== null) return;
            this.updateRafId = requestAnimationFrame(() => {
                this.updateRafId = null;
                const elapsed = Date.now() - this.lastUpdateTime;
                if (elapsed < this.minUpdateInterval) {
                    this.scheduleUpdate(this.pendingForceUpdate, this.minUpdateInterval - elapsed);
                    return;
                }
                const forceNow = this.pendingForceUpdate;
                this.pendingForceUpdate = false;
                this.lastUpdateTime = Date.now();
                this.updateMarkers(forceNow);
            });
        }, delay);
    }

    async updateMarkers(force = false) {
        if (this.destroyed) return;
        if (this.isUpdating) {
            this.pendingUpdateAfterRun = this.pendingUpdateAfterRun || force;
            return;
        }
        this.isUpdating = true;
        try {
            // URL 변경 감지 (SPA 대화 전환). 스캔 중이라도 잔존 마커를 즉시 비우기 위해
            // isScanning 가드보다 먼저 처리한다.
            if (this.lastUrl !== location.href) {
                this.lastUrl = location.href;
                this.resetMarkers();
                // 대화 진입 시마다 재스캔 허용: 캐시는 유지(마커 즉시 표시)하되
                // 스캔 완료 표식을 지워 긴 페이지면 자동 스캔이 다시 돌게 한다.
                this.scannedKeys.delete(window.WITQ.storage.getConversationKey());
                this.scheduleWarmupUpdates();
                this.startObserver();
            }

            // 스캔 중에는 마커 갱신 억제(렌더 churn 방지). 스캔 완료 후 scheduleUpdate(true,0)가
            // 전체 갱신을 하며, 그 setTimeout+rAF 콜백은 finally의 isScanning=false 뒤에 실행되므로 유실 없음.
            if (this.isScanning) return;

            const liveDomQuestions = this.getQuestions();

            this.ensureScrollbarContainer();

            const container = window.WITQ.dom.getScrollContainer();
            const totalHeight = (container === window)
                ? Math.max(document.documentElement.scrollHeight, window.innerHeight, 1)
                : Math.max(container.scrollHeight, container.clientHeight, 1);

            const convKey = window.WITQ.storage.getConversationKey();
            const cacheEntry = window.WITQ.storage.getScanCache(convKey);
            const cached = cacheEntry ? cacheEntry.questions : [];
            const scanHeight = cacheEntry ? cacheEntry.scanHeight : 0;
            // 마커 % 분모: 스캔 좌표계와 현재 높이 중 큰 값. 재진입 시 현재 높이가 작아도
            // scanHeight로 고정돼 마커가 흔들리지 않고, 새 질문으로 더 커지면 현재 높이를 따른다.
            const effHeight = Math.max(scanHeight, totalHeight);

            // 캐시 엔트리를 id 기반 Map으로 변환 (O(1) 조회용)
            const cachedById = new Map();
            for (const entry of cached) {
                cachedById.set(entry.id, entry);
            }

            // 라이브 측정값으로 캐시 position을 덮어쓸지 여부: 현재 높이가 스캔 좌표계와
            // 충분히 일치할 때만 허용 (축소된 가상화 상태에서 캐시 오염 방지)
            const allowCacheOverwrite = !scanHeight ||
                Math.abs(totalHeight - scanHeight) / scanHeight < 0.1;

            // 현재 DOM에 있는 질문의 id 기반 데이터 맵
            const liveById = new Map();
            liveDomQuestions.forEach((question, index) => {
                const data = this.getOrUpdateQuestionData(question, container, index, liveDomQuestions);
                if (!data || !data.text) return;
                liveById.set(data.id, { ...data, element: question });
                // 캐시 position 갱신 (좌표계가 일치할 때만 — 라이브 측정값이 더 정확)
                if (allowCacheOverwrite && cachedById.has(data.id)) {
                    cachedById.get(data.id).position = data.position;
                }
            });

            // 합집합 구성: 캐시 + 라이브. 좌표계 불일치 시 표시 position은 캐시(스캔 좌표계)를 유지
            const unionById = new Map(cachedById);
            for (const [id, liveEntry] of liveById) {
                const cachedEntry = cachedById.get(id);
                if (cachedEntry && !allowCacheOverwrite) {
                    unionById.set(id, { ...liveEntry, position: cachedEntry.position });
                } else {
                    unionById.set(id, liveEntry);
                }
            }

            if (this.debug) console.log('[WITQ] update', { live: liveDomQuestions.length, cached: cached.length, union: unionById.size, container: container === window ? 'window' : 'element', totalHeight, scanHeight, effHeight });

            if (unionById.size === 0) {
                if (this.markers.size === 0) {
                    this.scrollbarContainer.style.display = 'none';
                }
                this.scrollbarContainer.innerHTML = '';
                window.WITQ.storage.safeSendQuestionList([]);
                this.markers.clear();
                return;
            }

            this.scrollbarContainer.style.display = 'block';
            if (this.warmupTimers.length > 0) this.cancelWarmupUpdates();

            // 1. 더 이상 합집합에 없는 마커 제거
            for (const [id, entry] of this.markers.entries()) {
                if (!unionById.has(id)) {
                    entry.marker.remove();
                    // 라이브 요소가 있을 때만 별표 제거
                    if (entry.element && document.body.contains(entry.element)) {
                        const wrapper = this.getQuestionWrapper(entry.element);
                        const star = wrapper ? wrapper.querySelector('.witq-favorite-star') : null;
                        if (star) star.remove();
                    }
                    this.markers.delete(id);
                }
            }

            // 2. 마커 추가/갱신
            const questionsForPopup = [];
            // position 오름차순으로 처리 (팝업용 목록 순서 보장)
            const sortedEntries = Array.from(unionById.values())
                .sort((a, b) => a.position - b.position);

            for (const entryData of sortedEntries) {
                const id = entryData.id;
                const liveEl = liveById.has(id) ? liveById.get(id).element : null;

                let existing = this.markers.get(id);
                if (!existing) {
                    const marker = this.createMarkerElement(id, liveEl, entryData, effHeight);
                    this.scrollbarContainer.appendChild(marker);
                    existing = { marker, element: liveEl, position: entryData.position, text: entryData.text, isQuestion: entryData.isQuestion };
                    this.markers.set(id, existing);
                } else {
                    // 라이브 요소 레퍼런스 갱신
                    existing.element = liveEl;
                    existing.position = entryData.position;
                    existing.text = entryData.text;
                    existing.isQuestion = entryData.isQuestion;
                    this.updateMarkerElement(existing.marker, liveEl, entryData, effHeight);
                }

                questionsForPopup.push({
                    id,
                    text: entryData.text,
                    position: entryData.position,
                    isQuestion: entryData.isQuestion
                });
            }

            // 방어적 청소: this.markers에 속하지 않은 잔존 자식 요소 제거
            const known = new Set(Array.from(this.markers.values(), e => e.marker));
            for (const child of Array.from(this.scrollbarContainer.children)) {
                if (!known.has(child)) child.remove();
            }

            // 팝업에 전체 목록 전송 (캐시 포함)
            window.WITQ.storage.safeSendQuestionList(questionsForPopup);

            // 긴 페이지에서 처음 마커가 그려진 뒤, 해당 대화를 아직 스캔하지 않았다면 자동 스캔
            const viewportHeight = (container === window) ? window.innerHeight : container.clientHeight;
            const isLongPage = totalHeight > viewportHeight * 3;
            if (isLongPage && !this.scannedKeys.has(convKey) && !this.isScanning) {
                this.scanAllQuestions();
            }
        } catch (error) {
            // 마커 업데이트 실패 (무음 처리)
        } finally {
            this.isUpdating = false;
            if (this.pendingUpdateAfterRun) {
                const nextForce = this.pendingUpdateAfterRun;
                this.pendingUpdateAfterRun = false;
                this.scheduleUpdate(nextForce, 120);
            }
        }
    }

    resetMarkers() {
        if (this.scrollbarContainer) {
            this.scrollbarContainer.innerHTML = '';
            this.scrollbarContainer.style.display = 'none';
        }
        this.markers.clear();
        this.observerRetryCount = 0;
        window.WITQ.storage.safeSendQuestionList([]);
    }

    ensureScrollbarContainer() {
        if (!this.scrollbarContainer) {
            this.scrollbarContainer = document.getElementById('question-scrollbar-container');
            if (!this.scrollbarContainer) {
                this.scrollbarContainer = document.createElement('div');
                this.scrollbarContainer.id = 'question-scrollbar-container';
                document.body.appendChild(this.scrollbarContainer);
            }
        }
    }

    getOrUpdateQuestionData(question, container, index, allQuestions = null) {
        let cached = this.questionDataCache.get(question);
        const currentPos = window.WITQ.dom.getQuestionPositionInContainer(question, container);

        if (!cached || Math.abs(cached.position - currentPos) > 1 || cached.index !== index) {
            const plainFallback = this.getPlainIdentity(question);
            if (!plainFallback) return null;
            const fastText = this.buildStructuredTextFromPlain(plainFallback);

            cached = {
                text: fastText,
                detailedText: null,
                position: currentPos,
                index,
                id: this.generateQuestionId(question, plainFallback, allQuestions || this.getQuestions()),
                isQuestion: window.WITQ.config.isQuestion(plainFallback)
            };
            this.questionDataCache.set(question, cached);
        }
        return cached;
    }

    ensureDetailedQuestionText(question, data) {
        if (!data || data.detailedText) return data;
        let detailed = this.config.getQuestionText(question);
        const hasRenderableText = !!(detailed && detailed.replace(/<[^>]+>/g, '').trim());
        if (!hasRenderableText) {
            const plainFallback = this.getPlainIdentity(question);
            if (plainFallback) {
                detailed = this.buildStructuredTextFromPlain(plainFallback);
            } else {
                return data;
            }
        }
        data.detailedText = detailed;
        return data;
    }

    formatTooltipHtml(raw) {
        if (!raw) return '';
        let html = String(raw);
        html = html.replace(/&lt;br\s*\/?&gt;/ig, '<br>');
        html = html.replace(/<\/div>\s*<div>/ig, '<br>');
        html = html.replace(/^<div>/i, '').replace(/<\/div>$/i, '');

        // 접근성/아이콘 노이즈 제거
        html = html
            .replace(/\[[^\]]*icon[^\]]*\]\s*/ig, '')
            .replace(/\([^\)]*icon[^\)]*\)\s*/ig, '')
            .replace(/\byou\s*said\b\s*:?\s*/ig, ' ')
            .trim();

        return html;
    }

    generateQuestionId(question, plainText, allQuestions) {
        const normalized = window.WITQ.text.normalizePlainText(plainText);
        const hash = window.WITQ.text.hashString(normalized);
        let occurrence = 0;
        for (const q of allQuestions) {
            if (q === question) break;
            const qPlain = this.getPlainIdentity(q);
            if (window.WITQ.text.normalizePlainText(qPlain) === normalized) occurrence++;
        }
        return occurrence === 0 ? hash : `${hash}-${occurrence}`;
    }

    // --- 스캔 기능 ---

    // minWaitMs를 무조건 먼저 대기(사이트가 스크롤에 반응해 렌더 시작할 시간 확보)한 뒤,
    // DOM 변경이 quietMs 동안 없거나 timeoutMs 초과 시 resolve. mutation을 본 적이 있는지(sawMutation) 반환.
    async waitForDomSettle(target, quietMs = 200, timeoutMs = 1500, minWaitMs = 150) {
        // 1. 스크롤 반응 렌더가 시작될 시간 확보
        await new Promise(r => setTimeout(r, minWaitMs));

        // 2. quiet 감지
        return new Promise((resolve) => {
            let quietTimer = null;
            let sawMutation = false;
            const observerTarget = (target === window) ? document.body : target;

            const finish = () => {
                observer.disconnect();
                clearTimeout(quietTimer);
                clearTimeout(hardTimer);
                resolve(sawMutation);
            };

            const reset = () => {
                sawMutation = true;
                clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, quietMs);
            };

            const observer = new MutationObserver(reset);
            observer.observe(observerTarget, { childList: true, subtree: true });

            // 초기 quiet 타이머 시작
            quietTimer = setTimeout(finish, quietMs);
            // 하드 타임아웃
            const hardTimer = setTimeout(finish, timeoutMs);
        });
    }

    // 스캔 진행 중 표시 배지 표시/제거
    _showScanIndicator() {
        let el = document.getElementById('witq-scan-indicator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'witq-scan-indicator';
            el.textContent = '스캔 중...';
            document.body.appendChild(el);
        }
    }

    _hideScanIndicator() {
        const el = document.getElementById('witq-scan-indicator');
        if (el) el.remove();
    }

    // 전체 대화 스캔: DOM 가상화 대응을 위해 스크롤을 내려가며 모든 질문 위치 수집
    async scanAllQuestions() {
        if (this.isScanning) return;

        const convKey = window.WITQ.storage.getConversationKey();
        if (this.scannedKeys.has(convKey)) return;

        this.isScanning = true;
        this._showScanIndicator();

        const container = window.WITQ.dom.getScrollContainer();
        const isWindow = container === window;

        // 현재 스크롤 위치 저장
        const originalScrollTop = isWindow ? window.scrollY : container.scrollTop;

        // 스크롤 헬퍼는 finally에서도 복원에 사용하므로 try 밖 함수 스코프에 둔다
        const getScrollHeight = () => isWindow
            ? document.documentElement.scrollHeight
            : container.scrollHeight;
        const getClientHeight = () => isWindow
            ? window.innerHeight
            : container.clientHeight;
        const setScrollTop = (val) => {
            if (isWindow) window.scrollTo(0, val);
            else container.scrollTop = val;
        };

        // 스캔 중 수집된 질문 데이터 (id -> 최신 측정값)
        const collected = new Map();
        const scanStart = Date.now();
        // 대화 전환/teardown으로 중단된 경우: 다른 대화에 이전 스크롤 복원 금지
        let abortedByNav = false;

        try {
            let currentScroll = 0;
            // 연속 무변경 스텝 카운터: DOM mutation이 없는 스텝이 이어질수록 전진 폭 확대
            let quietStreak = 0;

            if (this.debug) {
                console.log('[WITQ] scan start', { convKey, totalHeight: getScrollHeight() });
            }

            // 최상단부터 시작
            setScrollTop(0);
            await this.waitForDomSettle(container, 200, 1500, 150);

            while (true) {
                // 대화 전환/teardown 감지: 스캔 중단 (정리는 finally가 처리)
                if (this.destroyed || window.WITQ.storage.getConversationKey() !== convKey) {
                    abortedByNav = true;
                    return;
                }

                const questions = this.getQuestions();
                const allQuestionsSnapshot = questions; // ID 계산에 사용

                let stepCount = 0;
                let maxSeenTop = 0; // 이번 스텝에서 본 질문들의 최대 position (적응형 스텝용)
                for (const el of questions) {
                    const plain = this.getPlainIdentity(el);
                    if (!plain) continue;

                    const id = this.generateQuestionId(el, plain, allQuestionsSnapshot);
                    const position = window.WITQ.dom.getQuestionPositionInContainer(el, container);
                    const text = this.buildStructuredTextFromPlain(plain);
                    const isQuestion = window.WITQ.config.isQuestion(plain);

                    // 이미 본 ID는 위치 값을 최신으로 덮어씀 (더 정확한 측정값)
                    collected.set(id, { id, text, position, isQuestion });
                    stepCount++;
                    if (position > maxSeenTop) maxSeenTop = position;
                }

                if (this.debug) {
                    console.log('[WITQ] scan step', { currentScroll, stepCount, total: collected.size, quietStreak });
                }

                const scrollHeight = getScrollHeight();
                const clientHeight = getClientHeight();

                // 하단 도달 판별
                if (currentScroll + clientHeight >= scrollHeight - 1) break;

                // 적응형 스텝: quietStreak에 따라 최소 전진 계수를 0.8~2.4로 확대.
                // 조용한 구간 = 이미 렌더된 영역 통과 중이므로 빠르게 전진해도 질문을 놓치지 않는다.
                // windowNext에 전진 상한(2.5뷰포트)을 둬서, 반대편 끝에 잔존한 렌더 창으로 인해
                // maxSeenTop이 오판될 때 한 번에 멀리 점프해 중간 질문을 건너뛰는 폭주를 방지한다.
                // max(minNext, windowNext)이므로 항상 minNext 이상 → 단조 증가 보장. 하단으로 clamp.
                const stepFactor = Math.min(0.8 + 0.4 * quietStreak, 2.4);
                const minNext = currentScroll + clientHeight * stepFactor;
                const windowNext = Math.min(maxSeenTop - clientHeight * 0.5, currentScroll + clientHeight * 2.5);
                currentScroll = Math.min(Math.max(minNext, windowNext), scrollHeight - clientHeight);

                setScrollTop(currentScroll);
                const sawMutation = await this.waitForDomSettle(container, 200, 1500, 150);
                if (sawMutation) {
                    // mutation 감지: 새 렌더가 시작됐으므로 연속 무변경 카운터 리셋
                    quietStreak = 0;
                } else if (quietStreak === 0) {
                    // 첫 번째 무변경 스텝: 늦은 렌더 대비로 1회만 추가 대기
                    const sawMutation2 = await this.waitForDomSettle(container, 200, 1000, 150);
                    quietStreak = sawMutation2 ? 0 : 1;
                } else {
                    // 연속 무변경 구간: 추가 대기 생략하고 카운터 증가
                    quietStreak++;
                }
            }

            // 대화 전환/teardown 최종 확인 (정리는 finally가 처리)
            if (this.destroyed || window.WITQ.storage.getConversationKey() !== convKey) {
                abortedByNav = true;
                return;
            }

            // 스캔 완료 시점의 전체 높이 캡처 (마커 % 좌표계 기준). 복원 전에 측정한다.
            const scanHeight = getScrollHeight();

            // 위치 오름차순 정렬 후 캐시 저장 (좌표계 기준 scanHeight 동봉)
            const sortedList = Array.from(collected.values())
                .sort((a, b) => a.position - b.position);
            window.WITQ.storage.setScanCache(convKey, { questions: sortedList, scanHeight });
            this.scannedKeys.add(convKey);

            if (this.debug) {
                console.log('[WITQ] scan done', { questions: sortedList.length, scanHeight, ms: Date.now() - scanStart });
            }

            // 마커 즉시 갱신
            this.scheduleUpdate(true, 0);
        } catch (e) {
            // 영구적 에러 시 세션당 대화별 1회만 시도하도록 스캔 완료로 표시
            this.scannedKeys.add(convKey);
        } finally {
            // 중단된 경우 다른 대화/제거된 인스턴스에 이전 스크롤을 복원하지 않는다
            if (!abortedByNav) setScrollTop(originalScrollTop);
            this._hideScanIndicator();
            this.isScanning = false;
            // 대화 전환으로 중단됐다면 새 페이지 마커 생성을 보장
            if (abortedByNav) this.scheduleUpdate(true, 0);
        }
    }

    // 마커 클릭 시 이동: 긴 페이지는 즉시 점프(auto)로 통일,
    // 짧은 페이지는 기존 smooth 유지.
    // 사용자 입력(wheel/touchstart/keydown) 감지 시 대기/재점프를 즉시 중단.
    async navigateToQuestion(id) {
        const entry = this.markers.get(id);
        if (!entry) return;

        // 연타 가드: 새 클릭이 이전 이동을 취소
        const token = ++this.navToken;

        // 사용자 스크롤/입력 감지 → 대기 후 모든 재시도 중단
        let userInterrupted = false;
        const onUserInput = () => { userInterrupted = true; };
        window.addEventListener('wheel', onUserInput, { passive: true, capture: true });
        window.addEventListener('touchstart', onUserInput, { passive: true, capture: true });
        window.addEventListener('keydown', onUserInput, { passive: true, capture: true });

        try {
            const container = window.WITQ.dom.getScrollContainer();
            const isWindow = container === window;
            const viewport = isWindow ? window.innerHeight : container.clientHeight;
            const convKey = window.WITQ.storage.getConversationKey();
            const cacheEntry = window.WITQ.storage.getScanCache(convKey);
            const scanHeight = cacheEntry ? cacheEntry.scanHeight : 0;

            // 스캔 캐시에서 스케일링 기준 position을 직접 읽어 좌표계 오염 방지.
            // 캐시에 해당 id 항목이 없으면 entry.position으로 폴백.
            let basePosition = entry.position;
            if (cacheEntry && cacheEntry.questions) {
                const cacheQuestion = cacheEntry.questions.find(q => q.id === id);
                if (cacheQuestion) basePosition = cacheQuestion.position;
            }

            // id의 해시부 (순번 접미사 제거): 매칭에 사용
            const expectedHash = String(id).split('-')[0];

            // 스캔 캐시가 있거나 현재 높이가 충분히 길면 긴 페이지로 간주 → 즉시 점프
            const currentHeightNow = isWindow ? document.documentElement.scrollHeight : container.scrollHeight;
            const isLong = !!cacheEntry || currentHeightNow > viewport * 3;
            const behavior = isLong ? 'auto' : 'smooth';

            // 케이스 1: 이미 렌더된 요소면 실제 위치 재측정 후 이동.
            // stale 요소 검증: 요소 텍스트 해시가 id 해시부와 일치해야 신뢰.
            if (entry.element && document.body.contains(entry.element)) {
                const elPlain = this.getPlainIdentity(entry.element);
                const elHash = elPlain
                    ? String(window.WITQ.text.hashString(window.WITQ.text.normalizePlainText(elPlain)))
                    : null;
                if (elHash && elHash === expectedHash) {
                    if (this.debug) console.log('[WITQ] nav', { id, case: 1, basePosition, scanHeight, liveHeight: isWindow ? document.documentElement.scrollHeight : container.scrollHeight });
                    const pos = window.WITQ.dom.getQuestionPositionInContainer(entry.element, container);
                    entry.position = pos;
                    // 케이스 1 최초 이동: 클릭 직접 응답이므로 중단 체크 없이 수행
                    window.WITQ.dom.scrollToQuestionPosition(pos, container, behavior);
                    return;
                }
                // 해시 불일치: stale 요소로 간주하고 케이스 2로 진행
            }

            // 케이스 2: 캐시만 있음 — 앵커 기반 추정 위치로 점프 후 렌더 대기/탐색.
            // 앵커: 현재 마운트된 질문 중 캐시에서 유일 해시로 식별 가능한 항목.
            // jumpPos = 앵커 라이브 위치 + (basePosition - 앵커 캐시 위치).
            // 앵커 없으면 비례 스케일링 폴백.

            // 캐시 해시 맵 사전 구성: 해시부 → {position, count}.
            // count > 1인 해시는 중복 텍스트라 앵커로 불가.
            const cacheHashMap = new Map();
            if (cacheEntry && cacheEntry.questions) {
                for (const q of cacheEntry.questions) {
                    const h = String(q.id).split('-')[0];
                    const existing = cacheHashMap.get(h);
                    if (existing) {
                        existing.count++;
                    } else {
                        cacheHashMap.set(h, { position: q.position, count: 1 });
                    }
                }
            }

            // 현재 liveHeight를 재측정해 반환하는 헬퍼
            const getLiveHeight = () => isWindow ? document.documentElement.scrollHeight : container.scrollHeight;

            // 앵커 없을 때 쓰는 비례 스케일링 폴백
            const fallbackJumpPos = () => {
                const liveHeight = getLiveHeight();
                return scanHeight ? basePosition * (liveHeight / scanHeight) : basePosition;
            };

            if (this.debug) console.log('[WITQ] nav', { id, case: 2, basePosition, scanHeight, liveHeight: getLiveHeight() });

            // 최초 점프: 초기 렌더 목록으로 앵커를 탐색하고 앵커 기반 jumpPos 계산,
            // 앵커 없으면 폴백 스케일링으로 1회 점프.
            const initialQuestions = this.getQuestions();
            let initialAnchors = [];
            for (const el of initialQuestions) {
                const plain = this.getPlainIdentity(el);
                if (!plain) continue;
                const h = String(window.WITQ.text.hashString(window.WITQ.text.normalizePlainText(plain)));
                const cached = cacheHashMap.get(h);
                if (cached && cached.count === 1 && h !== expectedHash) {
                    initialAnchors.push({ el, cachePos: cached.position });
                }
            }

            let jumpPos;
            if (initialAnchors.length > 0) {
                // basePosition에 가장 가까운 앵커를 선택해 초기 jumpPos 계산
                let best = initialAnchors[0];
                let bestDist = Math.abs(best.cachePos - basePosition);
                for (let i = 1; i < initialAnchors.length; i++) {
                    const d = Math.abs(initialAnchors[i].cachePos - basePosition);
                    if (d < bestDist) { bestDist = d; best = initialAnchors[i]; }
                }
                const anchorLivePos = window.WITQ.dom.getQuestionPositionInContainer(best.el, container);
                jumpPos = Math.max(anchorLivePos + (basePosition - best.cachePos), 0);
            } else {
                jumpPos = fallbackJumpPos();
            }
            // 케이스 2 최초 점프: 클릭 직접 응답이므로 중단 체크 없이 수행
            window.WITQ.dom.scrollToQuestionPosition(jumpPos, container, 'auto');

            const maxAttempts = 3;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const sawMutation = await this.waitForDomSettle(container, 150, 800, 120);
                // 늦은 렌더 대비: mutation을 못 봤으면 이 시도에서 1회만 추가 대기
                if (!sawMutation) {
                    await this.waitForDomSettle(container, 150, 600, 120);
                }

                // 연타 가드: 새 클릭이 들어왔으면 중단
                if (token !== this.navToken) {
                    if (this.debug) console.log('[WITQ] nav abort', { id, reason: 'superseded' });
                    return;
                }

                // 사용자 입력으로 중단
                if (userInterrupted) {
                    if (this.debug) console.log('[WITQ] nav abort', { id, reason: 'user-input' });
                    return;
                }

                // 대화 전환 감지 시 중단
                if (window.WITQ.storage.getConversationKey() !== convKey) return;

                // sweep 한 번으로 목표 후보와 앵커 후보를 동시 수집
                const questions = this.getQuestions();
                const candidates = []; // 목표 후보 (expectedHash 일치)
                const anchors = [];    // 앵커 후보 (캐시에서 유일 해시, count === 1)
                for (const el of questions) {
                    const plain = this.getPlainIdentity(el);
                    if (!plain) continue;
                    const h = String(window.WITQ.text.hashString(window.WITQ.text.normalizePlainText(plain)));
                    if (h === expectedHash) {
                        candidates.push(el);
                    } else {
                        const cached = cacheHashMap.get(h);
                        if (cached && cached.count === 1) {
                            anchors.push({ el, cachePos: cached.position });
                        }
                    }
                }

                // 앵커 기반 jumpPos 재계산: basePosition에 가장 가까운 앵커 선택
                let selectedAnchorCachePos = null;
                if (anchors.length > 0) {
                    let best = anchors[0];
                    let bestDist = Math.abs(best.cachePos - basePosition);
                    for (let i = 1; i < anchors.length; i++) {
                        const d = Math.abs(anchors[i].cachePos - basePosition);
                        if (d < bestDist) { bestDist = d; best = anchors[i]; }
                    }
                    selectedAnchorCachePos = best.cachePos;
                    const anchorLivePos = window.WITQ.dom.getQuestionPositionInContainer(best.el, container);
                    jumpPos = Math.max(anchorLivePos + (basePosition - best.cachePos), 0);
                } else {
                    // 앵커 없으면 비례 스케일링 폴백
                    jumpPos = fallbackJumpPos();
                }

                // 해시 일치 후보 중 jumpPos에 가장 가까운 요소 선택
                let found = null;
                if (candidates.length === 1) {
                    found = candidates[0];
                } else if (candidates.length > 1) {
                    // 해시 일치 후보가 여러 개: 직전 jumpPos 기준으로 가장 가까운 요소 선택
                    let minDist = Infinity;
                    for (const el of candidates) {
                        const elPos = window.WITQ.dom.getQuestionPositionInContainer(el, container);
                        const dist = Math.abs(elPos - jumpPos);
                        if (dist < minDist) {
                            minDist = dist;
                            found = el;
                        }
                    }
                }

                if (this.debug) console.log('[WITQ] nav attempt', { attempt, jumpPos, anchorCachePos: selectedAnchorCachePos, anchors: anchors.length, liveHeight: getLiveHeight(), found: !!found });

                if (found) {
                    const pos = window.WITQ.dom.getQuestionPositionInContainer(found, container);
                    // 캐시/마커 entry 위치를 실측값으로 갱신 (스케일링 기준은 cacheEntry에서 읽으므로 오염 무해)
                    entry.position = pos;
                    entry.element = found;
                    const cachedData = this.questionDataCache.get(found);
                    if (cachedData) cachedData.position = pos;
                    window.WITQ.dom.scrollToQuestionPosition(pos, container, behavior);
                    return;
                }

                // 못 찾았고 시도 남았으면: 중단 체크 후 앵커 기반(또는 폴백) 갱신 위치로 재점프
                if (attempt < maxAttempts - 1) {
                    // 연타 가드
                    if (token !== this.navToken) {
                        if (this.debug) console.log('[WITQ] nav abort', { id, reason: 'superseded' });
                        return;
                    }
                    // 사용자 입력으로 중단
                    if (userInterrupted) {
                        if (this.debug) console.log('[WITQ] nav abort', { id, reason: 'user-input' });
                        return;
                    }
                    window.WITQ.dom.scrollToQuestionPosition(jumpPos, container, 'auto');
                }
            }
            // 끝까지 못 찾으면 어림 위치에 머문 채 종료 (무음)
            if (this.debug) console.log('[WITQ] nav give-up', { id, lastJumpPos: jumpPos });
        } finally {
            // 모든 종료 경로에서 리스너 해제 보장 (capture 옵션 일치)
            window.removeEventListener('wheel', onUserInput, { capture: true });
            window.removeEventListener('touchstart', onUserInput, { capture: true });
            window.removeEventListener('keydown', onUserInput, { capture: true });
        }
    }

    // --- 마커 DOM 생성/갱신 ---

    // id와 현재 라이브 요소(null 가능), 초기 데이터, effHeight(% 분모)를 받아 마커 DOM 생성
    createMarkerElement(id, initialElement, initialData, effHeight) {
        const marker = document.createElement('div');
        marker.className = 'question-marker';

        const tooltip = document.createElement('div');
        tooltip.className = 'question-marker-tooltip';

        // 첨부 정보 회색 박스 (기본 숨김)
        const attachmentBox = document.createElement('div');
        attachmentBox.className = 'witq-tooltip-attachment';
        attachmentBox.style.display = 'none';

        // 질문 본문 어두운 박스
        const mainBox = document.createElement('div');
        mainBox.className = 'witq-tooltip-main';

        tooltip.appendChild(attachmentBox);
        tooltip.appendChild(mainBox);
        marker.appendChild(tooltip);

        let hideTooltipTimer = null;

        const showTooltip = () => {
            clearTimeout(hideTooltipTimer);
            const entry = this.markers.get(id);
            if (!entry) return;

            // 라이브 요소가 있으면 상세 텍스트 시도
            let displayText = entry.text;
            if (entry.element && document.body.contains(entry.element)) {
                const data = this.questionDataCache.get(entry.element);
                if (data) {
                    this.ensureDetailedQuestionText(entry.element, data);
                    if (data.detailedText) displayText = data.detailedText;
                }
            }

            const html = this.formatTooltipHtml(displayText);
            // 첨부 줄("*... 첨부")은 회색 박스로 분리, 나머지는 본문 박스에
            const attachMatch = html.match(/^\*((?:(?!<br>).)*첨부)(?:<br>|$)/);
            if (attachMatch) {
                attachmentBox.innerHTML = attachMatch[1];
                attachmentBox.style.display = '';
            } else {
                attachmentBox.style.display = 'none';
            }
            const mainHtml = attachMatch ? html.slice(attachMatch[0].length) : html;
            mainBox.innerHTML = mainHtml;
            mainBox.style.display = mainHtml ? '' : 'none';
            tooltip.style.visibility = 'visible';
            tooltip.style.opacity = '0';

            const rect = tooltip.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const topThreshold = 60;

            if (rect.top < topThreshold) {
                tooltip.style.top = '0px';
                tooltip.style.transform = 'translateY(0)';
            } else if (rect.bottom > viewportHeight - 10) {
                tooltip.style.top = 'auto';
                tooltip.style.bottom = '0px';
                tooltip.style.transform = 'translateY(0)';
            } else {
                tooltip.style.top = '50%';
                tooltip.style.bottom = 'auto';
                tooltip.style.transform = 'translateY(-50%)';
            }
            tooltip.style.opacity = '1';
        };

        const hideTooltip = () => {
            hideTooltipTimer = setTimeout(() => {
                tooltip.style.opacity = '0';
                tooltip.style.visibility = 'hidden';
            }, 200);
        };

        marker.addEventListener('mouseenter', showTooltip);
        marker.addEventListener('mouseleave', hideTooltip);
        tooltip.addEventListener('mouseenter', () => clearTimeout(hideTooltipTimer));
        tooltip.addEventListener('mouseleave', hideTooltip);

        marker.addEventListener('click', () => {
            this.navigateToQuestion(id);
        });

        marker.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            const entry = this.markers.get(id);
            if (!entry) return;

            const currentFavorites = await window.WITQ.storage.getFavorites();
            const isFavorite = currentFavorites.some(fav => fav.id === id);
            const updatedFavorites = isFavorite
                ? currentFavorites.filter(fav => fav.id !== id)
                : [...currentFavorites, { id, text: entry.text, position: entry.position }];

            chrome.storage.local.set({ favorites: updatedFavorites });
            this.favorites = updatedFavorites;
            this.scheduleUpdate(true, 60);
        });

        // 초기 위치/상태 설정 (분모는 호출부에서 전달한 effHeight 사용)
        if (initialData) {
            this.updateMarkerElement(marker, initialElement, initialData, effHeight);
        }
        return marker;
    }

    // 별표를 래퍼 내에서 질문 버블 좌측에 맞게 배치한다.
    // append 이후 호출해야 offsetWidth를 올바르게 측정할 수 있다.
    positionFavoriteStar(star, questionWrapper, questionEl) {
        const wRect = questionWrapper.getBoundingClientRect();
        const qRect = questionEl.getBoundingClientRect();
        // offsetWidth가 아직 0이면 font-size 기준 폴백 사용
        const starWidth = star.offsetWidth || 64;
        // 별의 우측 끝이 질문 버블 좌측 가장자리에서 8px 왼쪽에 오도록 배치.
        // 래퍼=질문 요소인 사이트(Perplexity)는 음수가 되어 박스 왼쪽 바깥에 나간다.
        // (0으로 클램프하면 별이 질문 텍스트를 가려서 클램프하지 않음)
        const left = qRect.left - wRect.left - starWidth - 8;
        const top = qRect.top - wRect.top;
        star.style.left = `${left}px`;
        star.style.top = `${top}px`;
    }

    updateMarkerElement(marker, questionEl, data, totalHeight) {
        marker.classList.toggle('is-question', data.isQuestion);

        const isFavorite = this.favorites.some(fav => fav.id === data.id);
        marker.classList.toggle('favorite', isFavorite);

        // 즐겨찾기 별표는 DOM에 있는 요소에만 붙임 (가상화로 unmount된 경우 skip)
        if (questionEl && document.body.contains(questionEl)) {
            const questionWrapper = this.getQuestionWrapper(questionEl);
            const existingStar = questionWrapper ? questionWrapper.querySelector('.witq-favorite-star') : null;

            if (isFavorite) {
                if (questionWrapper) {
                    // 별표는 absolute 포지셔닝: 래퍼가 containing block이 아니면
                    // 먼 조상 기준으로 배치돼 페이지 상단에 겹쳐 쌓인다.
                    // 사이트 DOM 변경으로 CSS 규칙이 빗나가도 인라인으로 보정.
                    if (window.getComputedStyle(questionWrapper).position === 'static') {
                        questionWrapper.style.position = 'relative';
                    }
                    const star = existingStar || (() => {
                        const s = document.createElement('div');
                        s.className = 'witq-favorite-star';
                        s.textContent = '★';
                        questionWrapper.appendChild(s);
                        return s;
                    })();
                    // 새로 추가한 경우도 기존 별도 매번 위치 갱신 (리사이즈/레이아웃 변화 대응)
                    this.positionFavoriteStar(star, questionWrapper, questionEl);
                }
            } else if (existingStar) {
                existingStar.remove();
            }
        }

        const clamped = Math.min(Math.max(data.position, 0), totalHeight);
        marker.style.top = `${(clamped / totalHeight) * 100}%`;
    }

    // --- 이벤트 / 상태 관리 ---

    setupEventListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'scrollToQuestion') {
                // id가 있으면 2단계 이동(가상화 대응), 없으면 단일 스크롤 폴백(하위호환)
                if (message.id) {
                    this.navigateToQuestion(message.id);
                } else {
                    window.WITQ.dom.scrollToQuestionPosition(message.position);
                }
                sendResponse({ status: 'scrolling' });
            } else if (message.type === 'getQuestions') {
                this.scheduleUpdate(true, 0);
                sendResponse({ status: 'processing' });
            }
            return true;
        });

        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && changes.favorites) {
                this.favorites = changes.favorites.newValue || [];
                this.scheduleUpdate(true, 0);
            }
        });

        window.addEventListener('resize', () => {
            clearTimeout(this.resizeDebounceTimer);
            this.resizeDebounceTimer = setTimeout(() => {
                // 크기 불변(포커스 전환 등)이면 무동작
                if (window.innerWidth === this.lastViewport.w &&
                    window.innerHeight === this.lastViewport.h) {
                    return;
                }
                this.lastViewport = { w: window.innerWidth, h: window.innerHeight };
                this.startObserver();           // 컨테이너가 바뀌었을 수 있으니 옵저버 재부착
                this.scheduleUpdate(true, 0);   // 강제 업데이트 → 렌더된 마커 실측 재측정 + 전체 재배치
            }, 1000);
        });

        // SPA 네비게이션 지원
        window.addEventListener('popstate', () => {
            this.startObserver();
            this.scheduleWarmupUpdates();
            this.scheduleUpdate(true, 0);
        });

        // pushState/replaceState 감지 (후크에서 발생)
        window.addEventListener('witq:urlchange', () => {
            this.startObserver();
            this.scheduleWarmupUpdates();
            this.scheduleUpdate(true, 0);
        });
    }

    startObserver() {
        const container = window.WITQ.dom.getScrollContainer();
        if (container === window) {
            if (this.observerRetryCount < 5) {
                if (!this.observerRetryTimer) {
                    this.observerRetryCount++;
                    this.observerRetryTimer = setTimeout(() => {
                        this.observerRetryTimer = null;
                        this.startObserver();
                    }, 500);
                }
                return;
            }
            // 재시도 상한 도달: document.body 폴백 옵저버 부착
            if (this.observerTarget === document.body) return;
            if (this.observer) this.observer.disconnect();
            this.observerTarget = document.body;
            this.observer = new MutationObserver(() => {
                this.scheduleUpdate(false, 120);
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
            // 부착 전 렌더된 내용이 반영되도록 부착 직후 1회 강제 갱신
            this.scheduleUpdate(true, 0);
            return;
        }

        // 정상 스크롤 컨테이너: 카운터 초기화 후 옵저버 부착
        this.observerRetryCount = 0;
        const observerTarget = container;
        if (!observerTarget) return;

        if (this.observer && this.observerTarget === observerTarget) return;
        if (this.observer) this.observer.disconnect();
        this.observerTarget = observerTarget;

        this.observer = new MutationObserver((mutations) => {
            const hasChange = mutations.some(m => m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length));

            if (hasChange || this.lastUrl !== location.href) {
                this.scheduleUpdate(false, 120);
            }
        });

        this.observer.observe(observerTarget, {
            childList: true,
            subtree: true
        });
        // 부착 전 렌더된 내용이 반영되도록 부착 직후 1회 강제 갱신
        this.scheduleUpdate(true, 0);
    }
}

// SPA URL 변경 훅 (pushState / replaceState 감지)
if (!window.__WITQ_HISTORY_HOOKED__) {
    window.__WITQ_HISTORY_HOOKED__ = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const emitUrlChange = () => window.dispatchEvent(new Event('witq:urlchange'));

    history.pushState = function(...args) {
        const result = originalPushState.apply(this, args);
        emitUrlChange();
        return result;
    };

    history.replaceState = function(...args) {
        const result = originalReplaceState.apply(this, args);
        emitUrlChange();
        return result;
    };
}

// 안전한 지연 초기화 (인스턴스를 노출해 DevTools에서 __witqMM.debug = true 가능)
if (document.readyState === 'complete') {
    window.__witqMM = new MarkerManager();
} else {
    window.addEventListener('load', () => { window.__witqMM = new MarkerManager(); });
}
