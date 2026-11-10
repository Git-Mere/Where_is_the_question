document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-i18n-content]').forEach(el => {
        el.textContent = chrome.i18n.getMessage(el.getAttribute('data-i18n-content'));
    });

    const questionList = document.getElementById('question-list');
    const favoritesList = document.getElementById('favorites-list');
    const favoritesSection = document.getElementById('favorites-section');
    const emptyMessage = document.getElementById('empty-message');

    let questions = [];
    let favorites = [];
    let convKey = null;
    let tabId = null;

    const getFavorites = async () => {
        const result = await chrome.storage.local.get({ favorites: [] });
        return Array.isArray(result.favorites) ? result.favorites : [];
    };

    const isFavorite = (id) => favorites.some(f => f.id === id && f.convKey === convKey);

    async function toggleFavorite(item) {
        favorites = await getFavorites();
        favorites = isFavorite(item.id)
            ? favorites.filter(f => !(f.id === item.id && f.convKey === convKey))
            : [...favorites, { id: item.id, convKey, text: item.text }];
        await chrome.storage.local.set({ favorites });
        render();
    }

    function goTo(id) {
        if (tabId !== null) chrome.tabs.sendMessage(tabId, { type: 'scrollToQuestion', id }, () => void chrome.runtime.lastError);
        window.close();
    }

    function createItem(item) {
        const li = document.createElement('li');
        li.className = 'question-item';

        const text = document.createElement('span');
        text.className = 'question-text';
        text.textContent = item.text;
        text.title = item.text;
        text.addEventListener('click', () => goTo(item.id));

        const star = document.createElement('span');
        star.className = 'favorite-star';
        star.textContent = isFavorite(item.id) ? '★' : '☆';
        star.addEventListener('click', () => toggleFavorite(item));

        li.append(text, star);
        return li;
    }

    function render() {
        questionList.replaceChildren();
        favoritesList.replaceChildren();

        // 즐겨찾기 섹션: 현재 대화의 즐겨찾기 중 지금 목록에 있는 것만 (목록 순서대로)
        const favs = questions.filter(q => isFavorite(q.id));
        favoritesSection.style.display = favs.length > 0 ? 'block' : 'none';
        favs.forEach(q => favoritesList.appendChild(createItem(q)));

        const empty = questions.length === 0;
        emptyMessage.style.display = empty ? 'block' : 'none';
        questionList.style.display = empty ? 'none' : 'block';
        questions.forEach(q => questionList.appendChild(createItem(q)));
    }

    function applyList(message) {
        questions = Array.isArray(message.questions) ? message.questions : [];
        convKey = message.convKey || null;
        render();
    }

    // 페이지에서 목록이 바뀌면 열려 있는 팝업도 갱신
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (message && message.type === 'questionList' && sender.tab && sender.tab.id === tabId) {
            applyList(message);
        }
    });

    (async () => {
        favorites = await getFavorites();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            render();
            return;
        }
        tabId = tab.id;
        chrome.tabs.sendMessage(tabId, { type: 'getQuestions' }, (response) => {
            if (chrome.runtime.lastError || !response) {
                render();
                return;
            }
            applyList(response);
        });
    })();
});
