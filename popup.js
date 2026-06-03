document.addEventListener('DOMContentLoaded', () => {
    // --- Internationalization ---
    const i18n_elements = document.querySelectorAll('[data-i18n-content]');
    i18n_elements.forEach(el => {
        el.textContent = chrome.i18n.getMessage(el.getAttribute('data-i18n-content'));
    });

    // --- DOM Elements ---
    const questionList = document.getElementById('question-list');
    const favoritesList = document.getElementById('favorites-list');
    const favoritesSection = document.getElementById('favorites-section');
    const emptyMessage = document.getElementById('empty-message');

    let questionsCache = [];
    let favoritesCache = [];

    // --- Storage API Helpers ---
    const getFavorites = () => {
        return new Promise(resolve => {
            chrome.storage.local.get({ favorites: [] }, (result) => {
                resolve(result.favorites);
            });
        });
    };

    const saveFavorites = (favorites) => {
        return new Promise(resolve => {
            chrome.storage.local.set({ favorites }, () => {
                resolve();
            });
        });
    };

    // --- UI Helpers ---
    function createQuestionListItem(item, isFavorite) {
        const cleanText = item.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const li = document.createElement('li');
        li.className = 'question-item';
        li.dataset.questionId = item.id;

        const questionText = document.createElement('span');
        questionText.className = 'question-text';
        questionText.textContent = cleanText;
        questionText.title = cleanText;
        questionText.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const activeTab = tabs[0];
                if (activeTab && activeTab.id) {
                    chrome.tabs.sendMessage(activeTab.id, {
                        type: 'scrollToQuestion',
                        position: item.position,
                        id: item.id
                    });
                }
            });
            window.close();
        });

        const star = document.createElement('span');
        star.className = 'favorite-star';
        star.textContent = isFavorite ? '★' : '☆';
        star.addEventListener('click', async () => {
            if (isFavorite) {
                favoritesCache = favoritesCache.filter(fav => fav.id !== item.id);
            } else {
                favoritesCache.push({ id: item.id, text: item.text, position: item.position });
            }
            await saveFavorites(favoritesCache);
            updatePopupUI();
        });

        li.appendChild(questionText);
        li.appendChild(star);
        return li;
    }

    // --- UI Update ---
    function updatePopupUI() {
        questionList.innerHTML = '';
        favoritesList.innerHTML = '';

        const hasFavorites = favoritesCache.length > 0;
        favoritesSection.style.display = hasFavorites ? 'block' : 'none';

        if (hasFavorites) {
            favoritesCache.forEach(fav => {
                favoritesList.appendChild(createQuestionListItem(fav, true));
            });
        }

        if (!questionsCache || questionsCache.length === 0) {
            emptyMessage.style.display = 'block';
            questionList.style.display = 'none';
        } else {
            emptyMessage.style.display = 'none';
            questionList.style.display = 'block';

            questionsCache.forEach(question => {
                const isFavorite = favoritesCache.some(fav => fav.id === question.id);
                questionList.appendChild(createQuestionListItem(question, isFavorite));
            });
        }
    }

    // --- Event Listeners & Initial Load ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'questionList') {
            questionsCache = message.questions;
            updatePopupUI();
        }
    });

    async function initialize() {
        favoritesCache = await getFavorites();

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab && activeTab.id) {
                chrome.tabs.sendMessage(activeTab.id, { type: 'getQuestions' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log(chrome.i18n.getMessage('contentScriptNotAvailable'));
                        questionsCache = [];
                        updatePopupUI();
                    }
                });
            } else {
                questionsCache = [];
                updatePopupUI();
            }
        });
    }

    initialize();
});