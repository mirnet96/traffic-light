# CLAUDE.md — 저시력자용 보행 신호등 확대기

## 프로젝트 개요

길 건너편 보행 신호등을 실시간으로 감지하고 전체화면으로 확대하여
저시력자가 신호를 쉽게 식별할 수 있도록 돕는 웹/모바일 앱.

배포 주소: https://mirnet96.github.io/traffic-light

---

## 1차 목표 (최우선)

- 카메라로 2~10차선 건너편 신호등 자동 감지 (근거리 + 원거리)
- 보행 신호등 우선 감지 및 전체화면 확대
- 정지 / 보행 상태를 크고 명확하게 표시

---

## 기술 스택

| 분류 | 선택 |
|---|---|
| 마크업 | HTML5 |
| 스타일 | Tailwind CSS (CDN) + style.css (커스텀 보완) |
| 아이콘 | Google Material Symbols Rounded (FILL=1) |
| ML 감지 | TensorFlow.js 4.17.0 — **YOLOv8n** |
| 카메라 | `getUserMedia` API (HTTPS 필수) |
| 배포 | GitHub Pages |

### CDN 출처 (허용 목록)

```
https://cdn.tailwindcss.com
https://fonts.googleapis.com        (Material Symbols)
https://cdn.jsdelivr.net            (TensorFlow.js, YOLOv8n 모델)
```

---

## 모델: YOLOv8n TFJS

### SSD MobileNet v2 → YOLOv8n 교체 이유

| 항목 | SSD MobileNet v2 (이전) | YOLOv8n (현재) |
|---|---|---|
| 모델 크기 | 67MB | 6MB |
| 원거리 소형 객체 | 약함 | 강함 |
| 추론 속도 | 보통 | 빠름 |
| 입력 해상도 | 300×300 | 640×640 |
| 보행 신호등 특화 | 없음 | NMS + 보행자 결합 판별 |

### 모델 URL

```
https://cdn.jsdelivr.net/gh/niconielsen32/ultralytics-tfjs/yolov8n_web_model/model.json
```

### 입력 전처리 (Letterbox)

원본 프레임 → 640×640 letterbox 리사이즈 → float32 정규화 (÷255)

