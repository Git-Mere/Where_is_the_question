// 이 스크립트는 ChatGPT 페이지에 주입됩니다.

// 디바운스용 타이머
let debounceTimeout = null;
let lastQuestionsSignature = '';


// popup이 열려 있지 않을 때도 콘솔 에러가 안 뜨도록 questionList 메시지를 안전하게 보내는 함수
function safeSendQuestionList(questionsForPopup) {
    if (!chrome.runtime || !chrome.runtime.sendMessage) return;

    try {
        chrome.runtime.sendMessage(
            { type: 'questionList', questions: questionsForPopup },
            () => {
                // popup이 안 열려 있으면 lastError가 생기는데, 콘솔에 안 찍히게 무시
                if (chrome.runtime.lastError) {
                    // 필요하면 디버깅용 로그:
                    // console.debug('[Where is the question] popup not open:', chrome.runtime.lastError.message);
                }
            }
        );
    } catch (e) {
        // 확장 프로그램이 리로드 되는 중 등 예외 상황도 조용히 무시
        // console.debug('[Where is the question] sendMessage failed:', e);
    }
}


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
        createQuestionMarkers(true);
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

// 🔹 상단 고정 헤더 + 여유 마진만큼 보정값 구하기
function getScrollOffset(scrollContainer) {
    if (scrollContainer === window) {
        const header =
            document.querySelector('header') ||
            document.querySelector('nav') ||
            document.querySelector('[data-testid="sidebar-nav"]');
        const headerHeight = header ? header.getBoundingClientRect().height : 0;
        return headerHeight + 12;
    }
    return 12;
}

function scrollToQuestionPosition(rawPosition) {
    const scrollContainer = getScrollContainer();
    const offset = getScrollOffset(scrollContainer);
    const target = Math.max(rawPosition - offset, 0);

    if (typeof scrollContainer.scrollTo === 'function') {
        scrollContainer.scrollTo({ top: target, behavior: 'smooth' });
    } else {
        scrollContainer.scrollTop = target;
    }
}



// 🔹 마커 생성 메인 함수 (비동기로 변경)
async function createQuestionMarkers(force = false) {
    console.log('[Where is the question] Running createQuestionMarkers...');

    const questionSelector = 'div[data-message-author-role="user"]';
    const questions = document.querySelectorAll(questionSelector);
    const questionsForPopup = [];
    
    // 즐겨찾기 목록을 먼저 불러옴
    const favorites = await getFavorites();

    // 질문이 하나도 없을 때
    if (questions.length === 0) {
        const existContainer = document.getElementById('question-scrollbar-container');
        if (existContainer) {
            existContainer.style.display = 'none';
            existContainer.innerHTML = '';
        }
        lastQuestionsSignature = '';   // 시그니처 리셋
        safeSendQuestionList([]);
        return;
    }

    // 🔹 현재 질문들의 “내용 시그니처” 만들기 (텍스트 기준)
    const signature = Array.from(questions)
        .map(q => q.innerText.trim())
        .join('||');

    // 🔹 이전과 완전히 같고, 강제 업데이트가 아니라면 스킵
    if (!force && signature === lastQuestionsSignature) {
        console.log('[Where is the question] Questions unchanged, skip marker redraw.');
        return;
    }

    // 이 시점에서만 시그니처 갱신
    lastQuestionsSignature = signature;


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
        safeSendQuestionList([]);
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

        let hideTooltipTimer = null;

        const showTooltip = () => {
            clearTimeout(hideTooltipTimer);
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        };

        const hideTooltip = () => {
            hideTooltipTimer = setTimeout(() => {
                tooltip.style.opacity = '0';
                tooltip.style.visibility = 'hidden';
            }, 200); // 200ms delay before hiding
        };

        marker.addEventListener('mouseenter', showTooltip);
        marker.addEventListener('mouseleave', hideTooltip);
        tooltip.addEventListener('mouseenter', showTooltip);
        tooltip.addEventListener('mouseleave', hideTooltip);

        questionsForPopup.push({
            id: questionId,
            text: questionText,
            position: questionPosition
        });

        const clamped = Math.min(Math.max(questionPosition, 0), scrollableHeight);
        marker.style.top = `${(clamped / scrollableHeight) * 100}%`;

        marker.addEventListener('click', () => {
            scrollToQuestionPosition(questionPosition);
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

    safeSendQuestionList(questionsForPopup);
}

// --- Initial Execution & Observers ---

// 팝업으로부터의 요청 처리 (한 번만 등록)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'scrollToQuestion') {
        // 항상 헤더 높이 고려해서 스크롤
        scrollToQuestionPosition(message.position);
        sendResponse({ status: 'scrolling' });
    } else if (message.type === 'getQuestions') {
        createQuestionMarkers(true);
        sendResponse({ status: 'processing' });
    }
    // 비동기 응답 가능하게 유지 (지금은 바로 응답하지만 패턴상 true 유지)
    return true;
});

// 창 크기 변경 시에도 마커 위치 갱신 (중복 없이 딱 한 번만)
window.addEventListener('resize', () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(createQuestionMarkers, 300);
});

// DOM 변경 시 1.5초 뒤에 한 번만 갱신
const observer = new MutationObserver((mutationsList) => {
    const scrollbarContainer = document.getElementById('question-scrollbar-container');
    let shouldUpdate = false;

    for (const mutation of mutationsList) {
        // 🔹 우리 익스텐션이 만든 스크롤바 안에서 일어나는 변화는 무시
        if (scrollbarContainer && scrollbarContainer.contains(mutation.target)) {
            continue;
        }

        // 🔹 진짜 DOM 구조 / 텍스트가 바뀐 경우만 반응
        if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
            shouldUpdate = true;
            break;
        }
        if (mutation.type === 'characterData') {
            shouldUpdate = true;
            break;
        }
    }

    if (!shouldUpdate) return;

    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        console.log('[Where is the question] DOM changed, updating markers...');
        createQuestionMarkers();
    }, 1500);
});

// 처음 진입했을 때 한 번 실행
setTimeout(createQuestionMarkers, 1000);

// 전체 문서에 대해 변경 감지
observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true   // 텍스트 내용만 바뀌는 것도 잡기
});

