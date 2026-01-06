document.addEventListener('DOMContentLoaded', () => {
    const questionList = document.getElementById('question-list');
    const emptyMessage = document.getElementById('empty-message');
    const showQuestionsOnlyCheckbox = document.getElementById('show-questions-only');

    let questionsCache = [];
    let favoritesCache = [];
    let showQuestionsOnly = false; // 필터 상태

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

    const getFilterState = () => {
        return new Promise(resolve => {
            chrome.storage.local.get({ showQuestionsOnly: false }, (result) => {
                resolve(result.showQuestionsOnly);
            });
        });
    };

    const saveFilterState = (state) => {
        return new Promise(resolve => {
            chrome.storage.local.set({ showQuestionsOnly: state }, () => {
                resolve();
            });
        });
    };


    // --- UI Update ---
    function updatePopupUI() {
        questionList.innerHTML = ''; // 목록 초기화

        let filteredQuestions = questionsCache;
        if (showQuestionsOnly) {
            filteredQuestions = questionsCache.filter(q => q.isQuestion);
        }

        if (!filteredQuestions || filteredQuestions.length === 0) {
            emptyMessage.style.display = 'block';
            questionList.style.display = 'none';
        } else {
            emptyMessage.style.display = 'none';
            questionList.style.display = 'block';

            filteredQuestions.forEach(question => {
                const isFavorite = favoritesCache.some(fav => fav.id === question.id);

                const li = document.createElement('li');
                li.className = 'question-item';
                li.dataset.questionId = question.id;

                const questionText = document.createElement('span');
                questionText.className = 'question-text';
                questionText.textContent = question.text;
                questionText.title = question.text;
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
    showQuestionsOnlyCheckbox.addEventListener('change', async (event) => {
        showQuestionsOnly = event.target.checked;
        await saveFilterState(showQuestionsOnly);
        updatePopupUI();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'questionList') {
            questionsCache = message.questions;
            updatePopupUI();
        }
    });

    // 팝업이 열릴 때 실행
    async function initialize() {
        favoritesCache = await getFavorites();
        showQuestionsOnly = await getFilterState();
        showQuestionsOnlyCheckbox.checked = showQuestionsOnly; // 체크박스 상태 업데이트

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab && activeTab.id) {
                chrome.tabs.sendMessage(activeTab.id, { type: 'getQuestions' }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.log('Content script not available. Showing empty message.');
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