// 이 스크립트는 ChatGPT 페이지에 주입됩니다.

// 디바운스용 타이머
let debounceTimeout = null;

// --- Storage & Event Listeners ---

// Storage에서 즐겨찾기 목록 가져오기
const getFavorites = () => {
    return new Promise(resolve => {
        chrome.storage.local.get({ favorites: [] }, (result) => {
            resolve(result.favorites);
        });
    });
};

// 즐겨찾기 목록이 변경되면 마커를 다시 렌더링
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.favorites) {
        console.log('[Where is the question] Favorites changed, re-rendering markers.');
        createQuestionMarkers();
    }
});


// 🔹 실제로 스크롤되는 컨테이너 찾기
function getScrollContainer() {
    const firstQuestion = document.querySelector('div[data-message-author-role="user"]');
    if (!firstQuestion) {
        return window;
    }
    let el = firstQuestion.parentElement;
    while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
            return el;
        }
        el = el.parentElement;
    }
    return window;
}

// 🔹 질문의 컨테이너 내 위치(px) 구하기
function getQuestionPositionInContainer(question, container) {
    if (container === window) {
        const rect = question.getBoundingClientRect();
        return rect.top + window.scrollY;
    }
    let offset = 0;
    let el = question;
    while (el && el !== container) {
        offset += el.offsetTop;
        el = el.offsetParent;
    }
    return offset;
}

// 🔹 마커 생성 메인 함수 (비동기로 변경)
async function createQuestionMarkers() {
    console.log('[Where is the question] Running createQuestionMarkers...');

    const questionSelector = 'div[data-message-author-role="user"]';
    const questions = document.querySelectorAll(questionSelector);
    const questionsForPopup = [];
    
    // 즐겨찾기 목록을 먼저 불러옴
    const favorites = await getFavorites();

    if (questions.length === 0) {
        const existContainer = document.getElementById('question-scrollbar-container');
        if (existContainer) {
            existContainer.style.display = 'none';
            existContainer.innerHTML = '';
        }
        if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'questionList', questions: [] });
        }
        return;
    }

    const scrollContainer = getScrollContainer();
    let scrollbarContainer = document.getElementById('question-scrollbar-container');

    if (!scrollbarContainer) {
        scrollbarContainer = document.createElement('div');
        scrollbarContainer.id = 'question-scrollbar-container';
        document.body.appendChild(scrollbarContainer);
    }

    const scrollableHeight = (scrollContainer === window)
        ? Math.max(document.documentElement.scrollHeight - window.innerHeight, 1)
        : Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 1);

    if (scrollableHeight <= 0) {
        scrollbarContainer.style.display = 'none';
        scrollbarContainer.innerHTML = '';
        if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'questionList', questions: [] });
        }
        return;
    } else {
        scrollbarContainer.style.display = 'block';
    }

    scrollbarContainer.innerHTML = '';

    questions.forEach((question, index) => {
        const marker = document.createElement('div');
        marker.className = 'question-marker';

        let questionText = `Question ${index + 1}`;
        const conversationTurn = question.closest('div[data-testid^="conversation-turn"]');
        if (conversationTurn) {
            const textContentElement = conversationTurn.querySelector('.markdown.prose, .text-base, .whitespace-pre-wrap');
            if (textContentElement && textContentElement.innerText.trim().length > 0) {
                questionText = textContentElement.innerText.trim();
            } else if (conversationTurn.innerText.trim().length > 0) {
                questionText = conversationTurn.innerText.trim();
            }
        } else if (question.innerText.trim().length > 0) {
            questionText = question.innerText.trim();
        }

        const questionPosition = getQuestionPositionInContainer(question, scrollContainer);
        // 즐겨찾기 ID로 사용할 고유 ID 생성 (내용 일부 + 위치)
        const questionId = `${questionText.substring(0, 20)}-${Math.round(questionPosition)}`;

        // 즐겨찾기 여부 확인 및 스타일 적용
        if (favorites.some(fav => fav.id === questionId)) {
            marker.classList.add('favorite');
        }

        const tooltip = document.createElement('div');
        tooltip.className = 'question-marker-tooltip';
        tooltip.textContent = questionText;
        marker.appendChild(tooltip);

        marker.addEventListener('mouseenter', () => {
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });
        marker.addEventListener('mouseleave', (e) => {
            if (!tooltip.contains(e.relatedTarget)) {
                tooltip.style.opacity = '0';
                tooltip.style.visibility = 'hidden';
            }
        });
        tooltip.addEventListener('mouseleave', (e) => {
            if (e.relatedTarget !== marker) {
                tooltip.style.opacity = '0';
                tooltip.style.visibility = 'hidden';
            }
        });

        questionsForPopup.push({
            id: questionId,
            text: questionText,
            position: questionPosition
        });

        const clamped = Math.min(Math.max(questionPosition, 0), scrollableHeight);
        marker.style.top = `${(clamped / scrollableHeight) * 100}%`;

        marker.addEventListener('click', () => {
            const targetScrollContainer = getScrollContainer();
            if (typeof targetScrollContainer.scrollTo === 'function') {
                targetScrollContainer.scrollTo({ top: questionPosition, behavior: 'smooth' });
            } else {
                targetScrollContainer.scrollTop = questionPosition;
            }
        });

        // 마커 우클릭 시 즐겨찾기 토글
        marker.addEventListener('contextmenu', async (e) => {
            e.preventDefault(); // 기본 우클릭 메뉴 방지
            const currentFavorites = await getFavorites();
            const isFavorite = currentFavorites.some(fav => fav.id === questionId);
            let updatedFavorites;

            if (isFavorite) {
                // 즐겨찾기에서 제거
                updatedFavorites = currentFavorites.filter(fav => fav.id !== questionId);
            } else {
                // 즐겨찾기에 추가
                updatedFavorites = [...currentFavorites, { id: questionId, text: questionText, position: questionPosition }];
            }

            // 변경된 목록을 저장 (이것으로 onChanged 리스너가 트리거됨)
            chrome.storage.local.set({ favorites: updatedFavorites });
        });

        scrollbarContainer.appendChild(marker);
    });

    if (chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'questionList', questions: questionsForPopup });
    }
}

// --- Initial Execution & Observers ---

// 팝업으로부터의 요청 처리
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'scrollToQuestion') {
        const scrollContainer = getScrollContainer();
        if (typeof scrollContainer.scrollTo === 'function') {
            scrollContainer.scrollTo({ top: message.position, behavior: 'smooth' });
        } else {
            scrollContainer.scrollTop = message.position;
        }
        sendResponse({ status: 'scrolling' });
    } else if (message.type === 'getQuestions') {
        // 팝업이 열릴 때 질문을 다시 스캔해서 보내줌
        createQuestionMarkers();
        sendResponse({ status: 'processing' });
    }
    return true;
});

window.addEventListener('resize', () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(createQuestionMarkers, 300);
});

const observer = new MutationObserver(() => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(createQuestionMarkers, 500);
});

setTimeout(createQuestionMarkers, 1000);

observer.observe(document.body, {
    childList: true,
    subtree: true
});
