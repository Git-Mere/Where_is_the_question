# Where is the Question? — 인수인계 문서 (v1.10)

> v1.9에서 콘텐츠 스크립트를 처음부터 다시 작성했다. v1.8 이전의 개발 기록(스캔 방식, 앵커 탐색 등)은 git 기록(`main`의 이전 HANDOFF.md)에 남아 있다.

## 1. 개요

- 크롬 확장(Manifest V3). ChatGPT / Gemini / Claude 대화에서 내 질문 위치를 스크롤바 옆 파란 마커로 표시.
- 기능: 마커 호버 → 미리보기(첨부 회색 박스 + 본문), 클릭 → 그 질문으로 이동(도착 시 파란 테두리 깜빡임), 우클릭 → 즐겨찾기(노란 마커 + 질문 옆 별), 팝업 → 현재 대화의 질문/즐겨찾기 목록.
- Grok은 v1.9에서 지원 제외(로그인 환경이 없어 검증 불가).

## 2. 파일 구조 (로드 순서)

| 파일 | 역할 |
|---|---|
| `src/modules/text.js` | 순수 문자열 유틸 (escapeHtml, stripYouSaid, hashString 등) |
| `src/modules/parsers.js` | 순수. ChatGPT/Claude 대화 JSON → 질문 목록 `{id, text, attachments, images, weight}` |
| `src/modules/layout.js` | 순수. 실측 위치 + 분량 비율로 마커 위치(0~1) 계산, 역변환, 이동량 중앙값 |
| `src/modules/sites.js` | 사이트 어댑터: 스크롤 영역, 화면의 질문 읽기, 대화 데이터 받기 |
| `src/modules/dom.js` | 측정/스크롤/대기 헬퍼 |
| `src/modules/storage.js` | 즐겨찾기 저장 (`favorites: [{convKey, id, text}]`, convKey = pathname) |
| `content.js` | 컨트롤러: 대화 전환 감지, 갱신, 마커/툴팁/별, 이동, 팝업 응답 |
| `popup.js` | 팝업. `getQuestions`에 대한 응답으로 목록을 바로 받음 |

## 3. 동작 방식

1. **대화 전환 감지**: 콘텐츠 스크립트는 페이지의 `history.pushState`를 가로챌 수 없어서(격리된 실행 환경) 400ms마다 `location.pathname`을 확인한다.
2. **질문 목록**
   - ChatGPT: `/api/auth/session`의 accessToken으로 `/backend-api/conversation/{id}` 호출 → `current_node`에서 위로 올라간 경로의 user 메시지(숨김/컨텍스트 메시지 제외).
   - Claude: `/api/organizations` → 각 조직에서 `/chat_conversations/{id}?tree=True&rendering_mode=messages` 시도(성공한 조직 기억) → `current_leaf_message_uuid` 경로의 human 메시지.
   - Gemini: 대화 데이터 안 씀(내부 RPC). 화면에 있는 질문만 사용.
   - 대화 데이터를 못 받으면 화면에서 본 질문만 쌓아서 표시(자동 폴백).
   - **요청 최소화 (v1.10)**: ChatGPT는 대화 읽기 요청에 계정 단위 제한이 있고, 걸리면 사이트가 "A temporary limit is preventing this chat from loading" / "Couldn't load earlier messages"를 띄운다(2026-11-24 실측). v1.9는 질문을 보낼 때마다 전체 대화를 다시 받아 제한을 빨리 채웠다. v1.10은 대화별로 한 번만 받아 sessionStorage에 15분 캐시, 사이트가 먼저 불러오도록 1.5초 늦게 요청, 429면 10분간 요청 안 함. 새 질문(맨 끝 추가)은 화면에서 읽은 것으로 처리하고, 기존 질문 사이에 모르는 질문이 보일 때(질문 수정으로 갈래 변경)만 다시 받는다.
3. **질문 ID**: ChatGPT/Claude는 화면의 `data-turn-key` = 대화 데이터의 메시지 ID (2026-11-09 실측 확인). Gemini는 `.conversation-container`의 id.
4. **위치**: 화면에 그려진 질문은 실제 위치를 잰다. 가상화로 사라진 질문은 마지막 측정값을 기억하고, 위쪽에 내용이 끼어들어 전체가 밀리면 같이 밀어준다(`applyShift`). 한 번도 못 본 질문은 대화 데이터의 분량(질문+답변 글자 수) 비율로 실측 질문들 사이를 보간한다.
   - ChatGPT는 위로 올려야 예전 대화를 불러오므로, 첫 질문을 본 적이 없으면 "지금 스크롤 영역 = 대화 뒷부분"으로 보고 앞부분을 비율로 배치(`loadedStart`).
