# CLAUDE.md — 보행 신호 알리미

## 프로젝트 개요

길 건너편 보행 신호등을 실시간으로 감지하고 전체화면으로 확대하여
저시력자가 신호를 쉽고 빠르게 확인할 수 있도록 돕는 웹 앱.

배포 주소: https://mirnet96.github.io/traffic-light

---

## 1차 목표 (최우선)

- 카메라로 2~10차선 건너편 보행 신호등 자동 감지 (근거리 + 원거리)
- 감지된 신호등을 전체화면으로 확대 표시
- 정지 / 보행 상태를 크고 명확하게 표시

---

## 기술 스택

| 분류 | 선택 |
|---|---|
| 마크업 | HTML5 |
| 스타일 | Tailwind CSS (CDN) + style.css (커스텀 보완) |
| 아이콘 | Google Material Symbols Rounded (FILL=1) |
| ML 1차 | MediaPipe EfficientDet-Lite2 (빠름) |
| ML 2차 | YOLOv8s TF.js (정밀, 폴백) |
| 모듈 시스템 | ES Module (import/export) |
| 카메라 | `getUserMedia` API (HTTPS 필수) |
| 배포 | GitHub Pages |

---

## CDN 출처 (허용 목록)

```
https://cdn.tailwindcss.com
https://fonts.googleapis.com
https://cdn.jsdelivr.net
https://storage.googleapis.com/mediapipe-models
```

---

## 파일 구조

```
traffic-light/
├── index.html
├── style.css
├── app.js
├── detector.js
├── detector.mediapipe.js
├── detector.yolo.js
├── renderer.js
├── README.md
└── CLAUDE.md
```

### 파일별 역할 및 라인 수 기준

| 파일 | 역할 | 상한 |
|---|---|---|
| `app.js` | UI · 카메라 · 스캔 루프 · 야간 · 전체화면 · PiP · fps · 텍스트 순환 · 이벤트 | 300줄 |
| `detector.js` | 폴백 체인 · `classifySignals` · `iou` | 80줄 |
| `detector.mediapipe.js` | MediaPipe 로드 · 추론 · 출력 파싱 | 100줄 |
| `detector.yolo.js` | YOLOv8s 로드 · Letterbox · 추론 · NMS | 130줄 |
| `renderer.js` | `drawBoxes` · `renderCards` | 100줄 |

### 역할 분리 원칙

- `index.html` — 구조와 Tailwind 클래스만. 인라인 스타일 금지.
- `style.css` — Tailwind 불가 항목만.
- `detector.mediapipe.js` — MediaPipe 전용. DOM 접근 금지.
- `detector.yolo.js` — YOLOv8s 전용. DOM 접근 금지.
- `detector.js` — 두 감지 모듈 조율만.
- `renderer.js` — 그리기만.
- `app.js` — 위 모듈 조합 진입점. 300줄 이하 유지.

---

## 감지 모델: 폴백 체인 구조

```
매 프레임 (120ms)
  └─> 1차: MediaPipe EfficientDet-Lite2
        ├─> score >= 0.50 → classifySignals → 반환
        └─> 미감지 / 저신뢰도
              └─> 2차: YOLOv8s → NMS → classifySignals → 반환
```

### 모델 URL

```
https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/1/efficientdet_lite2.tflite
https://cdn.jsdelivr.net/gh/niconielsen32/ultralytics-tfjs/yolov8s_web_model/model.json
```

---

## 근거리 / 원거리 구분

| 구분 | 기준 | YOLOv8s 최소 신뢰도 |
|---|---|---|
| 근거리 | 박스 높이 >= 12% | 0.45 |
| 원거리 | 2% ~ 12% | 0.28 |
| 무효 | < 2% | 버림 |

---

## 보행 신호등 판별

```js
const hasPerson = persons.some(p => iou(l.box, p.box) > 0.1);
// → isPedestrian: true, priority: 2
```

---

## 핵심 상수

```js
// app.js
SCAN_MS   = 120        // 감지 루프 최소 대기 (ms) — setTimeout 재귀
NIGHT_THR = 60
PROC_W    = 448        // 추론용 축소 캔버스 너비
PROC_H    = 448        // 추론용 축소 캔버스 높이
PIP_SM    = { w:120, h:80  }
PIP_LG    = { w:200, h:130 }
SCAN_MSGS = [...]

// detector.mediapipe.js
delegate     = 'CPU'   // GPU 위임 사용 금지 (모바일 GPU 위임 실패 방지)
maxResults   = 5

// detector.js
MP_THRESHOLD = 0.50
MP_ANY_MIN   = 0.25
```

## 추론용 캔버스 구조

```
video (원본 1280×720)
  ├── proc (원본 크기) — PiP 합성, 야간 측광용
  └── small (448×448) — MediaPipe / YOLO 추론 입력용
```

- `runYolo(small, W, H)` 로 호출 — canvas는 축소본, W/H는 원본 해상도
- 좌표 정규화(0~1)는 원본 W/H 기준이므로 박스 위치 정확도 유지
- `small`은 모듈 상단에서 한 번 생성 후 재사용 (매 프레임 createElement 금지)

---

## 앱 상태 흐름

