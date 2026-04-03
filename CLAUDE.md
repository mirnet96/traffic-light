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
https://fonts.googleapis.com                     (Material Symbols)
https://cdn.jsdelivr.net                         (TensorFlow.js, YOLOv8s, MediaPipe)
https://storage.googleapis.com/mediapipe-models  (EfficientDet-Lite2 모델)
```

---

## 파일 구조

```
traffic-light/
├── index.html              — 구조 (DOM), TF.js CDN, app.js 진입점
├── style.css               — 커스텀 스타일 (Tailwind 보완)
├── app.js                  — UI · 카메라 · 스캔 루프 · 전체화면 · 이벤트
├── detector.js             — 폴백 체인 진입점 · classifySignals · iou
├── detector.mediapipe.js   — MediaPipe EfficientDet-Lite2 로드 · 추론 · 파싱
├── detector.yolo.js        — YOLOv8s 로드 · Letterbox · 추론 · NMS
├── renderer.js             — 오버레이 박스 · 하단 카드 렌더
├── README.md
└── CLAUDE.md
```

### 스크립트 로드 방식

```html
<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js"></script>
<script type="module" src="app.js"></script>
```

### 파일별 역할 및 라인 수 기준

| 파일 | 역할 | 상한 |
|---|---|---|
| `app.js` | UI · 카메라 · 스캔 루프 · 야간 · 전체화면 · PiP · 이벤트 | 300줄 |
| `detector.js` | 폴백 체인 · `classifySignals` · `iou` | 80줄 |
| `detector.mediapipe.js` | MediaPipe 로드 · 추론 · 출력 파싱 | 100줄 |
| `detector.yolo.js` | YOLOv8s 로드 · Letterbox · 추론 · NMS | 130줄 |
| `renderer.js` | `drawBoxes` · `renderCards` | 100줄 |

### 역할 분리 원칙

- `index.html`            — 구조와 Tailwind 클래스만. 인라인 스타일 금지.
- `style.css`             — Tailwind 불가 항목만 (애니메이션, 필터 등).
- `detector.mediapipe.js` — MediaPipe 전용. DOM 접근 금지.
- `detector.yolo.js`      — YOLOv8s 전용. DOM 접근 금지.
- `detector.js`           — 두 감지 모듈 조율만. 추론 로직 포함 금지.
- `renderer.js`           — 그리기만. 추론 로직 포함 금지.
- `app.js`                — 위 모듈 조합 진입점. 300줄 이하 유지.

---

## 감지 모델: 폴백 체인 구조

### 동작 흐름

```
매 프레임 (120ms)
  └─> 1차: MediaPipe EfficientDet-Lite2
        ├─> traffic light score >= 0.50 → classifySignals → 반환
        └─> 미감지 / 저신뢰도
              └─> 2차: YOLOv8s Letterbox → [1,640,640,3] → 추론 → NMS
                    └─> classifySignals → 반환
```

### 모델 비교

| 항목 | MediaPipe EfficientDet-Lite2 | YOLOv8s TF.js |
|---|---|---|
| 역할 | 1차 (빠른 감지) | 2차 폴백 (정밀 감지) |
| 입력 해상도 | 448×448 | 640×640 |
| 모델 크기 | 7MB | 22MB |
| 추론 속도 (모바일) | ~40ms | ~180ms |
| COCO mAP | 35.8 | 44.9 |
| 전처리 / NMS | 내장 | 직접 구현 |

### 모델 URL

```
# MediaPipe EfficientDet-Lite2 (고정 버전)
https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/1/efficientdet_lite2.tflite

# YOLOv8s TF.js (고정 버전)
https://cdn.jsdelivr.net/gh/niconielsen32/ultralytics-tfjs/yolov8s_web_model/model.json
```

### 폴백 판단 기준

```js
const MP_THRESHOLD = 0.50;
```

---

## 근거리 / 원거리 구분

| 구분 | 기준 (박스 높이 / 화면 높이) | YOLOv8s 최소 신뢰도 |
|---|---|---|
| 근거리 | >= 12% | 0.45 |
| 원거리 | 2% ~ 12% | 0.28 |
| 무효 | < 2% | 버림 |

---

## 보행 신호등 판별 로직

```js
const hasPerson = persons.some(p => iou(l.box, p.box) > 0.1);
// → isPedestrian: true, priority: 2
```

---

## 핵심 상수

```js
// app.js
SCAN_MS      = 120     // 감지 루프 주기 (ms)
NIGHT_THR    = 60      // 야간 전환 밝기 기준 (0~255)
PIP_SM       = { w: 120, h: 80  }   // PiP 기본 크기
PIP_LG       = { w: 200, h: 130 }   // PiP 확대 크기

// detector.js
MP_THRESHOLD = 0.50

// detector.yolo.js
NEAR_THR     = 0.12
FAR_MIN      = 0.02
SCORE_NEAR   = 0.45
SCORE_FAR    = 0.28
NMS_IOU      = 0.45
```

---

## 앱 상태 흐름

```
init
  └─> loading (카메라 권한 → MediaPipe 로드 → YOLOv8s 로드 + 워밍업)
        ├─> live  (스캔 루프 120ms + 야간 감지 3s + PiP)
        └─> error (권한 거부 / 하드웨어 오류)
