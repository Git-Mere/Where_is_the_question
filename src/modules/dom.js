// 스크롤/측정 헬퍼. 컨테이너가 없으면 문서 스크롤(document.scrollingElement)을 쓴다.
window.WITQ = window.WITQ || {};

window.WITQ.dom = {
    isScrollable(el) {
        if (!el || el === document.body) return false;
        const overflowY = window.getComputedStyle(el).overflowY;
        return /(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1;
    },

    // 사이트가 알려준 컨테이너 → 기준 요소의 스크롤 조상 → 문서 스크롤 순으로 결정
    resolveContainer(preferred, sample) {
        if (preferred && preferred.isConnected) return preferred;
        let el = sample ? sample.parentElement : null;
        while (el && el !== document.body && el !== document.documentElement) {
            if (this.isScrollable(el)) return el;
            el = el.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    },

    isDocumentScroller(container) {
        return container === document.scrollingElement || container === document.documentElement;
    },

    // 컨테이너가 화면에서 차지하는 영역 (문서 스크롤이면 창 전체)
    visibleRect(container) {
        if (this.isDocumentScroller(container)) {
            return { top: 0, bottom: window.innerHeight, height: window.innerHeight, right: window.innerWidth };
        }
        const r = container.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height, right: r.right };
    },

    // 스크롤바가 차지하는 폭(px). 오버레이 스크롤바(macOS 등)면 0.
    // 마커 막대를 스크롤바 "옆"에 두기 위해 쓴다. 스크롤바 위에 겹치면 스크롤바를 잡으려다 마커가 눌린다.
    scrollbarWidth(container) {
        if (this.isDocumentScroller(container)) {
            return Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        }
        const cs = window.getComputedStyle(container);
        const borders = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        return Math.max(0, container.offsetWidth - container.clientWidth - borders);
    },

    // 요소 윗변의 컨테이너 내부 좌표(px)
    positionIn(el, container) {
        const top = el.getBoundingClientRect().top;
        if (this.isDocumentScroller(container)) return top + window.scrollY;
        return top - container.getBoundingClientRect().top + container.scrollTop;
    },

    scrollTo(container, top, behavior) {
        const target = Math.max(0, top);
        if (this.isDocumentScroller(container)) window.scrollTo({ top: target, behavior: behavior || 'auto' });
        else container.scrollTo({ top: target, behavior: behavior || 'auto' });
    },

    // 사이트에 "사용자가 휠을 굴렸다"고 알린다. ChatGPT는 대화를 열면 맨 아래에 화면을 고정해두고
    // 코드로 옮긴 스크롤을 다시 맨 아래로 되돌리는데, 휠 이벤트를 받으면 고정을 푼다 (2026-11-24 실측).
    // 합성 이벤트라 실제 스크롤은 일어나지 않는다.
    nudge(container, dir) {
        const target = this.isDocumentScroller(container) ? document : container;
        try {
            target.dispatchEvent(new WheelEvent('wheel', {
                deltaY: dir < 0 ? -100 : 100, deltaMode: 0, bubbles: true, cancelable: true
            }));
        } catch (e) {}
    },

    scrollTop(container) {
        return this.isDocumentScroller(container) ? window.scrollY : container.scrollTop;
    },

    maxScrollTop(container) {
        if (this.isDocumentScroller(container)) {
            return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        }
        return Math.max(0, container.scrollHeight - container.clientHeight);
    },

    viewHeight(container) {
        return this.isDocumentScroller(container) ? window.innerHeight : container.clientHeight;
    },

    // signature()가 quietMs 동안 그대로면 끝 (최대 timeoutMs). 답변이 생성되는 중에도 DOM은 계속 바뀌므로
    // DOM 변화가 아니라 스크롤 위치/렌더된 턴 같은 "우리가 신경 쓰는 것"만 본다.
    // 백그라운드 탭에서도 돌도록 requestAnimationFrame 대신 타이머를 쓴다.
    waitForStable(signature, quietMs = 150, timeoutMs = 1000) {
        return new Promise(resolve => {
            const start = performance.now();
            let last = signature();
            let since = start;
            const tick = () => {
                const now = performance.now();
                const sig = signature();
                if (sig !== last) {
                    last = sig;
                    since = now;
                }
                if (now - since >= quietMs || now - start >= timeoutMs) resolve();
                else setTimeout(tick, 30);
            };
            setTimeout(tick, 30);
        });
    },

    // 부드러운 스크롤이 멈출 때까지 대기 (scrollTop이 몇 프레임 연속 그대로면 끝)
    waitForScrollEnd(container, timeoutMs = 1500) {
        const read = () => this.scrollTop(container);
        return new Promise(resolve => {
            const start = performance.now();
            let last = read();
            let still = 0;
            const tick = () => {
                const now = read();
                still = Math.abs(now - last) < 0.5 ? still + 1 : 0;
                last = now;
                if (still >= 4 || performance.now() - start > timeoutMs) resolve();
                else setTimeout(tick, 16);
            };
            setTimeout(tick, 16);
        });
    },

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};
