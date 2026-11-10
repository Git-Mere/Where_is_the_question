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

    // 부드러운 스크롤이 멈출 때까지 대기 (scrollTop이 몇 프레임 연속 그대로면 끝)
    waitForScrollEnd(container, timeoutMs = 1500) {
        const read = () => this.isDocumentScroller(container) ? window.scrollY : container.scrollTop;
        return new Promise(resolve => {
            const start = performance.now();
            let last = read();
            let still = 0;
            const tick = () => {
                const now = read();
                still = Math.abs(now - last) < 0.5 ? still + 1 : 0;
                last = now;
                if (still >= 4 || performance.now() - start > timeoutMs) resolve();
                else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    },

    // DOM 변화가 quietMs 동안 없거나 timeoutMs가 지나면 끝난다. 변화를 봤는지 반환.
    waitForSettle(quietMs = 180, timeoutMs = 1200) {
        return new Promise(resolve => {
            let saw = false;
            let quietTimer = null;
            const observer = new MutationObserver(() => {
                saw = true;
                clearTimeout(quietTimer);
                quietTimer = setTimeout(done, quietMs);
            });
            const hardTimer = setTimeout(done, timeoutMs);
            function done() {
                observer.disconnect();
                clearTimeout(quietTimer);
                clearTimeout(hardTimer);
                resolve(saw);
            }
            observer.observe(document.body, { childList: true, subtree: true });
            quietTimer = setTimeout(done, quietMs);
        });
    }
};