```
init
  └─> loading (카메라 권한 → loadModel)
        ├─> live  (스캔 루프 120ms · 야간 3s · PiP · fps · 텍스트 순환)
        └─> error
```

`setPhase('live')`는 반드시 `loadModel()` 완료 후 호출.

---

## fps 측정

스캔 루프 매 실행마다 `tickFps()` 호출. 1초마다 `fpsValue` 갱신.

```js
let fpsFrames   = 0;
let fpsLastTime = 0;  // performance.now() 기준
let fpsValue    = 0;

function tickFps() {
  fpsFrames++;
  const diff = performance.now() - fpsLastTime;
  if (diff >= 1000) {
    fpsValue    = Math.round(fpsFrames * 1000 / diff);
    fpsFrames   = 0;
    fpsLastTime = performance.now();
    // 탐색 중일 때만 badge-scan 갱신 (감지 중 덮어쓰기 금지)
    if (!scanBadge.classList.contains('detected'))
      scanBadge.textContent = `탐색 중 · ${fpsValue}fps`;
  }
}
```

fps는 두 곳에 표시:
- `badge-scan`: `탐색 중 · Nfps`
- PiP 우하단 오버레이: `Nfps`

---

## 탐색 중 텍스트 순환

신호등 미감지 상태에서 하단바 `det-empty` 텍스트를 3.5초마다 교체.

```js
const SCAN_MSGS = [
  '신호등을 탐색 중입니다...',
  '카메라를 신호등 방향으로 향해 주세요',
  '건너편 신호등을 찾고 있습니다...',
  '멀리 있는 신호등도 감지합니다',
];
```

### 구현 규칙

- `startScanMsgCycle()`: `setPhase('live')` 시 호출, 인터벌 시작
- `stopScanMsgCycle()`: `setPhase` 에서 live가 아닐 때 호출, 인터벌 정리
- 감지 중(`det-empty` 숨김 상태)에는 텍스트 교체 건너뜀
- 텍스트 교체 시 opacity 0 → 400ms → opacity 1 페이드 효과
- `det-empty` 안에 `<span class="scan-msg-text">` 필수 — JS에서 이 span의 textContent만 변경

```html
<div id="det-empty" ...>
  <span class="material-symbols-rounded ...">radar</span>
  <span class="scan-msg-text">신호등을 탐색 중입니다...</span>
</div>
```

---

## PiP (Picture-in-Picture) 스캔 미리보기

| 항목 | 내용 |
|---|---|
| 위치 | 카메라 뷰 좌하단 (left:8px, bottom:8px) |
| 기본 크기 | 120×80px |
| 확대 크기 | 200×130px (탭 토글) |
| 내용 | proc + overlay 합성 |
| 좌상단 라벨 | `탐색중` / `감지됨` |
| 우하단 라벨 | `Nfps` |
| 테두리 색 | 탐색 중: `#3b82f6` / 감지됨: `#00ee44` |
| 갱신 | 스캔 루프 마지막 `drawPip()` 호출 |

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
// 열기
fs.style.display = '';
fs.classList.add('show');
// 닫기
fs.classList.remove('show');
// style.display = 'none' 직접 세팅 금지
```

---

## Canvas / Context 규칙

```js
const procCtx = proc.getContext('2d', { willReadFrequently: true }); // 필수
const pipCtx  = pip.getContext('2d');  // willReadFrequently 불필요
// overlay/proc 크기: 해상도 변경 시에만 재설정
if (W !== lastVW || H !== lastVH) { ... }
```

---

## 인터벌 관리

```js
let scanTimer    = null;  // startScan()
let nightTimer   = null;  // startNightCheck()
let scanMsgTimer = null;  // startScanMsgCycle()
// 각 함수 첫 줄에서 clearInterval 후 재생성
```

---

## Tensor 해제 (detector.yolo.js)

```js
const outTensor = Array.isArray(raw) ? raw[0] : raw;
const data = await outTensor.data();
tf.dispose(tensor);
if (Array.isArray(raw)) tf.dispose(raw); else tf.dispose(raw);
```

---

## MediaPipe 타임스탬프

```js
mpDetector.detectForVideo(canvas, performance.now()); // 정수 카운터 금지
```

---

## renderCards 클로저

```js
const snapshot = signals.slice();
list.querySelectorAll('.det-card').forEach(el =>
  el.addEventListener('click', () => onTap(snapshot[+el.dataset.i]))
);
// list._sigs 패턴 금지
```

---

## 야간 모드

- 3초마다 `procCtx.getImageData` 평균 밝기 < 60 → 자동 전환
- 버튼: `야간` (OFF) / `ON` (ON)

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
- 인터벌 변수 없이 `setInterval` 직접 호출 금지
- `drawPip()`은 스캔 루프 마지막에만 호출
- `det-empty` 텍스트는 `.scan-msg-text` span만 변경

---

## 향후 로드맵

- [ ] TTS 음성 안내
- [ ] 카운트다운 타이머
- [ ] AI-Hub 데이터셋 기반 YOLOv8s fine-tuning
- [ ] PWA Service Worker
- [ ] 접근성: 고대비 모드, 폰트 크기 설정
