# CLAUDE.md — 보행 신호 알리미

## 프로젝트 개요

길 건너편 보행 신호등을 실시간으로 감지하고 전체화면으로 확대하여
저시력자가 신호를 쉽고 빠르게 확인할 수 있도록 돕는 웹 앱.

배포 주소: https://mirnet96.github.io/traffic-light

---

## 1차 목표 (최우선)

- 카메라로 2~10차선 건너편 보행 신호등 자동 감지 (근거리 + 원거리)
- 감지된 신호등을 전체화면으로 자동 확대 표시 (초해상도 처리 포함)
- 정지 / 보행 상태를 TTS 음성으로 안내
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
| 카메라 | getUserMedia API (HTTPS 필수) |
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
├── app.js              — 진입점·이벤트
├── camera.js           — 카메라·스캔루프·ROI·야간 감지·색상 추정
├── ui.js               — setPhase·badge·PiP·fps·scanMsg·야간·디버그
├── tts.js              — TTS 전담 (진행과정 + 신호 안내)
├── recorder.js         — MediaRecorder 녹화 전담
├── settings.js         — cfg 객체·readConfig
├── detector.js         — WebSocket 추론 클라이언트
├── detector.yolo.js    — YOLOv8s 로컬 추론 (예비)
├── detector.mediapipe.js — MediaPipe 추론 (예비)
├── local-detector.js   — 로컬 YOLO 래퍼 (예비)
├── renderer.js         — drawBoxes·renderCards
├── fullscreen.js       — 전체화면 초해상도 렌더
├── api.html            — V2X 진단 모드 UI
├── api.js              — V2X 진단 모드 로직
├── README.md
└── CLAUDE.md
```

### 파일별 역할 및 라인 수 기준

| 파일 | 역할 | 상한 |
|---|---|---|
| app.js | 진입점·이벤트 | 60줄 |
| camera.js | 카메라·스캔루프·ROI·야간 감지·색상 추정 | 200줄 |
| ui.js | setPhase·badge·PiP·fps·scanMsg·야간·디버그 패널 | 200줄 |
| tts.js | TTS 전담 (진행과정·순환문구·신호 안내) | 80줄 |
| recorder.js | MediaRecorder 녹화·다운로드 | 60줄 |
| settings.js | cfg 객체·readConfig | 15줄 |
| detector.js | WebSocket 연결·send·receive | 110줄 |
| detector.yolo.js | YOLOv8s 로드·Letterbox·추론·NMS | 140줄 |
| renderer.js | drawBoxes·renderCards | 100줄 |
| fullscreen.js | 전체화면 초해상도 렌더·열기·닫기 | 120줄 |
| api.js | V2X 진단 GPS·방향·서버 통신·UI 갱신 | 120줄 |

### 역할 분리 원칙

- index.html — 구조와 Tailwind 클래스만. 인라인 스타일 금지.
- style.css — Tailwind 불가 항목만 (토글 스위치, PiP, 스캔라인 등).
- app.js — 모듈 조합 진입점. 이벤트 등록만.
- camera.js — 카메라·스캔루프·ROI 처리·야간 감지·색상 추정 전담.
- ui.js — DOM 조작 전담. showDebug DOM 유일 소유. 디버그 패널 포함.
- tts.js — DOM 접근 금지. speechSynthesis 만 사용.
- recorder.js — MediaRecorder 전담. fs-rec-badge DOM만 접근 허용.
- settings.js — cfg 객체와 readConfig() 만. 다른 DOM 접근 금지.
- detector.js — WebSocket 전담. DOM 접근 금지 (디버그 콜백으로 위임).
- detector.yolo.js — YOLOv8s 전용. DOM 접근 완전 금지.
- renderer.js — 그리기만. onEmpty 콜백으로 빈 상태 위임.
- fullscreen.js — 전체화면 렌더 전담. ttsSignal · getNightMode 사용 허용.
- api.js — V2X 진단 전담. Kakao SDK 의존. DOM 직접 조작 허용 (독립 페이지).

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
| 엔드포인트 | wss://supply.klueware.com/ws |
| 전송 포맷 | JPEG ArrayBuffer (ROI별 품질 가변) |
| 수신 포맷 | JSON { signals: [...], error?: string } |
| 연결 실패 | 3초 후 자동 재연결 |
| 프레임 타임아웃 | 5000ms |
| pending 중 새 프레임 | cancelled 마킹 후 최신 프레임으로 교체 전송 |

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
              │          └─> [fresh 감지] TTS: "보행 신호입니다" 등 → 전체화면 자동 표시
              └─> error
                    TTS: "카메라 권한이 거부되었습니다" 또는 "카메라를 사용할 수 없습니다"
```

