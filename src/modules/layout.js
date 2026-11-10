// 마커 위치 계산. DOM에 의존하지 않는 순수 함수라 Node 테스트 대상.
//
// 좌표 두 가지:
//   - weightStart (0~1): 대화 데이터에서 계산한 "대화 전체 분량 중 이 질문이 시작하는 지점" 추정치
//   - pos (px): 실제로 화면에 렌더된 적 있는 질문의 스크롤 컨테이너 내부 위치
// 실측(pos)이 있으면 그걸 쓰고, 없으면 실측된 질문들 사이를 weightStart 비율로 보간한다.
(function(root) {
    function clamp01(v) {
        if (!Number.isFinite(v)) return 0;
        return Math.min(1, Math.max(0, v));
    }

    // weights 배열 → 각 항목의 시작 비율 (0~1)
    function weightStarts(weights) {
        const total = weights.reduce((s, w) => s + Math.max(0, w || 0), 0);
        if (total <= 0) return weights.map((_, i) => (weights.length ? i / weights.length : 0));
        let acc = 0;
        return weights.map(w => {
            const start = acc / total;
            acc += Math.max(0, w || 0);
            return start;
        });
    }

    // anchors: [{w, d}] (w 오름차순). w에 대응하는 d를 선형 보간
    function interpolate(anchors, w) {
        if (anchors.length === 0) return w;
        if (w <= anchors[0].w) return anchors[0].d;
        for (let i = 1; i < anchors.length; i++) {
            const a = anchors[i - 1];
            const b = anchors[i];
            if (w <= b.w) {
                const span = b.w - a.w;
                if (span <= 0) return b.d;
                return a.d + (b.d - a.d) * ((w - a.w) / span);
            }
        }
        return anchors[anchors.length - 1].d;
    }

    /**
     * items: 대화 순서대로 [{ weightStart: number|null, pos: number|null }]
     * opts.height: 현재 스크롤 컨테이너 전체 높이(px)
     * opts.complete: 대화 처음부터 끝까지가 지금 스크롤 영역에 다 들어있는지
     *   (ChatGPT는 위쪽 예전 대화를 아직 안 불러왔으면 false)
     * 반환: { fractions: number[] (0~1, 순서대로 단조 증가), loadedStart: number }
     *   loadedStart: 지금 스크롤 영역의 맨 위가 대화 전체에서 차지하는 시작 비율
     */
    function computeLayout(items, opts) {
        const height = Math.max(1, (opts && opts.height) || 1);
        const complete = !opts || opts.complete !== false;
        const hasWeights = items.some(it => it.weightStart !== null && it.weightStart !== undefined);

        let loadedStart = 0;
        if (!complete && hasWeights) {
            const firstMeasured = items.find(it => it.pos !== null && it.pos !== undefined &&
                it.weightStart !== null && it.weightStart !== undefined);
            loadedStart = firstMeasured ? clamp01(firstMeasured.weightStart) : 0;
        }
        const toDisplay = (pos) => loadedStart + (1 - loadedStart) * clamp01(pos / height);

        // 실측 항목 → 앵커. weightStart 순으로 정렬하고 d가 거꾸로 가는 앵커는 버린다.
        const anchors = [{ w: 0, d: 0 }];
        if (hasWeights) {
            const measured = items
                .filter(it => it.pos !== null && it.pos !== undefined &&
                    it.weightStart !== null && it.weightStart !== undefined)
                .map(it => ({ w: clamp01(it.weightStart), d: toDisplay(it.pos) }))
                .sort((a, b) => a.w - b.w);
            for (const a of measured) {
                const last = anchors[anchors.length - 1];
                if (a.d >= last.d && a.w >= last.w) anchors.push(a);
            }
        }
        const lastAnchor = anchors[anchors.length - 1];
        if (lastAnchor.w < 1) anchors.push({ w: 1, d: Math.max(1, lastAnchor.d) });

        const fractions = [];
        let prev = 0;
        for (const it of items) {
            let f;
            if (it.pos !== null && it.pos !== undefined) {
                f = hasWeights ? toDisplay(it.pos) : clamp01(it.pos / height);
            } else if (it.weightStart !== null && it.weightStart !== undefined) {
                f = interpolate(anchors, clamp01(it.weightStart));
            } else {
                f = prev;
            }
            f = Math.max(clamp01(f), prev);
            fractions.push(f);
            prev = f;
        }
        return { fractions, loadedStart };
    }

    // 표시 비율 → 현재 스크롤 영역의 px. 아직 안 불러온 위쪽 구간이면 null.
    function fractionToPixel(fraction, opts) {
        const height = Math.max(1, (opts && opts.height) || 1);
        const loadedStart = (opts && opts.loadedStart) || 0;
        if (fraction < loadedStart) return null;
        if (loadedStart >= 1) return height;
        return ((fraction - loadedStart) / (1 - loadedStart)) * height;
    }

    // 이전/현재 실측 위치 쌍에서 "전체가 같이 밀린 양"을 구한다 (위쪽에 예전 대화가 끼어든 경우 등).
    // 반환: 중앙값 이동량(px). 쌍이 없으면 0.
    function medianShift(pairs) {
        const deltas = pairs.map(p => p.now - p.prev).filter(Number.isFinite).sort((a, b) => a - b);
        if (deltas.length === 0) return 0;
        const mid = Math.floor(deltas.length / 2);
        return deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
    }

    const layout = { weightStarts, interpolate, computeLayout, fractionToPixel, medianShift };

    root.WITQ = root.WITQ || {};
    root.WITQ.layout = layout;
    if (typeof module !== 'undefined' && module.exports) module.exports = layout;
})(typeof window !== 'undefined' ? window : globalThis);
