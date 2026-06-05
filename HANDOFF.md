# Where is the Question? — 개발 인수인계 문서 (통합본)

> 다음 Claude Code 세션에서 이 문서 하나로 바로 작업을 이어가기 위한 정리.
> (기존 DEV_MEMORY.md + HANDOFF.md를 이 파일로 통합. 2026-06-04 갱신)
> 작업 디렉터리: `/home/aero-mere/wiq/Where_is_the_question`

---

## 1. 프로젝트 개요

- **크롬 확장(Manifest V3)**. ChatGPT/Gemini 대화 페이지에서 **사용자 질문 위치를 스크롤바 옆 파란 마커**로 표시.
- 핵심 UX: 마커 클릭 → 해당 질문으로 이동 / 호버 → 미리보기 툴팁 / 우클릭 → 즐겨찾기(노란 마커 + 질문 옆 별표) / 팝업 → 질문·즐겨찾기 목록.
- 현재 버전: `manifest.json` **1.5**. 웹스토어 업로드 zip은 `dist/` 경로 사용 (마지막 업로드는 v1.3).
- 콘텐츠 스크립트 로드 순서: `src/modules/text.js` → `config.js` → `dom.js` → `storage.js` → `content.js` (`run_at: document_idle`).

## 2. 팀 운영 (프로젝트 CLAUDE.md 기준)

| 역할 | 모델 | 책임 |
|---|---|---|
| Director (메인 세션) | claude-opus-4-8 | 사용자와 계획, 작업 지시, 검증, **문서(.md) 소유**, git 커밋 |
| Coder (서브에이전트) | claude-sonnet-4-6 | 코드 구현 |
| Reviewer (서브에이전트) | claude-sonnet-4-6 | 리뷰, APPROVED/REJECTED 판정 |

- 워크플로: 요구 명확화 → Coder 작업 → Director 디스크 검증 → Reviewer 리뷰 → (REJECTED면 최대 3회 재작업) → **즉시 커밋+푸시** → 사용자 실기기 테스트 (문제 발견 시 후속 수정 커밋).
- **Coder/Reviewer는 README.md / HANDOFF.md / PRIVACY_POLICY.md / manifest.json 절대 수정 금지** (Director 소유).
- 모든 소통 한국어. 커밋은 main에 직접(사용자 확정 방침). **작업 완료 직후 항상 커밋+푸시까지 Director가 수행 — 실기기 테스트를 기다리지 않음** (2026-06-04 사용자 지시).
- 서브에이전트는 세션 한정 → 새 세션에서 다시 스폰. SendMessage는 이름이 아니라 **agentId**로 보내야 함.

## 3. 아키텍처 스냅샷

- `content.js` — `MarkerManager` 클래스 (~900줄). 마커 생명주기(`this.markers`: id → {marker, element, position, text, isQuestion}), 스캔 루프, 클릭 이동, SPA URL 변경 처리, 워밍업 업데이트(`[180,900,2000,4000]ms`), MutationObserver(+body 폴백, 재시도 5회 제한), 디바운스/RAF 스케줄링, 즐겨찾기 동기화, 멀티 인스턴스 정리(`witq:teardown` 이벤트).
- `src/modules/text.js` — 공유 순수 유틸 (UMD): `escapeHtml`, `normalizeFileName`, `stripYouSaid`, `normalizePlainText`, `hashString`. **테스트 대상은 이 순수 유틸만.**
- `src/modules/config.js` — 사이트별 질문 셀렉터/파서 (ChatGPT/Gemini 분리), 첨부파일명 추출, 툴팁 텍스트 구성.
- `src/modules/dom.js` — 스크롤 컨테이너 감지(질문 포함 조상 우선 + 검증된 셀렉터 폴백, 500ms 캐시), 위치 측정, `scrollToQuestionPosition(rawPosition, container, behavior)`.
- `src/modules/storage.js` — 대화별 스캔 캐시(메모리 전용, `getConversationKey()` = pathname, 값 형태 `{questions, scanHeight}`), 즐겨찾기(chrome.storage.local), 팝업 메시징.
- 질문 ID: 콘텐츠 해시 기반 `generateQuestionId` (같은 텍스트 중복 시 출현 순번 접미사).

