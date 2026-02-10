window.WITQ = window.WITQ || {};

window.WITQ.storage = {
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
