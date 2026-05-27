# Where is the Question? — 다음 세션 인수인계 (Handoff)

> 다음에 Claude Code를 켰을 때 이 문서로 바로 이어서 작업하기 위한 정리.
> 작업 디렉터리: `/home/aero-mere/wiq/Where_is_the_question`
> 작성: 2026-05-27

---

## 1. Context (이 프로젝트 / 왜 다음 작업을 하는가)

- **프로젝트**: 크롬 확장(Manifest V3). ChatGPT/Gemini 대화 페이지에서 **사용자 질문 위치를 스크롤바 옆 파란 마커**로 표시하고, 호버 미리보기, 클릭 이동, 우클릭 즐겨찾기(노란색), 팝업 질문/즐겨찾기 목록 관리를 제공.
- **다음 작업이 필요한 이유**: 질문이 아주 많은 **긴 ChatGPT 페이지**에서 버그. ChatGPT가 화면 밖 메시지를 DOM에서 언마운트(가상화)하기 때문에 →
  - 최상단/최하단 질문에는 마커가 생기지만 **중간 질문들은 마커가 안 생김**(DOM에 없어서).
  - 맨 아래에서 최상단 마커를 클릭하면, 가는 도중 메시지들이 새로 렌더되며 높이가 출렁여서 **중간에서 스크롤이 멈춤**.
- **목표**: 긴 가상화 페이지에서도 **모든 질문에 마커**가 생기고, 클릭하면 정확히 그 질문으로 이동.
- 진단으로 확인됨: 한 번에 ~8개 user 메시지만 DOM에 존재, scrollHeight 약 50000px에 ±5%(~2700px) 불안정.

---

## 2. Team 구성 (agent team)

| 역할 | 누구 | 모델 | 책임 |
|---|---|---|---|
| 설계자 (Architect) | 메인 세션(나) | Opus 4.7 | 사용자와 방향 결정, 팀원에게 지시, **GEMINI.md/README.md 소유**, git 커밋 |
| 코더 (Coder) | Agent | Sonnet | 설계자/리뷰어 지시대로 코드 작성 |
| 리뷰어 (Reviewer) | Agent | Sonnet | 코더 코드 리뷰(최적화/불필요한 부분), 재작성 지시, **순수 유틸만 node:test 작성** |

- 팀은 세션 한정이라 다음 세션에서 **TeamCreate로 다시 생성** 필요. 위 역할/모델 그대로.
- 코더/리뷰어는 전체 권한으로 스폰(`mode: "bypassPermissions"`).
- **코더/리뷰어는 GEMINI.md / README.md 를 절대 건드리지 말 것** (설계자 소유). 이전에 리뷰어가 이걸 "스코프 위반"으로 오인해 되돌린 사고가 있었음.

---

## 3. 완료된 작업 (커밋 `1e01775`, origin/main에 푸시 완료)

이전 "전체 점검/리스크 진단" 후 선택한 수정들 — 전부 끝났고 푸시됨:

- **#1 즐겨찾기 ID 안정화**: 콘텐츠 해시 기반. `content.js`의 `generateQuestionId(question, plainText, allQuestions)` → `normalizePlainText` → `hashString` → 같은 텍스트 중복 시 출현 순번(`hash`, `hash-1`...).
- **#3 중복 정제 로직 통합**: 공유 UMD 모듈 `src/modules/text.js` 신설 (`escapeHtml`, `normalizeFileName`, `stripYouSaid`, `normalizePlainText`, `hashString`). `content.js`/`config.js`가 `window.WITQ.text.*`로 위임.
- **#4 팝업 즐겨찾기 섹션**: `popup.html/js/css`에 favorites-section + questions-section, 공유 `createQuestionListItem`, `{id, text, position}` 형태 통일. `_locales/en|ko`에 `favoritesHeader`/`questionsHeader`.
- **#5 옵저버 무한 재시도 방지**: `startObserver` 재시도 5회 제한 + `document.body` 폴백 옵저버, `resetMarkers`에서 리셋.
- **테스트**: `tests/text.test.js` (node:test, 순수 유틸, 통과).
- **정리**: `GEMINI.md`(Gemini CLI 잔여 지침 파일) 삭제. `README.md` 개발과정 섹션 Gemini→ChatGPT.

> 미뤄둔 LOW 항목: #6 isQuestion 한국어, #7 레이아웃 스래싱, #8 팝업 객체 형태 — 이번 기능 후 별도 검토.

---

## 4. 다음 작업 — "긴 가상화 페이지에서 모든 질문에 마커" (확정 설계)

사용자와 합의 완료. 이대로 코더에게 지시한다.