```

`setPhase('live')`는 반드시 `loadModel()` 완료 후 호출.

---

## PiP (Picture-in-Picture) 스캔 미리보기

카메라 뷰 좌하단에 실시간 스캔 영역을 축소 표시.

### 구조

```
viewbox 내부 — position: absolute, left: 8px, bottom: 8px
<canvas id="pip" class="pip-canvas">
```

### 동작

| 항목 | 내용 |
|---|---|
| 기본 크기 | 120×80px |
| 확대 크기 | 200×130px (탭으로 토글) |
| 표시 조건 | `phase === 'live'` 일 때만 |
| 내용 | proc canvas(카메라 원본) + overlay(감지 박스) 합성 |
| 테두리 | 탐색 중: 파란색 / 감지됨: 초록색 |
| 좌상단 라벨 | `탐색중` / `감지됨` |
| 갱신 주기 | 스캔 루프와 동일 (120ms) |

### drawPip() 구현 원칙

```js
// 1. 카메라 원본 축소 합성
pipCtx.drawImage(proc, 0, 0, sz.w, sz.h);
// 2. 감지 박스 오버레이 합성
pipCtx.drawImage(overlay, 0, 0, sz.w, sz.h);
// 3. 테두리 + 라벨 그리기
```

- `drawPip()`은 `startScan()` 루프 마지막에 호출
- `phase !== 'live'` 또는 `proc.width === 0`이면 즉시 리턴
- PiP canvas의 `willReadFrequently` 옵션은 불필요 (쓰기 전용)

### 크기 토글

```js
// pip 탭 이벤트
pipLarge = !pipLarge;
applyPipSize();  // pip.width / pip.height 재설정
```

`applyPipSize()`는 `setPhase('live')` 진입 시에도 호출하여 초기 크기 보장.

---

## 상태 표시 (badge-ai / badge-scan)

| 배지 | 위치 | 내용 |
|---|---|---|
| `badge-ai` | topbar | `MP + YOLO` / `MediaPipe` / `YOLOv8s` / `모델 오류` / `스캔 오류` |
| `badge-scan` | topbar (live 전용) | `탐색 중` (파란 깜빡임) / `감지 N건` (초록 고정) |

- `badge-scan` 표시: `style.display = ''` / 숨김: `style.display = 'none'`
- Tailwind `hidden` 클래스와 혼용 금지

---

## Topbar 레이아웃 규칙

- 앱 이름: `whitespace-nowrap`
- 배지·버튼 전체: `whitespace-nowrap shrink-0`
- 빈 공간: `<div class="flex-1">`
- 야간 버튼 텍스트: `야간` (OFF) / `ON` (ON)
- 카메라 전환 버튼: 아이콘만 (`w-8 h-8`)

---

## 전체화면 열기/닫기 규칙

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
// proc — willReadFrequently 필수 (getImageData 매 프레임 호출)
const procCtx = proc.getContext('2d', { willReadFrequently: true });

// pip — 쓰기 전용, willReadFrequently 불필요
const pipCtx = pip.getContext('2d');

// overlay/proc 크기 — 해상도 변경 시에만 재설정
if (W !== lastVW || H !== lastVH) { ... }
```

---

## 인터벌 관리 규칙

```js
let scanTimer  = null;
let nightTimer = null;

clearInterval(scanTimer);
scanTimer = setInterval(...);
```

---

## Tensor 해제 규칙 (detector.yolo.js)

```js
const outTensor = Array.isArray(raw) ? raw[0] : raw;
const data = await outTensor.data();
tf.dispose(tensor);
if (Array.isArray(raw)) tf.dispose(raw); else tf.dispose(raw);
```

---

## MediaPipe 타임스탬프 규칙

```js
mpDetector.detectForVideo(canvas, performance.now());
// 정수 카운터 사용 금지
```

---

## renderCards 클로저 규칙

```js
const snapshot = signals.slice();
list.querySelectorAll('.det-card').forEach(el =>
  el.addEventListener('click', () => onTap(snapshot[+el.dataset.i]))
);
// list._sigs 패턴 사용 금지
```

---

## 야간 모드

- 3초마다 `procCtx.getImageData`로 평균 밝기 측정
- 60 미만 → 자동 야간 전환
- 버튼 텍스트: `야간` (OFF) / `ON` (ON)

---

## UI 아이콘 (Material Symbols Rounded)

이모지 사용 금지.

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
- `style.css` 에는 Tailwind 불가 스타일만 작성
- `@latest` CDN 버전 사용 금지
- 파일당 라인 수 상한 준수
- topbar 아이템 한 줄 유지
- `#fs` 닫기 시 `style.display = 'none'` 직접 세팅 금지
- `proc.getContext('2d')` 직접 호출 금지 — `procCtx` 재사용
- 인터벌 변수 없이 `setInterval` 직접 호출 금지
- PiP `drawPip()`은 스캔 루프 마지막에만 호출 (중복 호출 금지)

---

## 향후 로드맵

- [ ] TTS 음성 안내
- [ ] 카운트다운 타이머
- [ ] AI-Hub 데이터셋 기반 YOLOv8s fine-tuning
- [ ] PWA Service Worker
- [ ] 접근성: 고대비 모드, 폰트 크기 설정