---

## TTS 모듈 (tts.js)

### 진행 과정 안내 — ttsPhase(phase)

| phase 값 | 발화 내용 |
|---|---|
| camera-start | "카메라를 시작합니다" |
| connecting | "서버에 연결하는 중입니다" |
| connected | "서버 연결 완료. 탐색을 시작합니다" |
| offline | "서버에 연결할 수 없습니다. 재연결을 시도합니다" |
| reconnecting | "서버 재연결 중입니다" |
| live | "신호등을 탐색 중입니다" |
| error-perm | "카메라 권한이 거부되었습니다..." |
| error-cam | "카메라를 사용할 수 없습니다" |

### 탐색 중 순환 — ttsScanMsg(idx)

화면의 SCAN_MSGS 배열과 동기화. ui.js 의 startScanMsgCycle() 내부에서 호출.

### 신호 감지 안내 — ttsSignal(sig, color) (4초 쿨다운)

| 조건 | 발화 내용 |
|---|---|
| 보행신호 + green | "보행 신호입니다. 건너도 됩니다." |
| 보행신호 + 기타 | "정지 신호입니다. 기다려 주세요." |
| 일반 + green | "녹색 신호등 감지" |
| 일반 + red | "적색 신호등 감지" |
| 일반 + unknown | "신호등 감지됨" |

### TTS 규칙

- tts.js 는 DOM 접근 금지. speechSynthesis 만 사용.
- 쿨다운: 신호 감지 발화만 4초. 진행 과정 발화는 쿨다운 없음.
- speechSynthesis.cancel() 후 새 발화 (이전 발화 중단).
- iOS Safari 대응: visibilitychange 이벤트로 포그라운드 복귀 시 resume() 호출.

---

## 설정 화면 (카메라 시작 전)

카메라 시작 전 별도 설정 페이지 표시. 시작 버튼 클릭 시 readConfig() 로 값 읽기.

| 설정 항목 | 기본값 | DOM ID |
|---|---|---|
| 음성 알림 (TTS) | ON | cfg-tts |
| 디버그 로그 | OFF | cfg-debug |
| 디버그 녹화 | OFF | cfg-rec |

---

## 녹화 모듈 (recorder.js)

- startRecording(stream) — MediaRecorder 시작, 1초 청크
- stopRecording() — 중지 후 .webm 자동 다운로드
- 파일명: debug_{timestamp}.webm
- #fs-rec-badge 표시/숨김 담당 (유일한 DOM 접근)
- 디버그 콜백: setRecorderDebug(fn) 으로 주입

---

## 스캔 루프 흐름

```
매 120ms:
  1. procCtx.drawImage(video)
  2. ROI 3종 순환 (_roiPhase % 3)
       0: 상단 55% 확대 → sharpen(0.4) → JPEG q=0.88  (원거리)
       1: 전체 프레임                   → JPEG q=0.75  (근거리)
       2: 20%~70% 스트립 확대           → JPEG q=0.82  (중간 거리)
  3. roiCanvas.toBlob(q) → ws.send()
  4. 응답 수신 { signals } + 좌표 역변환
  5. flickering 방지: 빈 결과면 _prevSignals 1프레임 유지 (stale 마킹)
       stale 신호는 drawBoxes 에만 사용
       fullscreen·TTS·카드 카운트는 fresh 신호만 처리
  6. tickFps()
  7. updateScanBadge(freshSignals)
  8. drawBoxes(overlay, displaySignals)
  9. freshSignals.length > 0
       → estimateSignalColor(x1, y1, x2, y2)
       → updateFullscreen(sig, color)
       → ttsSignal(sig, color)
  10. renderCards(freshSignals, onTap, showDetEmpty)
  11. drawPip(proc, overlay)
```

