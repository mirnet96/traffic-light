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
<!-- index.html -->
<script src="tf.min.js"></script>            <!-- TF.js (전역 window.tf) -->
<script type="module" src="app.js"></script> <!-- ES Module 진입점 -->
```

```js
// app.js
import { loadModel, runYolo }     from './detector.js';
import { drawBoxes, renderCards } from './renderer.js';

// detector.js
import { loadMediaPipe, runMediaPipeDetect } from './detector.mediapipe.js';
import { loadYolo, runYoloDetect }           from './detector.yolo.js';
```

- `index.html`에서 `<script type="module" src="app.js">` **하나만** 로드
- import 체인으로 로드 순서 자동 보장
- MediaPipe는 `detector.mediapipe.js` 내부에서 동적 `import(MP_CDN)` 처리

### 파일별 역할 및 라인 수 기준

| 파일 | 역할 | 상한 |
|---|---|---|
| `app.js` | UI · 카메라 · 스캔 루프 · 야간 · 전체화면 · 이벤트 | 300줄 |
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
const MP_THRESHOLD = 0.50;  // 이 값 미만이면 YOLOv8s 폴백
```

### 감지 출처 태그

```js
src: 'mp'    // MediaPipe 감지
src: 'yolo'  // YOLOv8s 감지
```

하단 카드에 `MP` / `YOLO` 배지로 표시.

---

## 근거리 / 원거리 구분

박스 높이(정규화) 기준으로 동적 신뢰도 임계값 적용.

| 구분 | 기준 (박스 높이 / 화면 높이) | YOLOv8s 최소 신뢰도 |
|---|---|---|
| 근거리 | >= 12% | 0.45 |
| 원거리 | 2% ~ 12% | 0.28 |
| 무효 | < 2% | 버림 |

---

## 보행 신호등 판별 로직

```js
// traffic light 박스 안에 person 박스가 IoU > 0.1 이상 겹치면
// → 보행 신호등 (isPedestrian: true, priority: 2)
const hasPerson = persons.some(p => iou(l.box, p.box) > 0.1);
```

---

## 핵심 상수

```js
// app.js
SCAN_MS      = 120     // 감지 루프 주기 (ms)
NIGHT_THR    = 60      // 야간 전환 밝기 기준 (0~255)

// detector.js
MP_THRESHOLD = 0.50    // MediaPipe → YOLOv8s 폴백 임계값

// detector.yolo.js
NEAR_THR     = 0.12    // 근거리 기준 박스 높이 비율
FAR_MIN      = 0.02    // 최소 유효 박스 크기
SCORE_NEAR   = 0.45    // 근거리 최소 신뢰도
SCORE_FAR    = 0.28    // 원거리 최소 신뢰도
NMS_IOU      = 0.45    // NMS IoU 임계값
```

---

## 앱 상태 흐름

```
init
  └─> loading (카메라 권한 → MediaPipe 로드 → YOLOv8s 로드 + 워밍업)
        ├─> live  (스캔 루프 120ms + 야간 감지 3s)
        └─> error (권한 거부 / 하드웨어 오류)
```

## 상태 표시 (badge-ai / badge-scan)

| 배지 | 위치 | 내용 |
|---|---|---|
| `badge-ai` | topbar | 모델 로드 상태: `MP + YOLO` / `MediaPipe` / `YOLOv8s` / `모델 오류` / `스캔 오류` |
| `badge-scan` | topbar (live 전용) | `탐색 중` (파란 깜빡임) / `감지 N건` (초록 고정) |

- `badge-scan`은 `setPhase('live')` 시 표시, 그 외 숨김
- 스캔 루프 예외 발생 시 `badge-ai`에 `스캔 오류` 표시

---

## 야간 모드

- 3초마다 프레임 평균 밝기 자동 측정 → 60 미만이면 자동 전환
- 수동 토글 버튼: `dark_mode` ↔ `light_mode` 아이콘
- 버튼 텍스트: 야간 OFF → `야간` / 야간 ON → `ON` (topbar 공간 절약)
- CSS 클래스로 제어: `#video.night` / `#video.day`

```css
#video.night { filter: brightness(1.6) contrast(1.4) saturate(1.3); }
#video.day   { filter: brightness(1.05) contrast(1.1) saturate(1.1); }
```

---

## Topbar 레이아웃 규칙

모바일 소형 화면에서 topbar가 줄바꿈되지 않도록:

- 앱 이름: `whitespace-nowrap`
- 배지·버튼 전체: `whitespace-nowrap shrink-0`
- 빈 공간: `<div class="flex-1">` 으로 배지/버튼을 우측 정렬
- 야간 버튼 텍스트: `야간` (OFF 상태) / `ON` (ON 상태) — 짧게 유지
- 카메라 전환 버튼: 텍스트 없이 아이콘만 (`w-8 h-8`)

---

## 전체화면 확대 규격

- 배경: 보행 신호 `#001a08` / 일반 신호등 `#1a1500`
- 원형: `min(72vw, 72vh)` + 글로우
- 텍스트: `min(14vw, 14vh)`
- 거리 정보: 근거리 / 원거리 표시
- 진동: 보행 `[200]` / 일반 `[100, 50, 100]`
- 닫기: 화면 아무 곳 탭

---

## UI 아이콘 (Material Symbols Rounded)

이모지 사용 금지. Material Symbols만 사용.

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

## 초기 화면 신호등

2구 보행 신호등 SVG. 상단: 빨간 정지 아이콘 (켜진 상태), 하단: 초록 꺼진 상태.

---

## 개발 규칙

- 이모지 사용 금지 — 아이콘은 Material Symbols만
- `localStorage` / `sessionStorage` 사용 금지 — 상태는 JS 변수로 관리
- `style.css` 에는 Tailwind 불가 스타일만 작성
- 카메라는 HTTPS 환경 필수 (`localhost` 예외)
- 외부 리소스는 위 CDN 허용 목록에서만 로드
- 색상 감지 (RGB 픽셀 평균) 로직 재도입 금지
- `@latest` CDN 버전 사용 금지 — 항상 고정 버전 명시
- 파일당 라인 수 상한 준수 (위 표 참고)
- topbar 아이템은 한 줄 유지 — `whitespace-nowrap` / `shrink-0` 필수

---

## 향후 로드맵

- [ ] TTS 음성 안내 ("보행 신호입니다, 건너셔도 됩니다")
- [ ] 카운트다운 타이머 (남은 보행 시간)
- [ ] AI-Hub 인도보행 데이터셋 기반 YOLOv8s fine-tuning
- [ ] PWA Service Worker (오프라인 캐싱)
- [ ] 접근성: 고대비 모드, 폰트 크기 설정
