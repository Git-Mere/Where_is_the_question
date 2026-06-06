window.WITQ = window.WITQ || {};

window.WITQ.storage = {
    // 대화별 스캔 캐시 (세션 내 메모리 전용, chrome.storage에 저장하지 않음)
    // conversationKey -> Array<{id, text, position}>
    _scanCache: new Map(),

    // 현재 대화의 키: location.pathname (ChatGPT /c/<id>, Gemini 경로 모두 커버)
    getConversationKey: function() {
        return location.pathname;
    },

    getScanCache: function(key) {
        return this._scanCache.get(key) || null;
    },

    setScanCache: function(key, list) {
        // 같은 키 재설정 시 삽입 순서를 갱신해 LRU처럼 동작하도록 삭제 후 재삽입
        this._scanCache.delete(key);
        this._scanCache.set(key, list);
        // 세션 내 무한 증가 방지: 가장 오래된 대화 캐시부터 제거
        while (this._scanCache.size > 20) {
            this._scanCache.delete(this._scanCache.keys().next().value);
        }
    },

    getFavorites: function() {
        return new Promise((resolve, reject) => {
            // runtime.id가 없으면 확장 재로드로 컨텍스트가 죽은 고아 인스턴스
            if (!chrome.runtime || !chrome.runtime.id || !chrome.storage) return reject(new Error("Extension context not available."));
            try {
                chrome.storage.local.get({ favorites: [] }, (result) => {
                    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                    resolve(result.favorites);
                });
            } catch (e) {
                // 가드 통과 직후 컨텍스트가 무효화되면 동기 throw 가능
                reject(e);
            }
        });
    },

    safeSendQuestionList: function(questionsForPopup) {
         if (!chrome.runtime || !chrome.runtime.id || !chrome.runtime.sendMessage) return;
        try {
            chrome.runtime.sendMessage({ type: 'questionList', questions: questionsForPopup, convKey: this.getConversationKey() }, () => {
                if (chrome.runtime.lastError) {}
            });
        } catch (e) {}
    }
};