### ROI 3종 순환 상세

| phase | 영역 | 확대 | 샤프닝 | JPEG 품질 | 역변환 수식 |
|---|---|---|---|---|---|
| 0 | 상단 0~55% | O | O (str=0.4) | 0.88 | y_orig = y_roi x 0.55 |
| 1 | 전체 0~100% | — | — | 0.75 | y_orig = y_roi x 1.0 |
| 2 | 20%~70% 스트립 | O | — | 0.82 | y_orig = y_roi x 0.50 + 0.20 |

---

## 전체화면 표시 (fullscreen.js)

초해상도 파이프라인: 크롭(2.8배) → 4x 업스케일 → 라플라시안 샤프닝(0.55) → contain 렌더

배경색: green=#001a08 / red=#1a0000 / unknown=#0a0a0a

열기/닫기:
  열기: fs.classList.add('show'), _fsVisible=true
  닫기: fs.classList.remove('show'), _fsVisible=false
  style.display='none' 직접 세팅 금지

---

## 신호등 색상 추정

함수 시그니처:
  export function estimateSignalColor(x1, y1, x2, y2)
  반환값: 'red' | 'green' | 'unknown'

호출 방법:
  const [y1, x1, y2, x2] = sig.box;
  const color = estimateSignalColor(x1, y1, x2, y2);
  [중요] box 배열을 직접 전달하지 말 것

판정 로직 (HSV 기반 3단 분석):
  상단(0~33%): 빨간불  Hue<25||>335, S>0.3, V>0.3
  중단(33~66%): 초록불  Hue 100~185, S>0.25, V>0.3
  하단(66~100%): 숫자판 초록  Hue 100~185, S>0.2, V>0.3
  우선순위: green(중·하단) > red(상단) > unknown

---

## V2X 진단 모드 (api.html / api.js)

### 주요 흐름

```
[진단 시작 버튼]
  1. DeviceOrientation 권한 요청 (iOS, 사용자 제스처 직후)
  2. deviceorientation 이벤트 등록 → userHeading 갱신
  3. GPS watchPosition 시작 → userPos + 카카오 역지오코딩
  4. scheduleFetch() — 2초마다 V2X API 호출 (setTimeout 체인)
```

### API 요청 조건

  userHeading 초기값은 null — 0(정북)과 미수신을 구별
  if (userPos.lat === null || userHeading === null) return;

### V2X API

  GET https://iot.klueware.com/api/v1/front-signal?lat=&lng=&heading=
  Header: X-API-KEY: {AUTH_KEY}
  응답 성공: { itstNm, phase('green'|'red'), remainSec }

### updateSignalUI

  서버 phase='green' → 타이머 초록, "보행 신호" 표시
  서버 phase='red'   → 타이머 빨강, "정지 신호" 표시
  매칭 없음/에러    → resetSignalUI() 호출

### 스케줄링

  setInterval 사용 금지 — scheduleFetch() (setTimeout 체인) 사용
  응답 완료 후 2초 뒤 다음 요청

---

## 핵심 상수

```
camera.js:   SCAN_MS=120, NIGHT_THR=60, ROI_JPEG_Q=[0.88,0.75,0.82], ROI_SHARPEN=0.4
fullscreen.js: FS_PAD=2.8, FS_SCALE=4, FS_SHARP=0.55
ui.js:       PIP_SM={w:120,h:80}, PIP_LG={w:200,h:130}
tts.js:      TTS_COOLDOWN_MS=4000, TTS_RATE=1.05, TTS_LANG='ko-KR'
detector.js: WS_URL='wss://supply.klueware.com/ws', JPEG_Q=0.75, WS_TIMEOUT=12000
api.js:      FETCH_INTERVAL_MS=2000
```