5. **이동 (v1.10에서 재작성)**
   - 방향은 "지금 렌더된 질문들보다 목표가 위/아래인지"로만 정한다. 기억된 위치는 어림값으로만 쓰고, 한 번에 최소 반 화면은 목표 방향으로 움직이며, 위아래로 지나치면 그 사이로 좁힌다(layout.nextScrollTarget, 이분 탐색).
   - 스크롤 전에 합성 휠 이벤트(dom.nudge)를 보낸다. ChatGPT는 대화를 열면 화면을 맨 아래에 고정하고, 코드로 옮긴 스크롤을 다시 맨 아래로 되돌린다. 휠 이벤트를 받으면 고정을 푼다(2026-11-24 실측, 확장 없이도 재현).
   - 맨 위에서 예전 대화를 불러와야 하면 실제로 불러와질 때까지 기다리고(waitForOlder, 최대 6초/회), 불러오는 중이면 제한 시간을 늘린다(최대 45초). 사이트가 실패 표시를 띄우면 멈추고 안내 토스트를 띄운다.
   - 안정 대기는 DOM 변화가 아니라 스크롤 위치/렌더된 턴 수/첫 턴 위치로 판단(waitForStable). 답변 생성 중에도 DOM은 계속 바뀌기 때문.
   - 사용자 직접 입력(휠/터치/키, isTrusted만), 다른 마커 클릭, 대화 전환 시 즉시 중단.
6. **자동 스캔 없음**: v1.8의 "긴 대화 진입 시 화면을 위아래로 훑는 스캔"은 삭제.

## 4. 사이트별 DOM (2026-11-09 기준)

- **ChatGPT** (2026-11-24 갱신): 대화를 열면 `/backend-api/conversations/{id}?num_turns=10`으로 마지막 10개 메시지만 받고, 맨 위로 올리면 `/conversations/{id}/messages?before=<id>&num_turns=10`으로 5턴씩 더 받는다. 실패 시 스크롤 영역 맨 위에 `[role=status]`(경고 아이콘 `use[href*=exclamationmark]`) + Retry. 화면 맨 아래 고정은 휠 이벤트로 풀림. 스크롤 `.thread-scroll-container`(role=region). 턴 `[data-turn-key]`(질문+답변 한 쌍). 질문 제목 `h4[data-conversation-role="user"]`, 본문 `[data-user-message-bubble="true"]`, 파일 카드 `span[title]`, 이미지 `img`. 화면에 5~10턴만 유지. SPA 전환 후 이전 대화 스크롤 영역이 숨겨진 채 남아 있어 `pickContainer`가 질문을 포함한 영역을 고른다.
- **Claude**: 스크롤 `[data-autoscroll-container="true"]`. 행 `[data-testid="transcript-row"][data-perf-row="human"]`, 질문 `[data-cds="UserMessage"][data-turn-key]`, 본문 `[data-testid="user-message"]`, 첨부 `[data-testid="file-thumbnail"]`(innerText 첫 줄 = 파일명). 일부 행만 렌더, 전체 높이는 어림값.
- **Gemini**: 스크롤 `infinite-scroller.chat-history`. 턴 `.conversation-container#<id>`, 질문 `user-query .query-text`, 파일 칩 `button.new-file-preview-file`(aria-label = 파일명), 이미지 `img[data-test-id="uploaded-img"]`.
- 사이트가 대화상자를 띄우면 배경에 `aria-hidden`이 붙으므로 질문 필터에 aria-hidden/inert를 쓰면 안 된다(실제 버그였음). 숨김은 요소 크기(`getClientRects`)로 거른다.

## 5. 검증 (2026-11-09)

- `node --test tests/*.test.js` (Node v24는 디렉터리만 주면 실패, 글롭 필수). 구문: `node --check`.
- 실사이트 검증은 코드를 페이지에 직접 주입(chrome API 흉내 shim)해서 수행:
  - ChatGPT 26개 질문 대화: 마커 26개 즉시 표시, 26개 전부 클릭 이동 성공(위쪽 미로딩 구간 포함). 대화 전환/새 채팅/뒤로가기, 즐겨찾기, 팝업 응답 확인.
  - Claude 23개(전부 이미지 질문) 대화: v1.8은 0개 → 23개, 클릭 23/23 성공. 다른 대화 전환 확인.
  - Gemini 10개 질문 대화: 10/10 성공, 첨부/이미지 인식 확인.
- 미검증: 새 질문을 보내는 중(스트리밍) 동작, Gemini의 아주 긴 대화(위쪽 추가 로딩 여부), 실제 확장으로 설치한 상태의 팝업 UI.
- 디버그: 콘솔에서 `chrome.storage.local.set({witqDebug:true})` → `[WITQ]` 로그 + `window.__witq`(격리 환경 콘솔에서 접근).

## 5-1. v1.10 검증 (2026-11-24)

- ChatGPT 23개 질문 대화(처음 열면 마지막 10개 메시지만 로드): v1.9는 1번 질문 클릭 시 25초 동안 위아래로 왔다갔다 하다 실패 → v1.10은 23/23 성공(1번 질문 3.3초, 평균 약 1.2초).
- Claude 23개 질문 대화 23/23(평균 0.3초), Gemini 3개 질문 대화 4/4.
- 답변 생성 중 휠 스크롤/마커 이동 정상(임시 채팅 15개 질문 + 다시 연 실제 대화).
- 마커 막대를 스크롤바 위가 아니라 스크롤바 왼쪽에 둔다(`dom.scrollbarWidth`). 겹치면 스크롤바를 잡으려다 마커가 눌린다.

## 6. 규칙

- 외부 npm 의존성 금지, UMD 순수 모듈은 Node 테스트 가능하게 유지, 주석 한국어.
- 즐겨찾기 형식 `{convKey, id, text}`. v1.8 이하 즐겨찾기(텍스트 해시 ID)는 같은 텍스트의 질문을 찾아 새 ID로 자동 이전(`maybeMigrateFavorites`).
