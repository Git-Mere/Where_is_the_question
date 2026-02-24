document.addEventListener('DOMContentLoaded', () => {
    // --- Internationalization ---
    const i18n_elements = document.querySelectorAll('[data-i18n-content]');
    i18n_elements.forEach(el => {
        el.textContent = chrome.i18n.getMessage(el.getAttribute('data-i18n-content'));
    });

    // --- DOM Elements ---
    const questionList = document.getElementById('question-list');
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

    // --- UI Update ---
    function updatePopupUI() {
        questionList.innerHTML = ''; // Clear list

        if (!questionsCache || questionsCache.length === 0) {
            emptyMessage.style.display = 'block';
            questionList.style.display = 'none';
        } else {
            emptyMessage.style.display = 'none';
            questionList.style.display = 'block';

            questionsCache.forEach(question => {
                const isFavorite = favoritesCache.some(fav => fav.id === question.id);

                const li = document.createElement('li');
                li.className = 'question-item';
                li.dataset.questionId = question.id;

                // Strip HTML tags for clean display in the popup list
                const cleanText = question.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

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
                                position: question.position
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
                        favoritesCache = favoritesCache.filter(fav => fav.id !== question.id);
                        star.textContent = '☆';
                    } else {
                        favoritesCache.push(question);
                        star.textContent = '★';
                    }
                    await saveFavorites(favoritesCache);
                });

                li.appendChild(questionText);
                li.appendChild(star);
                questionList.appendChild(li);
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