## 4. "긴 가상화 페이지" 기능 — 완료된 내역

ChatGPT는 화면 밖 메시지를 DOM에서 언마운트(가상화, 한 번에 ~8개만 존재)하고, **대화를 열면 맨 아래부터 렌더**하며, scrollHeight가 렌더 중 계속 자란다. 이에 대응:

- **자동 전체 스캔**: 긴 페이지(높이 > 뷰포트×3) 첫 진입 시 1회, 위→아래 점프하며 전 질문 위치 수집. "스캔 중..." 배지. DOM 안정 감지(`waitForDomSettle`) 기반 스텝. 적응형 전진(최소 0.8뷰포트, 최대 2.5뷰포트 — 하단 잔존 렌더에 속아 폭주하는 것 방지). 종료 후 원위치 복원, 대화별 캐시 저장(`scannedKeys`로 세션당 1회).
- **스캔 속도 최적화(2026-06-04)**: 무변경 스텝 연속 시(`quietStreak`) 2차 대기 생략 + 최소 전진 계수 0.8→최대 2.4뷰포트 점진 확대(mutation 감지 시 리셋). 질문 적고 답변 긴 페이지의 조용한 구간 가속. 디버그 로그 `scan step`에 `quietStreak` 표시.
- **스캔 좌표계(scanHeight)**: 스캔 완료 시점 전체 높이를 캐시에 동봉. 마커 % 분모 = `max(scanHeight, 현재높이)` → 재진입 시 높이가 출렁여도 마커 안 흔들림. 높이가 스캔 시점과 10% 이상 어긋나면 라이브 측정값의 캐시 덮어쓰기 차단 + 표시 position은 캐시 유지.
- **클릭 2단계 이동**: 캐시 위치(좌표계 스케일링)로 즉시 점프 → 렌더 대기 → 대상 발견 시 실측 보정. **긴 페이지는 전부 즉시 점프('auto')** (smooth는 가상화 churn에 중간에 끊겨서 사용자 결정으로 폐기, 짧은 페이지만 smooth 유지). 착지 후 `_settleAndCorrect`(최대 3회, 4px 데드밴드)로 정밀 보정.
- **안정화 수정들**: 초기화 타이밍 레이스(옵저버 attach 직후 강제 업데이트), SPA 이동 시 잔존 마커 즉시 제거(URL 변경 처리를 isScanning 가드보다 먼저), 스캔 중 대화 전환 시 abort(+이전 대화 scrollTop 복원 금지), 고아 콘텐츠 스크립트 정리(witq:teardown), 컨테이너 오판 수정(260px 엉뚱한 요소 잡던 것 → 질문 포함 스크롤 조상 우선).

커밋: `f8f6686`, `46bcf21`(v1.5 기능 본체), 이후 실기기 버그픽스 `a0ac36c`~`79bb871` ("long page fix 1~5").

**실기기 확인 완료**: 긴 페이지 새로고침 → 스캔 → 전체 질문 마커 생성 → 즉시 점프 착지 모두 정상. 긴→짧은 SPA 이동 정상. 짧은↔짧은 정상.

## 5. 짧은→긴 SPA 재진입 클릭 부정확 — 앵커 기반 탐색으로 재수정 (2026-06-04, **실기기 확인 완료**)

1차 수정(루프마다 비례 재스케일링)은 실기기에서 실패. **원인: 비례 스케일링 모델 자체가 오류** — 재진입 시 ChatGPT는 맨 아래 일부만 렌더하고 위쪽 미렌더 콘텐츠는 높이를 거의 차지하지 않으므로 "균등 압축" 가정이 깨짐.

2차 수정 — `navigateToQuestion` 케이스 2를 **앵커 기반 탐색**으로 교체 (Reviewer APPROVED):
- 스캔 캐시 position = 완전 렌더 상태의 실제 px. 마운트된 질문 중 캐시 유일 해시로 식별되는 앵커를 찾아 `jumpPos = 앵커 라이브 실측 + (목표 캐시 pos - 앵커 캐시 pos)`. 점프→렌더→더 가까운 앵커로 재추정하며 수렴 (maxAttempts 8).
- 앵커 없으면 기존 비례 스케일링 폴백. 중복 텍스트 해시(count>1)는 앵커 제외.
- 1차 수정에서 유지된 것: 케이스 1 stale element 해시 검증, 해시+근접 매칭, found 시 entry.element 갱신, basePosition 캐시 직독.
- **디버그 로그 추가**: `[WITQ] nav {case}`, `nav attempt {attempt, jumpPos, anchorCachePos, anchors, liveHeight, found}`, `nav give-up`.

