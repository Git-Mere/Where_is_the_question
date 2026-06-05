# Where is the Question? — 개발 인수인계 문서 (통합본)

> 다음 Claude Code 세션에서 이 문서 하나로 바로 작업을 이어가기 위한 정리.
> (기존 DEV_MEMORY.md + HANDOFF.md를 이 파일로 통합. 2026-06-03 갱신)
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

- 워크플로: 요구 명확화 → Coder 작업 → Director 디스크 검증 → Reviewer 리뷰 → (REJECTED면 최대 3회 재작업) → 사용자 실기기 테스트.
- **Coder/Reviewer는 README.md / HANDOFF.md / PRIVACY_POLICY.md / manifest.json 절대 수정 금지** (Director 소유).
- 모든 소통 한국어. 커밋은 main에 직접(사용자 확정 방침). **작업 완료 후 커밋+푸시까지 Director가 수행** (2026-06-04 사용자 지시로 변경).
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

## 5. 짧은→긴 SPA 재진입 클릭 부정확 — 앵커 기반 탐색으로 재수정 (2026-06-04, 실기기 확인 대기)

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

1. **즐겨찾기 별표 버그**: 즐겨찾기 추가 시 질문 본문 옆에 별표(★)를 그려 직접 스크롤할 때 식별하게 하는 기능인데, **페이지 맨 위 질문에만 별이 1개 생기고 그 다음 것들은 안 생김**. (`content.js` `updateMarkerElement`의 별표 부착 로직 / `getQuestionWrapper` 의심)
2. **첨부파일 툴팁 형식 변경**: 현재 첨부물을 `[ ]`로 감싸 표시하는데, 글만 있는 질문에서도 일부 텍스트가 의미 없이 `[ ]`로 감싸지는 오작동 있음. **`[ ]` 방식 제거**하고, png/pdf/docx 등 첨부 감지 시 툴팁 **첫 줄에 `*png 첨부` 형식**으로 표시. (`config.js` 첨부 추출 + `content.js` `formatTooltipHtml` 정리)
3. **지원 사이트 확장**: 현재 ChatGPT/Gemini만 지원. 요즘 많이 쓰는 챗봇형 AI 조사(Claude, Grok 등) 후 전부 지원 목표. (`config.js` 사이트 분기 구조 확장 + `manifest.json` matches 추가 — manifest는 Director가 수정)

미뤄둔 LOW 항목(이전부터): isQuestion 한국어 판별 개선, 레이아웃 스래싱, 메시지 편집/재생성/삭제 시 재스캔, `__witqMM` 노출 debug 게이팅. (해소됨: scanHeight stale → 재스캔 정책, 연타 가드 → navToken)

## 7. 제약 (반드시 지킬 것)

- 외부 npm 의존성 / `package.json` / `node_modules` 금지.
- UMD 패턴 유지 (`src/modules/text.js` 참고). 주석 한국어.
- 테스트는 순수 유틸만: `node --test tests/*.test.js` (현재 31개. **`tests/` 디렉터리만 주면 Node v24에서 실패** — 반드시 글롭 사용). 구문 검사 `node --check`.
- 커밋은 main 직접, 작업 완료 후 푸시까지 Director가 수행.

## 8. 검증 방법

- `chrome://extensions` → 개발자 모드 → 압축 해제 로드. 코드 수정 후엔 **확장 새로고침 + 페이지 F5 둘 다** (안 하면 고아 인스턴스).
- 디버그 로그: 콘솔에서 `chrome.storage.local.set({witqDebug:true})` → F5. 끄기: `{witqDebug:false}`. **현재 사용자 기기에 켜져 있음.**
- 시나리오: 짧은 페이지 새로고침 / 긴 페이지 새로고침(스캔) / 짧은↔짧은 / 긴→짧은 / 짧은→긴(재진입 클릭 = 남은 버그) / 마커 클릭 착지 / 즐겨찾기 / 휠 스크롤 중 마커 고정 여부.

## 9. 다음 세션 재개 순서

1. 이 문서 Read → `git log --oneline -5`로 상태 확인 (마지막: `79bb871` long page fix 5 + 문서 통합 커밋).
2. Coder/Reviewer 서브에이전트 스폰 (프로젝트 CLAUDE.md의 시스템 프롬프트 사용).
3. 5장(짧은→긴 클릭) 실기기 결과 확인 → **6장 1(즐겨찾기 별표)→2(첨부 툴팁)→3(사이트 확장)** 순서로.
4. 각 수정마다: 디스크 검증(node --check + 테스트) → Reviewer → 사용자 실기기 테스트 → main 커밋+푸시.