- 회색(#808080) 패딩으로 비율 유지
- `scaleX`, `scaleY`, `padX`, `padY` 역변환으로 원본 좌표 복원

### 출력 파싱

YOLOv8n 출력 shape: `[1, 84, 8400]`

- `[0~3]` × 8400 → cx, cy, w, h (640 공간)
- `[4~83]` × 8400 → 80개 COCO 클래스 점수
- 사용 클래스: `9` (traffic light), `0` (person)

---

## 감지 파이프라인

```
카메라 프레임 (120ms 간격)
  └─> Letterbox 전처리 → [1, 640, 640, 3]
        └─> YOLOv8n 추론
              └─> traffic light (class 9) + person (class 0) 추출
                    └─> 근거리 / 원거리 분류
                          └─> NMS (IoU 0.45)
                                └─> 보행 신호등 판별 (신호등 + 보행자 겹침)
                                      └─> 전체화면 확대
```

### 색상 감지 제거 이유

픽셀 RGB 평균 방식은 역광·야간·소형 신호등 환경에서 오판 빈도가 높아 제거.
대신 YOLOv8n의 객체 위치 + person 클래스 겹침으로 보행 신호 여부를 판별.

---

## 근거리 / 원거리 구분

박스 높이(정규화)를 기준으로 동적 신뢰도 임계값 적용.

| 구분 | 기준 (박스 높이 / 화면 높이) | 최소 신뢰도 |
|---|---|---|
| 근거리 | >= 12% | 0.45 |
| 원거리 | 2% ~ 12% | 0.28 |
| 무효 | < 2% | 버림 |

원거리일수록 임계값을 낮춰 소형 신호등도 감지.

---

## 보행 신호등 판별 로직

```js
// traffic light 박스 안에 person 박스가 IoU > 0.1 이상 겹치면
// → 보행 신호등으로 분류, priority 2 부여 (일반 신호등은 1)
const hasPerson = persons.some(p => iou(light.box, p.box) > 0.1);
```

보행 신호등이 항상 상단에 표시되며, 전체화면 확대 시 우선 노출.

---

## 핵심 상수 (`app.js`)

```js
SCAN_MS      = 120      // 감지 루프 주기 (ms)
NEAR_THR     = 0.12     // 근거리 기준 (박스 높이 비율)
FAR_MIN      = 0.02     // 최소 유효 박스 크기
SCORE_NEAR   = 0.45     // 근거리 최소 신뢰도
SCORE_FAR    = 0.28     // 원거리 최소 신뢰도
NIGHT_THR    = 60       // 야간 전환 밝기 기준 (0~255)
NMS_IOU      = 0.45     // Non-Maximum Suppression IoU 임계값
```

---

## 야간 모드

- 3초마다 프레임 평균 밝기 측정 → 자동 전환
- CSS 클래스: `#video.night` / `#video.day`
- 수동 토글 버튼 제공 (아이콘: `dark_mode` / `light_mode`)

---

## 전체화면 확대 규격

- 보행 신호등: 초록 배경 + 보행자 SVG 아이콘
- 일반 신호등: 노란 배경 + 정지 SVG 아이콘
- 원형 크기: `min(72vw, 72vh)` + 글로우
- 텍스트: `min(14vw, 14vh)`
- 거리 정보 표시: 근거리 / 원거리
- 진동: 보행 신호 `[200]` / 일반 `[100, 50, 100]`

---

## 아이콘 사용 규칙

이모지 사용 금지. Google Material Symbols Rounded만 사용.

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
| 정지 신호 | `do_not_walk` |
| 일반 신호등 | `traffic` |

---

## 앱 상태 흐름

```
init
  └─> loading (카메라 권한 + YOLOv8n 워밍업)
        ├─> live  (스캔 루프 120ms + 야간 감지 3s)
        └─> error (권한 거부 / 하드웨어 오류)
```

---

## 파일 구조

```
traffic-light/
├── index.html     — 구조 (DOM), CDN 로드
├── style.css      — 커스텀 스타일 (Tailwind 보완)
├── detector.js    — YOLOv8n 추론 · NMS · 보행신호 판별
├── renderer.js    — 오버레이 박스 · 하단 카드 렌더
├── app.js         — 카메라 · 스캔 루프 · 전체화면 · 이벤트
├── README.md
└── CLAUDE.md
```

### 스크립트 로드 순서 (`index.html`)

```html
<script src="tf.min.js"></script>   <!-- TensorFlow.js -->
<script src="detector.js"></script> <!-- loadModel, runYolo, classifySignals -->
<script src="renderer.js"></script> <!-- drawBoxes, renderCards -->
<script src="app.js"></script>      <!-- 진입점 — 위 두 모듈 전역 참조 -->
```

app.js가 detector.js · renderer.js의 함수를 전역으로 참조하므로 반드시 마지막에 로드.

### 파일별 역할 및 라인 수 기준

| 파일 | 역할 | 상한 |
|---|---|---|
| `detector.js` | `loadModel` · `runYolo` · `preprocessFrame` · `parseOutput` · `nms` · `classifySignals` | 150줄 |
| `renderer.js` | `drawBoxes` · `renderCards` | 100줄 |
| `app.js` | UI 상태 · 카메라 · 스캔 루프 · 야간 감지 · 전체화면 · 이벤트 | 300줄 |

### 역할 분리 원칙

- `index.html`   — 구조와 Tailwind 유틸리티 클래스만. 인라인 스타일 금지.
- `style.css`    — 애니메이션, 필터, `font-variation-settings` 등 Tailwind 불가 항목만.
- `detector.js`  — 추론 및 감지 순수 로직. DOM 접근 금지.
- `renderer.js`  — 캔버스 그리기 및 카드 HTML 생성. 추론 로직 포함 금지.
- `app.js`       — 위 모듈을 조합하는 진입점. 파일당 300줄 이하 유지.

---

## 향후 로드맵

- [ ] TTS 음성 안내 ("보행 신호입니다, 건너셔도 됩니다")
- [ ] 카운트다운 타이머 (남은 보행 시간)
- [ ] YOLOv8n 보행 신호등 전용 fine-tuning (한국 신호등 데이터셋)
- [ ] PWA Service Worker (오프라인 캐싱)
- [ ] 접근성: 고대비 모드, 폰트 크기 설정

---

## 개발 규칙

- 이모지 사용 금지 — 아이콘은 Material Symbols만 사용
- `localStorage` / `sessionStorage` 사용 금지 — 상태는 JS 변수로 관리
- `style.css`에는 Tailwind로 불가능한 스타일만 작성
- 카메라는 HTTPS 환경 필수 (`localhost` 예외)
- 외부 리소스는 위 CDN 허용 목록에서만 로드
- 색상 감지(RGB 픽셀 평균) 로직 재도입 금지 — YOLOv8n + 보행자 겹침 판별로 대체