### 4.1 스캔 (질문 수집)
- **트리거**: 긴 대화를 **처음 열면 자동 1회** 스캔(확정). 작은 "스캔 중" 표시. 결과(질문 텍스트 + 위치)는 **대화별 캐시** → 같은 세션 재방문 시 즉시 표시.
- **방식**: 위→아래로 **즉시 점프**(`scrollTop = x`, 스무스 스크롤 금지). 고정 픽셀이 아니라 **"렌더 창" 단위로 4~6개씩 겹쳐가며** 이동. 고정 sleep 대신 **"DOM 변화 멈춤 = 렌더 안정" 감지**로 다음 스텝.
- **성능 목표**: ~26질문/50000px 기준 **8~12스텝, 2~4초**. 스캔 끝나면 원래 스크롤 위치 복원.

### 4.2 마커 위치
- **기존 "픽셀 비율" 방식 유지**: `위치(%) = (질문 스크롤 위치 / 전체 높이) × 100`.
- **순번/개수 균등 방식은 폐기** — 사용자가 거부(답변 길이를 무시해서 실제 위치와 어긋남).

### 4.3 리사이즈(창 크기 변화) 처리 — 재스캔 금지
- 리사이즈 멈춘 뒤 **~1초 디바운스** → 그 순간 **화면에 렌더된 마커들의 실제 위치를 DOM에서 재측정**(비율 계산 아님, 직접 측정).
- 화면 밖 마커는 마지막 위치에 임시로 두고, **그 구간으로 스크롤해 렌더되는 순간 lazy 재측정**으로 자동 보정.
- 단순 창 **포커스 전환**(크기 불변)은 레이아웃이 안 바뀌므로 **아무것도 안 함**.

### 4.4 클릭 이동 — 2단계 (중간 멈춤 버그 핵심 수정)
1. 캐시된 어림 위치로 **즉시 점프**
2. 대상 메시지가 **렌더될 때까지 잠깐 대기**
3. 실제 메시지를 찾으면 **그 위치로 정확히 보정**

### 4.5 재스캔이 필요한 경우 (리사이즈는 제외)
- 다른 대화로 **SPA 이동**(pushState/replaceState)
- 메시지 **편집 / 재생성(regenerate) / 삭제**

---

## 5. 제약 (반드시 지킬 것)
- 외부 npm 의존성 / `package.json` / `node_modules` **금지**.
- 브라우저+Node 양쪽 호환 위해 **UMD 패턴** 유지(`src/modules/text.js` 참고).
- **순수 유틸만** node:test로 테스트.
- 모든 소통 **한국어**.
- 커밋은 작업 후 가능, **푸시는 사용자가 직접**(승인 후).

---

## 6. 핵심 파일 (수정 대상)
- `content.js` — MarkerManager 클래스. 스캔 루프, 마커 그리기(픽셀 %), `startObserver`, 클릭→스크롤, 리사이즈 핸들러, `safeSendQuestionList`(현재 렌더된 질문만 팝업에 전송).
- `src/modules/dom.js` — `getScrollContainer`, `getQuestionPositionInContainer`, `scrollToQuestionPosition`(여기에 2단계 보정 추가 필요).
- `src/modules/config.js` — `getQuestionElements`(전략 폴백), `extractQuestionData`.
- `src/modules/storage.js` — 대화별 스캔 캐시 저장에 활용.
- `popup.js` — 전체 목록 표시(현재는 렌더된 질문만). 캐시된 전체 목록을 보여주도록 확장 검토.

---

## 7. 검증 방법
- `chrome://extensions` → 개발자 모드 → 압축 해제된 확장으로 로드.
- 질문 많은 **긴 ChatGPT 대화** 열기 → 자동 1회 스캔(~2~4초) → **모든 질문에 마커** 생성 확인.
- 중간/최상단 마커 클릭 → **정확히 그 질문에 착지**(중간 멈춤 없음).
- **창 크기 변경** → 재스캔 없이 마커 재측정 보정. 단순 포커스 전환은 무동작.
- **새 질문** → 마커 즉시 추가(스캔 없이).
- `node --test tests/` → 순수 유틸 테스트 통과.

---

## 8. 다음 세션 재개 순서
1. 이 문서(`HANDOFF.md`) + `content.js` / `src/modules/dom.js` / `config.js` 현재 상태 Read.
2. `git log`/`git status`로 `1e01775` 이후 변경 없는지 확인.
3. `TeamCreate`로 설계자/코더/리뷰어 팀 재구성(2장 표 참고).
4. 설계자가 4장 스펙대로 코더에게 지시 → 리뷰어 리뷰 → 코더 반영 → node:test.
5. 커밋(푸시는 사용자 승인 후).
