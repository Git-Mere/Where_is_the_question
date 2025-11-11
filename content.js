// 이 스크립트는 ChatGPT 페이지에 주입됩니다.

// 디바운스용 타이머
let debounceTimeout = null;

// 🔹 실제로 스크롤되는 컨테이너 찾기
// - ChatGPT는 윈도우가 아니라 안쪽 div가 스크롤되는 구조일 수 있어서
function getScrollContainer() {
    const firstQuestion = document.querySelector('div[data-message-author-role="user"]');
    if (!firstQuestion) {
        console.log('[Where is the question] No question found. Use window as scroll container.');
        return window;
    }

    let el = firstQuestion.parentElement;

    while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;

        // overflow-y가 auto나 scroll이고, 실제로 스크롤 가능한 높이가 있으면 스크롤 컨테이너로 판단
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
            console.log('[Where is the question] Using this element as scroll container:', el);
            return el;
        }

        el = el.parentElement;
    }

    // 못 찾으면 마지막 수단으로 window 사용
    console.log('[Where is the question] Scroll container not found. Fallback to window.');
    return window;
}

// 🔹 질문이 스크롤 컨테이너 안에서 얼마만큼 아래에 있는지(px) 구하기
function getQuestionPositionInContainer(question, container) {
    if (container === window) {
        const rect = question.getBoundingClientRect();
        return rect.top + window.scrollY;
    }

    // container 안에서의 상대 위치를 구함
    let offset = 0;
    let el = question;

    while (el && el !== container) {
        offset += el.offsetTop;
        el = el.offsetParent;
    }

    return offset;
}

// 🔹 마커 생성 메인 함수
function createQuestionMarkers() {
    console.log('[Where is the question] Running createQuestionMarkers...');

    const questionSelector = 'div[data-message-author-role="user"]';
    const questions = document.querySelectorAll(questionSelector);
    console.log(`[Where is the question] Found ${questions.length} user question elements.`);

    // 질문 하나도 없으면 그냥 종료
    if (questions.length === 0) {
        const existContainer = document.getElementById('question-scrollbar-container');
        if (existContainer) {
            existContainer.style.display = 'none';
            existContainer.innerHTML = '';
        }
        console.log('[Where is the question] No questions. Nothing to draw.');
        return;
    }

    // 스크롤 컨테이너 찾기
    const scrollContainer = getScrollContainer();

    let scrollbarContainer = document.getElementById('question-scrollbar-container');

    // 처음 한 번만 컨테이너 만들기
    if (!scrollbarContainer) {
        scrollbarContainer = document.createElement('div');
        scrollbarContainer.id = 'question-scrollbar-container';
        document.body.appendChild(scrollbarContainer);
        console.log('[Where is the question] Created scrollbar container.');
    }

    // 스크롤 가능한 전체 높이 계산
    let scrollableHeight = 0;

    if (scrollContainer === window) {
        const totalHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;
        scrollableHeight = Math.max(totalHeight - viewportHeight, 1);
        console.log('[Where is the question] Using window scroll. totalHeight, viewportHeight, scrollableHeight =',
            totalHeight, viewportHeight, scrollableHeight);
    } else {
        scrollableHeight = Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 1);
        console.log('[Where is the question] Using inner scroll container. scrollHeight, clientHeight, scrollableHeight =',
            scrollContainer.scrollHeight, scrollContainer.clientHeight, scrollableHeight);
    }

    if (scrollableHeight <= 0) {
        console.log('[Where is the question] scrollableHeight <= 0. Hiding container.');
        scrollbarContainer.style.display = 'none';
        scrollbarContainer.innerHTML = '';
        return;
    } else {
        scrollbarContainer.style.display = 'block';
    }

    // 기존 마커 전부 제거
    scrollbarContainer.innerHTML = '';

    // 각 질문마다 마커 생성
    questions.forEach((question, index) => {
        const marker = document.createElement('div');
        marker.className = 'question-marker';

        // 툴팁 텍스트 (hover시)
        const questionTextElement = question.querySelector('.text-base');
        const questionText = questionTextElement ? questionTextElement.innerText : `Question ${index + 1}`;
        marker.title = questionText;

        // 이 질문이 스크롤 컨테이너 안에서 얼마나 아래 있는지(px)
        const questionPosition = getQuestionPositionInContainer(question, scrollContainer);

        // 0 ~ scrollableHeight 사이로 클램프
        const clamped = Math.min(Math.max(questionPosition, 0), scrollableHeight);
        const markerPositionPercent = (clamped / scrollableHeight) * 100;

        marker.style.top = `${markerPositionPercent}%`;

        // 마커 클릭 시 해당 위치로 스크롤
        marker.addEventListener('click', () => {
            console.log('[Where is the question] Scrolling to question at position', questionPosition);

            if (scrollContainer === window) {
                window.scrollTo({
                    top: questionPosition,
                    behavior: 'smooth'
                });
            } else if (typeof scrollContainer.scrollTo === 'function') {
                scrollContainer.scrollTo({
                    top: questionPosition,
                    behavior: 'smooth'
                });
            } else {
                scrollContainer.scrollTop = questionPosition;
            }
        });

        scrollbarContainer.appendChild(marker);
    });

    console.log('[Where is the question] Markers created:', scrollbarContainer.childElementCount);
}

// 🔹 창 크기 바뀔 때도 다시 계산
window.addEventListener('resize', () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(createQuestionMarkers, 300);
});

// 🔹 DOM 변화를 감지해서, 일정 시간 후에 다시 마커 갱신
const observer = new MutationObserver(() => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
        createQuestionMarkers();
    }, 500); // 500ms 대기 후 레이아웃 안정되면 실행
});

// 🔹 초기 1번 실행 (페이지가 어느 정도 로드된 뒤)
setTimeout(createQuestionMarkers, 1000);

// 🔹 body 전체를 감시 (채팅 추가/변경 감지용)
observer.observe(document.body, {
    childList: true,
    subtree: true
});
