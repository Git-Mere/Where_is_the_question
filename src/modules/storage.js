window.WITQ = window.WITQ || {};

window.WITQ.storage = {
    // 대화별 스캔 캐시 (세션 내 메모리 전용, chrome.storage에 저장하지 않음)
    // conversationKey -> Array<{id, text, position, isQuestion}>
    _scanCache: new Map(),

    // 현재 대화의 키: location.pathname (ChatGPT /c/<id>, Gemini 경로 모두 커버)
    getConversationKey: function() {
        return location.pathname;
    },

    getScanCache: function(key) {
        return this._scanCache.get(key) || null;
    },

    setScanCache: function(key, list) {
        this._scanCache.set(key, list);
    },

    getFavorites: function() {
        return new Promise((resolve, reject) => {
            if (!chrome.runtime || !chrome.storage) return reject(new Error("Extension context not available."));
            chrome.storage.local.get({ favorites: [] }, (result) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                resolve(result.favorites);
            });
        });
    },

    safeSendQuestionList: function(questionsForPopup) {
         if (!chrome.runtime || !chrome.runtime.id || !chrome.runtime.sendMessage) return;
        try {
            chrome.runtime.sendMessage({ type: 'questionList', questions: questionsForPopup }, () => {
                if (chrome.runtime.lastError) {}
            });
        } catch (e) {}
    }
};