---

## PiP

위치: 카메라 뷰 좌하단 (left:8px, bottom:8px)
기본 크기: 120x80px / 확대: 200x130px (탭 토글)
내용: proc + overlay 합성
테두리: 탐색중=#3b82f6 / 감지됨=#00ee44
갱신: 스캔 루프 마지막 drawPip(proc, overlay) 호출

---

## Canvas / Context 규칙

procCtx = proc.getContext('2d', { willReadFrequently: true })  // camera.js 에서만
pipCtx  = pip.getContext('2d')                                  // ui.js 에서만
overlay context: 매번 getContext('2d') — willReadFrequently 불필요
proc.getContext('2d') 직접 호출 금지 — procCtx 재사용
fullscreen.js 중간 캔버스(mid): 매번 createElement, 재사용 금지
_sharpen() 버퍼: Uint8ClampedArray 직접 사용 — 캔버스 추가 생성 금지

---

## 인터벌 관리

scanTimer     — camera.js, setTimeout 기반, clearTimeout
nightTimer    — camera.js, setInterval 기반, clearInterval
_scanMsgTimer — ui.js, setInterval 기반, clearInterval
fetchTimer    — api.js, setTimeout 체인, clearTimeout (setInterval 사용 금지)

---

## 야간 모드

3초마다 평균 밝기 < 60 → 자동 전환
버튼: 야간(OFF) / ON(ON)
전체화면 야간: brightness(1.5) contrast(1.3) saturate(1.2)

---

## 개발 규칙 (체크리스트)

- 이모지 금지
- localStorage/sessionStorage 금지
- style.css 에는 Tailwind 불가 스타일만
- @latest CDN 금지
- 파일당 라인 수 상한 준수
- #fs 닫기 시 style.display='none' 직접 세팅 금지
- proc.getContext('2d') 직접 호출 금지
- api.html 에 Kakao SDK·api.js 스크립트 태그 각 1개만
- estimateSignalColor 인자: (x1,y1,x2,y2) 좌표 4개 (box 배열 전달 금지)
- userHeading 초기값 null — 0(정북) 과 미수신 구별
- stale 신호는 drawBoxes 에만 사용, fullscreen·TTS·카드 카운트 전달 금지
- detector.js·detector.yolo.js DOM 접근 완전 금지
- tts.js DOM 접근 완전 금지
- recorder.js 는 #fs-rec-badge 외 DOM 접근 금지
- TTS 진행 과정: 쿨다운 없음 / 신호 감지: 4초 쿨다운
- drawPip(proc, overlay) 는 스캔 루프 마지막에만
- det-empty 텍스트는 .scan-msg-text span만 변경
- ROI 역변환은 camera.js 스캔 루프 내에서만
- api.js fetchTimer: setInterval 금지, setTimeout 체인 사용

---

## 향후 로드맵

- [ ] 신호등 색상 판별 정확도 개선 (픽셀 샘플링 → 서버 측 색상 분류)
- [ ] 카운트다운 타이머
- [ ] AI-Hub 데이터셋 기반 YOLOv8s fine-tuning
- [ ] PWA Service Worker
- [ ] 접근성: 고대비 모드, 폰트 크기 설정
- [ ] TTS 속도·음량 사용자 조절
- [ ] WebGL 기반 초해상도 (현재 Canvas 2D 라플라시안 → GPU 가속)
- [ ] ROI phase별 서버 응답 신뢰도 통계 수집 → 동적 품질 조정
- [ ] AUTH_KEY 서버 프록시 경유 (클라이언트 노출 제거)
- [ ] PERSON_SVG 상수 제거 (전체화면에서 사람 아이콘 제거 완료)