스캔 속도 최적화(quietStreak)는 **실기기에서 확실히 빨라짐 확인** (2026-06-04).

### 클릭 보정 제거 + 사용자 입력 즉시 중단 (2026-06-04, 사용자 결정)
클릭 직후 휠 조작 시 보정 루프가 스크롤을 마커 쪽으로 되돌리는 불편 해소:
- `_settleAndCorrect`(착지 후 최대 3회 미세 보정) 완전 삭제.
- 케이스 2 탐색 maxAttempts 8 → 3.
- **사용자 입력 중단**: 이동 중 wheel/touchstart/keydown(전역 캡처, passive) 감지 시 후속 대기/재점프 즉시 포기. 최초 점프는 클릭 직접 응답이라 항상 수행. try/finally로 리스너 해제 보장.
- **연타 가드**: `this.navToken` 토큰으로 새 클릭이 이전 이동 루프를 취소 (기존 LOW 항목 해소).
- 디버그 로그 `[WITQ] nav abort {id, reason: 'user-input'|'superseded'}` 추가.

### 정책 변경 (2026-06-04, 사용자 결정): 대화 진입 시마다 재스캔
스캔이 빨라진 것을 계기로, SPA 재진입 시 캐시만 재사용하는 복잡한 경로를 줄이기 위해 **URL 변경 시 새 대화 키를 `scannedKeys`에서 삭제** → 긴 페이지면 자동 스캔이 매 진입마다 다시 돈다. 기존 캐시는 유지되어 재진입 직후 마커가 즉시 뜨고, 스캔 완료 시 갱신됨. 캐시 낡음(scanHeight stale, 새 메시지 추가) 문제도 함께 해소. 앵커 기반 클릭 탐색은 스캔 후에도 언마운트 대상 착지에 필요하므로 유지.

- 디버깅: `chrome.storage.local.set({witqDebug:true})` 후 콘솔에서 `[WITQ] update {..., totalHeight, scanHeight, effHeight}` 확인. `window.__witqMM`으로 인스턴스 접근 가능.

## 6. 다음 작업 (사용자 요청, 2026-06-03)

