# Where is the Question? — 인수인계 문서 (v1.9)

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
3. **질문 ID**: ChatGPT/Claude는 화면의 `data-turn-key` = 대화 데이터의 메시지 ID (2026-11-09 실측 확인). Gemini는 `.conversation-container`의 id.
4. **위치**: 화면에 그려진 질문은 실제 위치를 잰다. 가상화로 사라진 질문은 마지막 측정값을 기억하고, 위쪽에 내용이 끼어들어 전체가 밀리면 같이 밀어준다(`applyShift`). 한 번도 못 본 질문은 대화 데이터의 분량(질문+답변 글자 수) 비율로 실측 질문들 사이를 보간한다.
   - ChatGPT는 위로 올려야 예전 대화를 불러오므로, 첫 질문을 본 적이 없으면 "지금 스크롤 영역 = 대화 뒷부분"으로 보고 앞부분을 비율로 배치(`loadedStart`).
5. **이동**: 화면에 있으면 바로 스크롤(가까우면 부드럽게) 후 최대 2회 위치 보정. 없으면 어림 위치(아직 안 불러온 구간이면 맨 위)로 점프 → 렌더 대기 → 다시 측정, 최대 15회. 휠/터치/키 입력, 다른 마커 클릭, 대화 전환 시 즉시 중단.
6. **자동 스캔 없음**: v1.8의 "긴 대화 진입 시 화면을 위아래로 훑는 스캔"은 삭제.

## 4. 사이트별 DOM (2026-11-09 기준)

- **ChatGPT**: 스크롤 `.thread-scroll-container`(role=region). 턴 `[data-turn-key]`(질문+답변 한 쌍). 질문 제목 `h4[data-conversation-role="user"]`, 본문 `[data-user-message-bubble="true"]`, 파일 카드 `span[title]`, 이미지 `img`. 화면에 5~10턴만 유지. SPA 전환 후 이전 대화 스크롤 영역이 숨겨진 채 남아 있어 `pickContainer`가 질문을 포함한 영역을 고른다.
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

## 6. 규칙

- 외부 npm 의존성 금지, UMD 순수 모듈은 Node 테스트 가능하게 유지, 주석 한국어.
- 즐겨찾기 형식 `{convKey, id, text}`. v1.8 이하 즐겨찾기(텍스트 해시 ID)는 같은 텍스트의 질문을 찾아 새 ID로 자동 이전(`maybeMigrateFavorites`).
