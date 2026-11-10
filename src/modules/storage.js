// 즐겨찾기 저장소 (chrome.storage.local). 형식: favorites: [{ convKey, id, text }]
window.WITQ = window.WITQ || {};

window.WITQ.storage = {
    // 대화 식별 키. 즐겨찾기를 대화별로 나누는 데 쓴다 (v1.6부터 같은 형식)
    conversationKey() {
        return location.pathname;
    },

    contextAlive() {
        return !!(chrome.runtime && chrome.runtime.id && chrome.storage);
    },

    async getFavorites() {
        if (!this.contextAlive()) return [];
        const result = await chrome.storage.local.get({ favorites: [] });
        return Array.isArray(result.favorites) ? result.favorites : [];
    },

    async setFavorites(favorites) {
        if (!this.contextAlive()) return;
        await chrome.storage.local.set({ favorites });
    }
};