1. ~~**즐겨찾기 별표 버그**~~ **해결 (2026-06-04, 실기기 확인 완료)**: ChatGPT가 대화 턴 요소를 div→article로 바꿔 `div[data-testid^=...]` CSS의 position:relative가 빗나가던 것이 원인. CSS 셀렉터 태그 한정 제거 + JS에서 래퍼가 static이면 인라인 relative 보정. 별 위치는 래퍼 좌상단 기준 `left: 210px` (사용자 조정 결과).
2. ~~**첨부파일 툴팁 형식 변경**~~ **완료 (2026-06-04, 실기기 확인 완료)**: 여러 차례 발전 — 최종 상태:
   - `extractQuestionData`(config.js)가 첨부 정보를 첫 줄 `*<레이블> 첨부` 형식으로 출력. 레이블은 **실제 파일명**(예: `*기숙사 거주 사실 확인서.pdf 첨부`), 파일명 없는 이미지 업로드는 `이미지`. 복수면 `, `로 연결. 이 문자열 형식은 popup.js도 소비하므로 **변경 금지**.
   - ChatGPT 신규 파일 카드 DOM 대응: 파일명은 `.truncate.font-semibold`, 종류 라벨은 `.truncate.text-token-text-secondary`(본문 제외 처리). 구 `data-testid^="file-attachment"` 셀렉터는 호환용 유지.
   - **툴팁 2박스 구조**(content.css + content.js `createMarkerElement`/`showTooltip`): `.question-marker-tooltip`은 투명 래퍼(위치/가시성만), 자식으로 `.witq-tooltip-attachment`(회색 #6b6b6b, 첨부 줄 전용) + `.witq-tooltip-main`(어두운 #2c2c2c, 본문, max-height 100px). showTooltip이 정규식 `/^\*((?:(?!<br>).)*첨부)(?:<br>|$)/`로 첨부 줄을 분리해 회색 박스에 넣고(선두 `*`는 표시에서 제거), 첨부/본문이 비면 해당 박스 display:none.
   - **이미지 전용 질문 마커 버그 수정** (`10dea2c`): 이미지만 올린 질문은 innerText가 비어 모든 식별 경로에서 누락되던 것을 `getPlainIdentity(el)` 헬퍼(content.js)로 해결 — 텍스트가 비면 질문 래퍼에 `<img>` 존재 시 상수 `'이미지 첨부'`를 식별자로 사용. 식별자 추출 7곳 전부 이 헬퍼로 통일. 이미지 전용 질문이 여러 개면 occurrence 접미사로 구분(중복 텍스트와 동일 시맨틱).
3. **지원 사이트 확장 — 1차 구현 완료 (2026-06-04, Reviewer APPROVED, 실기기 1차 테스트 완료)**: Claude(claude.ai) / Grok(grok.com) 추가. DeepSeek은 해시 클래스(빌드마다 변경)라 **사용자 결정으로 보류**. **Perplexity는 추가했다가 사용자 결정으로 제거 (2026-06-04)** — 별 위치 문제(클램프 제거로도 미해결)가 계기였고 사용자가 실사용하지 않는 서비스라 지원 대상에서 제외. manifest matches / config.js 사이트 분기 삭제 완료.
   - 셀렉터 출처: 오픈소스 익스포터 조사 (revivalstack/ai-chat-exporter 2026-03 등). claude=`[data-testid="user-message"]`(폴백 `.font-user-message`), grok=`div[id^="response-"]` 행 중 `.response-content-markdown` 없는 행의 `.message-bubble`(폴백 `.items-end`).
   - getQuestionWrapper: claude=`[data-test-render-count]`, grok=`div[id^="response-"]`. dom.js는 제네릭 폴백으로 충분해 무수정.
   - **실기기 결과 (2026-06-04)**: 마커 생성/호버/클릭 이동은 전 사이트 정상. 남은 문제는 아래 "다음 업데이트 목록".

### 다음 업데이트 목록 (2026-06-04 실기기 테스트 결과, 미해결)

| # | 사이트 | 증상 | 추정 원인 / 접근 |
|---|---|---|---|
| 1 | Gemini | ~~png만 회색 박스에 뜨고, 그 외 파일(pdf 등)은 **본문 박스에 섞여 나옴**~~ **수정 완료 (2026-06-04, 실기기 확인 대기)** | 사용자 제공 DOM 샘플로 확정: 현행 파일 칩은 `.user-query-container > .file-preview-container > ... > button.new-file-preview-file`(aria-label=확장자 포함 전체 파일명, 내부에 `.extension-label`/`.filename-label`). 칩 버튼을 파일명 셀렉터에 추가, `.file-preview-container`를 본문 제외 목록에 추가, `img`는 `:not(.luminous-file-icon)`으로 한정(파일 종류 아이콘 alt "DOCX icon" 오인 방지) |
| 2 | Claude | ~~회색 박스 전혀 안 뜸 + **첨부만 있는 질문은 마커 자체가 안 생김**~~ **완료 (2026-06-04, 실기기 확인)** | DOM 샘플로 확정: 썸네일(`[data-testid="file-thumbnail"]`, 파일명은 내부 `h3`)이 버블 밖 턴 래퍼에 있음. (1) getQuestionText 컨테이너를 `[data-test-render-count]`로 확장, 본문 제외에 `.sr-only`(You said 중복)/썸네일/`[role="group"]`(타임스탬프) 추가 → 회색 박스 해결(실기기 확인). (2) 첨부 전용 질문(라이브 검증 2026-06-04 최종): 정상적으로 턴 래퍼 안에 렌더되지만 **이미지 썸네일은 `data-testid`가 파일명**이라 `file-thumbnail` 필터에 안 걸렸던 것 → 공통 클래스 `[class*="group/thumbnail"]`로 판정 확장. 추가 발견: **`[data-testid="chat-stale-nav-inert"]`(inert+aria-hidden) 스테일 프레임**에 이전 화면 캐시(파일 그리드 등)가 남아 가짜 질문으로 잡혔음 → claude 질문 수집에서 `closest('[inert], [aria-hidden="true"]')` 제외 필터 적용. 중간에 시도했던 고아 그리드 수집은 스테일 패널 오인이라 제거. `getPlainIdentity` 썸네일 h3 폴백(content.js)은 안전망으로 유지. 마지막 잔여 버그(첨부 전용 턴 본문에 타임스탬프 `7:28 PM` + Anthropicons 글리프 샘)는 본문 제외에 `button`/`.text-text-500`/`[class*="group/thumbnail"]` 추가로 해결 — 사용자 버블엔 button이 없어 안전. 전 케이스 실기기 확인 완료 |
| 3 | Grok | ~~png은 회색 박스 자체가 안 생기고, pdf 등은 **본문 박스에 섞여 나옴**~~ **완료 (2026-06-05, 실기기 확인)** | DOM 샘플(2026-06-04)로 확정: Grok DOM 변경으로 사용자 버블에도 `.response-content-markdown`이 생겨 구 사용자/AI 판별이 무효 → `div[id^="response-"] [data-testid="user-message"]` 우선, 구 로직은 폴백 유지. 첨부 칩(`group/chip`)이 버블 밖 행 직속이라 getQuestionText 컨테이너를 행 전체로 확장, 파일명은 `[class*="group/chip"] span.truncate`(칩 button 자체에 truncate가 있어 span 한정), 본문 제외에 칩 전체/`.action-buttons`/`button` 추가. png 칩은 `img[alt=""]`뿐(파일명 없음)이라 extractQuestionData의 빈 raw skip을 "빈 IMG는 `이미지` 집계"로 보완(공유 경로지만 타 사이트 첨부 이미지는 alt/파일명 보유, Reviewer 저위험 판정). 참고: Grok은 첨부 전용 질문도 "다음 내용을 참조하세요:" 본문이 자동 생성돼 마커 누락 없음 |
| 4 | ~~Perplexity~~ | **사이트 자체를 지원 제외 (2026-06-04 사용자 결정)** | 별이 질문 박스를 가리는 문제(클램프 제거로도 미해결)가 계기. 코드/manifest에서 제거 완료 |
| 5 | 공통 | ~~**별 위치가 사이트마다 뒤죽박죽**~~ **완료 (2026-06-04, 실기기 확인)** | CSS 고정값 제거, `positionFavoriteStar`(content.js)가 질문 버블 rect 기준 버블 좌측 8px 바깥에 배치(클램프 없음, 음수 허용). 기존 별도 매 업데이트마다 재배치. 실기기 결과: 사이트마다 미세 차이는 있으나 사용자 수용 |

공통 진행 방법: 1~4는 각 사이트에서 첨부 포함 질문을 F12로 검사한 **outerHTML 샘플을 사용자에게 받아** 셀렉터를 확정하는 것이 가장 빠름 (문헌 조사로는 첨부 DOM까지 안 나옴). 5는 DOM 샘플 불필요, 바로 구현 가능.

추가 완료 (2026-06-04): 미사용 코드 제거 — `clearScanCache`(재스캔 정책 이후 고아), `getQuestions` 도달 불가 폴백, `createMarkerElement`/`updateMarkerElement`의 미사용 container 파라미터. 고아 인스턴스(확장 재로드 후 F5 안 한 탭)의 `Extension context invalidated` unhandled rejection 수정 — `getFavorites`에 `chrome.runtime.id` 가드, 우클릭 핸들러 catch + 컨텍스트 사망 시 `destroy()`.

~~미뤄둔 LOW 항목~~ **전부 처리 완료 (2026-06-05)**: 레이아웃 스래싱 — 즐겨찾기 별 배치를 starJobs 큐로 모아 updateMarkers 루프 뒤에서 읽기 전부→쓰기 전부 순으로 일괄 처리(강제 리플로우 1회로 수렴, 배치 컨텍스트 없으면 positionFavoriteStar 단건 폴백 유지). `__witqMM` 게이팅 — witqDebug 켜짐일 때만 initialize에서 노출, destroy 시 자기 참조면 삭제(8장 디버그 방법은 storage 플래그 방식이라 그대로 유효). (제외 판정 2026-06-05: 메시지 편집/재생성/삭제 시 재스캔 — 사용자 결정으로 커버 안 함, 편집 후에는 사용자가 새로고침하는 것으로 충분) (해소됨: scanHeight stale → 재스캔 정책, 연타 가드 → navToken. 제외 판정 2026-06-05: isQuestion 한국어 판별 — `is-question` 클래스를 참조하는 CSS/JS가 없어 기능 자체가 죽어 있음(개선 무의미, 오히려 데드 코드 정리 후보). 짧은→긴 재진입 클릭 버그 — 사용자 확인 결과 이미 해결됨)

### 전체 코드 감사 및 정리 (2026-06-05, Reviewer APPROVED)

적용: (1) isQuestion 기능 체인 전체 제거 — `is-question` 클래스에 CSS 규칙이 없고 popup도 필드를 안 읽는 완전 데드 기능 (config.isQuestion 메서드 포함 삭제). (2) 즐겨찾기 판정 O(n²)→Set — `favoriteIds`를 favorites 할당 4곳에서 동기 유지. (3) destroy()에서 리스너 해제 — onMessage/onChanged/resize/popstate/witq:urlchange 핸들러를 인스턴스 필드로 보관 후 제거(고아 인스턴스 메모리 누수 방지, chrome.* 해제는 try/catch). (4) `_scanCache` 상한 20 (삽입 순서 기반 LRU 유사 퇴출). (5) manifest `activeTab` 권한 제거 — popup은 tab.id만 사용.

보류(감사에서 발견했으나 의도적 미적용): 툴팁 hide 타이머 클로저(마커 제거 빈도 낮아 미미), updateMarkerElement의 getComputedStyle(즐겨찾기 수 적음), navigateToQuestion 앵커 탐색 로직 중복(내비 핵심 경로라 리팩터 위험 > 이득), 사이트 셀렉터 문자열 중복(취향 수준), getCleanText의 `closest` 검사(제거 시 의미 변화 위험), chatgptElementStrategy 캐시 리셋 스래싱 가능성(실증 없음).

## 7. 제약 (반드시 지킬 것)

- 외부 npm 의존성 / `package.json` / `node_modules` 금지.
- UMD 패턴 유지 (`src/modules/text.js` 참고). 주석 한국어.
- 테스트는 순수 유틸만: `node --test tests/*.test.js` (현재 31개. **`tests/` 디렉터리만 주면 Node v24에서 실패** — 반드시 글롭 사용). 구문 검사 `node --check`.
- 커밋은 main 직접, 작업 완료 후 푸시까지 Director가 수행.

## 8. 검증 방법

- `chrome://extensions` → 개발자 모드 → 압축 해제 로드. 코드 수정 후엔 **확장 새로고침 + 페이지 F5 둘 다** (안 하면 고아 인스턴스).
- 디버그 로그: 콘솔에서 `chrome.storage.local.set({witqDebug:true})` → F5. 끄기: `{witqDebug:false}`. **현재 사용자 기기에 켜져 있음.**
- 시나리오: 짧은 페이지 새로고침 / 긴 페이지 새로고침(스캔) / 짧은↔짧은 / 긴→짧은 / 짧은→긴(재진입 클릭 버그는 해결 확인 2026-06-05) / 마커 클릭 착지 / 즐겨찾기 / 휠 스크롤 중 마커 고정 여부.

## 9. 다음 세션 재개 순서

1. 이 문서 Read → `git log --oneline -5`로 상태 확인 (마지막: `10dea2c` 이미지 전용 질문 마커 수정).
2. Coder/Reviewer 서브에이전트 스폰 (프로젝트 CLAUDE.md의 시스템 프롬프트 사용).
3. 남은 작업: 6장 "다음 업데이트 목록"은 **전부 완료** (2026-06-05 실기기 확인). 남은 것은 LOW 항목들과 짧은→긴 재진입 클릭 버그(8장 시나리오 참고)뿐.
4. 각 수정마다: 디스크 검증(node --check + 테스트) → Reviewer → **즉시 main 커밋+푸시** → 사용자 실기기 테스트.
