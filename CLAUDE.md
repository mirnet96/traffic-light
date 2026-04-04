# CLAUDE.md — 보행 신호 알리미

## 프로젝트 개요

길 건너편 보행 신호등을 실시간으로 감지하고 전체화면으로 확대하여
저시력자가 신호를 쉽고 빠르게 확인할 수 있도록 돕는 웹 앱.

배포 주소: https://mirnet96.github.io/traffic-light

---

## 1차 목표 (최우선)

- 카메라로 2~10차선 건너편 보행 신호등 자동 감지 (근거리 + 원거리)
- 감지된 신호등을 전체화면으로 자동 확대 표시
- 정지 / 보행 상태를 크고 명확하게 표시
- TTS 음성으로 진행 과정 및 신호 상태 안내

---

## 기술 스택

| 분류 | 선택 |
|---|---|
| 마크업 | HTML5 |
| 스타일 | Tailwind CSS (CDN) + style.css (커스텀 보완) |
| 아이콘 | Google Material Symbols Rounded (FILL=1) |
| 추론 | 서버 WebSocket (wss://supply.klueware.com/ws) |
| 음성 | Web Speech API (SpeechSynthesisUtterance, ko-KR) |
| 녹화 | MediaRecorder API (video/webm;codecs=vp8) |
| 모듈 시스템 | ES Module (import/export) |
| 카메라 | `getUserMedia` API (HTTPS 필수) |
| 배포 | GitHub Pages |

---

## CDN 출처 (허용 목록)

```
https://cdn.tailwindcss.com
https://fonts.googleapis.com
https://cdn.jsdelivr.net
```

---

## 파일 구조

```
traffic-light/
├── index.html          — 구조·설정 화면·Tailwind 클래스
├── style.css           — 커스텀 스타일 (토글 스위치 포함)
├── app.js              — 진입점·카메라·스캔루프·전체화면·이벤트
├── ui.js               — setPhase·badge·PiP·fps·scanMsg·야간·디버그
├── tts.js              — TTS 전담 (진행과정 + 신호 안내)
├── recorder.js         — MediaRecorder 녹화 전담
├── settings.js         — cfg 객체·readConfig
├── detector.js         — WebSocket 추론 클라이언트
├── detector.yolo.js    — YOLOv8s 로컬 추론 (예비)
├── detector.mediapipe.js — MediaPipe 추론 (예비)
├── local-detector.js   — 로컬 YOLO 래퍼 (예비)
├── renderer.js         — drawBoxes·renderCards
├── README.md
└── CLAUDE.md
```

### 파일별 역할 및 라인 수 기준

| 파일 | 역할 | 상한 |
|---|---|---|
| `app.js` | 진입점·카메라·스캔루프·전체화면·이벤트 | 200줄 |
| `ui.js` | setPhase·badge·PiP·fps·scanMsg·야간·디버그 패널 | 200줄 |
| `tts.js` | TTS 전담 (진행과정·순환문구·신호 안내) | 80줄 |
| `recorder.js` | MediaRecorder 녹화·다운로드 | 60줄 |
| `settings.js` | cfg 객체·readConfig | 15줄 |
| `detector.js` | WebSocket 연결·send·receive | 100줄 |
| `detector.yolo.js` | YOLOv8s 로드·Letterbox·추론·NMS | 140줄 |
| `renderer.js` | drawBoxes·renderCards | 100줄 |

### 역할 분리 원칙

- `index.html` — 구조와 Tailwind 클래스만. 인라인 스타일 금지.
- `style.css` — Tailwind 불가 항목만 (토글 스위치, PiP, 스캔라인 등).
- `app.js` — 모듈 조합 진입점. 200줄 이하 유지.
- `ui.js` — DOM 조작 전담. `showDebug` DOM 유일 소유. 디버그 패널 포함.
- `tts.js` — DOM 접근 금지. `speechSynthesis` 만 사용.
- `recorder.js` — `MediaRecorder` 전담. `fs-rec-badge` DOM만 접근 허용.
- `settings.js` — `cfg` 객체와 `readConfig()` 만. 다른 DOM 접근 금지.
- `detector.js` — WebSocket 전담. DOM 접근 금지 (디버그 콜백으로 위임).
- `detector.yolo.js` — YOLOv8s 전용. DOM 접근 완전 금지.
- `renderer.js` — 그리기만. `onEmpty` 콜백으로 빈 상태 위임.

---

## 추론 방식: 서버 WebSocket

```
클라이언트                         서버
  │                                 │
  │── JPEG ArrayBuffer ────────────>│
  │                                 │ YOLOv8 추론
  │<─ { signals, error } JSON ──────│
```

| 항목 | 값 |
|---|---|
| 엔드포인트 | `wss://supply.klueware.com/ws` |
| 전송 포맷 | JPEG ArrayBuffer (q=0.75) |
| 수신 포맷 | JSON `{ signals: [...], error?: string }` |
| 연결 실패 | 3초 후 자동 재연결 |
| 프레임 타임아웃 | 5000ms |
| 동시 요청 | 이전 프레임 응답 대기 중이면 새 프레임 스킵 |

---

## 앱 상태 흐름 및 TTS 발화 시점

```
설정 화면
  └─> [시작 버튼 탭] TTS: "카메라를 시작합니다"
        └─> loading (getUserMedia → WebSocket)
              │ TTS: "서버에 연결하는 중입니다"
              ├─> live  TTS: "서버 연결 완료. 탐색을 시작합니다"
              │    └─> 스캔 루프 120ms
              │          │ [미감지] TTS: 순환 문구 (3.5s마다)
              │          └─> [감지] TTS: "보행 신호입니다" 등 → 전체화면 자동 표시
              └─> error
                    TTS: "카메라 권한이 거부되었습니다" 또는 "카메라를 사용할 수 없습니다"
```

---

## TTS 모듈 (tts.js)

### 진행 과정 안내 — `ttsPhase(phase)`

| phase 값 | 발화 내용 |
|---|---|
| `camera-start` | "카메라를 시작합니다" |
| `connecting` | "서버에 연결하는 중입니다" |
| `connected` | "서버 연결 완료. 탐색을 시작합니다" |
| `offline` | "서버에 연결할 수 없습니다. 재연결을 시도합니다" |
| `reconnecting` | "서버 재연결 중입니다" |
| `live` | "신호등을 탐색 중입니다" |
| `error-perm` | "카메라 권한이 거부되었습니다..." |
| `error-cam` | "카메라를 사용할 수 없습니다" |

### 탐색 중 순환 — `ttsScanMsg(idx)`

화면의 `SCAN_MSGS` 배열과 동기화. `ui.js`의 `startScanMsgCycle()` 내부에서 호출.

### 신호 감지 안내 — `ttsSignal(sig, color)` (4초 쿨다운)

| 조건 | 발화 내용 |
|---|---|
| 보행신호 + green | "보행 신호입니다. 건너도 됩니다." |
| 보행신호 + 기타 | "정지 신호입니다. 기다려 주세요." |
| 일반 + green | "녹색 신호등 감지" |
| 일반 + red | "적색 신호등 감지" |
| 일반 + unknown | "신호등 감지됨" |

### TTS 규칙

- `tts.js`는 DOM 접근 금지. `speechSynthesis`만 사용.
- 쿨다운: 신호 감지 발화만 4초. 진행 과정 발화는 쿨다운 없음.
- `speechSynthesis.cancel()` 후 새 발화 (이전 발화 중단).

---

## 설정 화면 (카메라 시작 전)

카메라 시작 전 별도 설정 페이지 표시. 시작 버튼 클릭 시 `readConfig()` 로 값 읽기.

| 설정 항목 | 기본값 | DOM ID |
|---|---|---|
| 음성 알림 (TTS) | ON | `cfg-tts` |
| 디버그 로그 | OFF | `cfg-debug` |
| 디버그 녹화 | OFF | `cfg-rec` |

---

## 녹화 모듈 (recorder.js)

- `startRecording(stream)` — `MediaRecorder` 시작, 1초 청크
- `stopRecording()` — 중지 후 `.webm` 자동 다운로드
- 파일명: `debug_{timestamp}.webm`
- `#fs-rec-badge` 표시/숨김 담당 (유일한 DOM 접근)
- 디버그 콜백: `setRecorderDebug(fn)` 으로 주입

---

## 스캔 루프 흐름

```
매 120ms:
  1. procCtx.drawImage(video)         // 프레임 캡처
  2. canvas.toBlob(q=0.75)            // JPEG 압축
  3. ws.send(ArrayBuffer)             // 서버 전송
  4. 응답 수신 { signals }
  5. tickFps()
  6. updateScanBadge(signals)
  7. drawBoxes(overlay, signals)
  8. signals.length > 0 && !fsVisible
       → estimateSignalColor()
       → showFullscreen(sig, color)   // 자동 전체화면
       → ttsSignal(sig, color)
  9. renderCards(signals, onTap, showDetEmpty)
  10. drawPip(proc, overlay)
```

### 전체화면 자동 표시

감지 즉시 자동으로 전체화면 표시. `fsVisible` 플래그로 중복 갱신 방지.
탭하면 닫힘 → `fsVisible = false`.

---

## 신호등 색상 추정

전체화면 표시 직전 `procCtx.getImageData` 로 박스 영역 픽셀 샘플링.

```js
// app.js — estimateSignalColor(box, W, H)
// 반환값: 'red' | 'green' | 'unknown'
if (r > 100 && r > g * 1.5) return 'red';
if (g > 80  && g > r * 1.2) return 'green';
return 'unknown';
```

- `unknown` 시 보행신호는 정지 처리, 일반 신호등은 노란색(주의) accent
- 진동: `green` → 200ms 한 번 / 그 외 → 100-50-100ms

---

## 근거리 / 원거리 구분 (서버 반환값)

| 구분 | 기준 |
|---|---|
| 근거리 | 박스 높이 >= 12% |
| 원거리 | 2% ~ 12% |
| 무효 | < 2% (버림) |

---

## 핵심 상수

```js
// app.js
SCAN_MS   = 120
NIGHT_THR = 60

// ui.js
PIP_SM    = { w:120, h:80  }
PIP_LG    = { w:200, h:130 }
SCAN_MSGS = [
  '신호등을 탐색 중입니다...',
  '카메라를 신호등 방향으로 향해 주세요',
  '건너편 신호등을 찾고 있습니다...',
  '멀리 있는 신호등도 감지합니다',
]

// tts.js
TTS_COOLDOWN_MS = 4000   // 신호 감지 발화 쿨다운
TTS_RATE        = 1.05
TTS_LANG        = 'ko-KR'

// detector.js
WS_URL      = 'wss://supply.klueware.com/ws'
JPEG_Q      = 0.75
WS_TIMEOUT  = 12000
```

---

## PiP (Picture-in-Picture)

| 항목 | 내용 |
|---|---|
| 위치 | 카메라 뷰 좌하단 (left:8px, bottom:8px) |
| 기본 크기 | 120×80px |
| 확대 크기 | 200×130px (탭 토글) |
| 내용 | proc + overlay 합성 |
| 좌상단 라벨 | `탐색중` / `감지됨` |
| 우하단 라벨 | `Nfps` |
| 테두리 색 | 탐색 중: `#3b82f6` / 감지됨: `#00ee44` |
| 갱신 | 스캔 루프 마지막 `drawPip(proc, overlay)` 호출 |

---

## 디버그 패널 규칙

- `debug-overlay` DOM 생성·조작은 `ui.js` 전용 (`showDebug` 함수)
- `app.js` 에서 `showDebug` import 후 사용
- `detector.js` 는 `onDebug` 콜백으로 주입받아 사용 (DOM 직접 접근 금지)
- `recorder.js` 는 `setRecorderDebug(fn)` 으로 콜백 주입
- 디버그 ON 상태에서만 `debug-overlay` 생성

---

## 상태 표시

| 배지 | 탐색 중 | 감지됨 |
|---|---|---|
| `badge-scan` | `탐색 중 · Nfps` (파란 깜빡임) | `감지 N건` (초록 고정) |
| `det-empty` | 순환 텍스트 표시 | 숨김 |
| PiP 우하단 | `Nfps` | `Nfps` |

---

## Topbar 레이아웃 규칙

- 앱 이름: `whitespace-nowrap`
- 배지·버튼: `whitespace-nowrap shrink-0`
- 빈 공간: `<div class="flex-1">`
- 야간 버튼: `야간` (OFF) / `ON` (ON)
- 카메라 전환 버튼: 아이콘만 (`w-8 h-8`)

---

## 전체화면 열기/닫기

```js
// 열기 (자동 — 감지 즉시)
fs.style.display = '';
fs.classList.add('show');
fsVisible = true;

// 닫기 (탭)
fs.classList.remove('show');
fsVisible = false;
// style.display = 'none' 직접 세팅 금지
```

---

## Canvas / Context 규칙

```js
const procCtx = proc.getContext('2d', { willReadFrequently: true }); // app.js에서만
const pipCtx  = pip.getContext('2d');                                 // ui.js에서만
// overlay context는 매번 getContext('2d') — willReadFrequently 불필요
// proc.getContext('2d') 직접 호출 금지 — procCtx 재사용
```

---

## 인터벌 관리

```js
// app.js
let scanTimer  = null;  // setTimeout 기반
let nightTimer = null;  // setInterval 기반
// scanTimer → clearTimeout
// nightTimer → clearInterval

// ui.js
let _scanMsgTimer = null;  // setInterval 기반 → clearInterval
```

---

## renderCards 콜백 시그니처

```js
renderCards(signals, onTap, onEmpty)
// onTap(sig)   — 카드 탭 시 전체화면 + TTS
// onEmpty()    — 빈 상태 복원 (ui.js의 showDetEmpty)
```

---

## 야간 모드

- 3초마다 `procCtx.getImageData` 평균 밝기 < 60 → 자동 전환
- 버튼: `야간` (OFF) / `ON` (ON)
- `getNightMode()` getter로 외부 접근 (ui.js export)

---

## UI 아이콘 (Material Symbols Rounded)

| 용도 | 아이콘 |
|---|---|
| 카메라 시작 | `videocam` |
| 카메라 전환 | `flip_camera_ios` |
| 야간 OFF | `dark_mode` |
| 야간 ON | `light_mode` |
| 오류 | `error` |
| 다시 시도 | `refresh` |
| 탐색 중 | `radar` |
| 보행 신호 | `directions_walk` |
| 일반 신호등 | `traffic` |
| 음성 알림 | `volume_up` |
| 디버그 | `bug_report` |
| 녹화 | `videocam` |

---

## 개발 규칙

- 이모지 사용 금지
- `localStorage` / `sessionStorage` 사용 금지
- `style.css` 에는 Tailwind 불가 스타일만
- `@latest` CDN 금지 — 고정 버전 명시
- 파일당 라인 수 상한 준수
- topbar 한 줄 유지
- `#fs` 닫기 시 `style.display='none'` 금지
- `proc.getContext('2d')` 직접 호출 금지 — `procCtx` 재사용
- `scanTimer` → `clearTimeout` / `nightTimer`, `_scanMsgTimer` → `clearInterval`
- `drawPip(proc, overlay)` 는 스캔 루프 마지막에만 호출
- `det-empty` 텍스트는 `.scan-msg-text` span만 변경
- `detector.js`, `detector.yolo.js` DOM 접근 완전 금지
- `tts.js` DOM 접근 완전 금지 — `speechSynthesis` 만 사용
- `recorder.js` 는 `#fs-rec-badge` 외 DOM 접근 금지
- TTS 진행 과정 발화는 쿨다운 없음 / 신호 감지 발화는 4초 쿨다운

---

## 향후 로드맵

- [ ] 신호등 색상 판별 정확도 개선 (픽셀 샘플링 → 서버 측 색상 분류)
- [ ] 카운트다운 타이머
- [ ] AI-Hub 데이터셋 기반 YOLOv8s fine-tuning
- [ ] PWA Service Worker
- [ ] 접근성: 고대비 모드, 폰트 크기 설정
- [ ] TTS 속도·음량 사용자 조절
