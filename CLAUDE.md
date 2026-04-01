# ULTRA VISION AI — CLAUDE.md
> Claude가 이 프로젝트를 이해하기 위한 최소 컨텍스트 파일

---

## 프로젝트 개요
신호등 실시간 탐지 PWA. YOLOv8n(Web Worker) + HSV 색상 분석으로 RED/GREEN 판정 후 TTS 음성 안내.
배포: `mirnet96.github.io/traffic-light` (GitHub Pages, HTTPS)

---

## 파일 구조 & 역할

| 파일 | 역할 | 핵심 export |
|---|---|---|
| `index.html` | UI, 부트화면, 진단배너(`#diag-banner`) | — |
| `app.js` | 탭 전환, 시스템 시작 흐름 | `handleStart`, `switchTab` |
| `vision.js` | 카메라 초기화, renderLoop/detectLoop | `startCameraFirst`, `initVision`, `startVision`, `setVisionActive` |
| `vision-worker.js` | YOLO 추론, SR처리, 줌스캔 (Web Worker) | `onmessage: LOAD/DETECT` → `LOADED/RESULT/SKIP/ERROR` |
| `vision-analyzer.js` | HSV 색상 분석 | `analyzeROI`, `analyzePedestrianROI`, `detectByHSV` |
| `vision-classifier.js` | MediaPipe ImageClassifier 래퍼 | `initClassifier`, `isReady`, `classifyROIAsync`, `disposeClassifier` |
| `vision-renderer.js` | Canvas 렌더링 | `drawVideo`, `drawBoxes`, `updateSignalStatus` |
| `vision-detector.js` | 스캔존 정의 | `getScanZone`, `getPedestrianScanRects` |
| `api-data.js` | V2X탭: 카카오맵 + GPS | `initDataTab` |
| `utils.js` | TTS | `speak` |

---

## 탐지 파이프라인 (요약)

```
카메라 → renderLoop(매프레임) → preview-canvas 표시
              ↓
         detectLoop(4프레임중 1처리)
              ↓
        vision-worker.js
         줌레벨 순환(8단계) → YOLO추론 → RESULT
              ↓
        vision.js analyzeAndShowSignal()
         1순위: MediaPipe classifyROIAsync()
         2순위: analyzeROI() / analyzePedestrianROI() [HSV]
         3순위: detectByHSV() [YOLO탐지 실패시 Fallback]
              ↓
        updateSignalStatus() → RED/GREEN/UNKNOWN 표시 + TTS
```

---

## 줌 레벨 8단계

| label | scale | pedMode | SR |
|---|---|---|---|
| WIDE | 1.0x | false | 없음 |
| MID | 2.0x | false | SRCNN-lite |
| TELE | 4.0x | false | SRCNN-lite |
| PED_LEFT | 3.3x | true | EdgeAware |
| PED_RIGHT | 3.3x | true | EdgeAware |
| PED_NEAR | 2.5x | true | 없음 |
| PED_LEFT2 | 5.0x | true | EdgeAware |
| PED_RIGHT2 | 5.0x | true | EdgeAware |

---

## 주요 상수 / 임계값

```
// vision-worker.js
CONF_THRESHOLD      = 0.20   // 차량 신호등
PED_CONF_THRESHOLD  = 0.12   // 보행자 신호등
NMS_IOU_THRESHOLD   = 0.45
TRAFFIC_LIGHT_CLASS = 9      // COCO class

// vision.js
MAX_LOCK_FRAMES     = 30     // 탐지 실패 후 이전 박스 유지 프레임수
SIGNAL_HISTORY_SIZE = 5      // 스무딩 히스토리
WORKER_TIMEOUT_MS   = 15000

// vision-analyzer.js (차량 analyzeROI)
상단 38%: RED  Hue 0~15° / s>0.5
하단 38%: GREEN Hue 85~170° / s>0.4
v>=0.4, s>=0.3 필터

// vision-analyzer.js (보행자 analyzePedestrianROI)
상단 50%: RED  Hue 0~12°(야간 0~10°) / s>0.45
하단 50%: GREEN Hue 88~165° / s>0.22
조도적응 임계값: 야간(avgV<0.25) / 직사광(avgV>0.70) / 주간
```

---

## Worker 메시지 프로토콜

```
// main → worker
{ type: 'LOAD' }
{ type: 'DETECT', data: { bitmap } }  // bitmap은 Transferable

// worker → main
{ type: 'LOADED' }
{ type: 'RESULT', boxes, currentZoom, srApplied, edgeSR }
{ type: 'SKIP' }
{ type: 'ERROR', message }

// box 객체 구조
{ x, y, w, h, score, zoomLabel, pedMode, srApplied, edgeSR }
```

---

## 모델 파일 경로

```
./models/yolov8n_web_model/model.json   # YOLO (필수)
./models/signal_classifier.tflite       # MP Classifier (없으면 HSV폴백)
```

---

## 외부 의존성

```
cdn: TensorFlow.js 4.10.0
cdn: Tailwind CSS
cdn: 카카오맵 SDK (appkey: 3696a1a72981f0d97505a7dc983c1d39)
cdn: @mediapipe/tasks-vision 0.10.14 (동적 import, vision-classifier.js)
```

---

## DOM 주요 ID

```
#webcam            video (숨김, 카메라 소스)
#preview-canvas    메인 렌더링 캔버스
#roi-canvas        ROI 오버레이
#color-overlay     신호 색상 플래시 오버레이
#status-main       신호 텍스트 (RED/GREEN/UNKNOWN)
#status-sub        상세 설명 텍스트
#mp-badge          MediaPipe 상태 배지
#diag-banner       에러 진단 배너 (하단 빨간 바)
#boot-screen       부트/시작 화면
#start-btn         시작 버튼
#tab-v-btn         VISION AI 탭 버튼
#tab-d-btn         V2X DATA 탭 버튼
#vision-tab        비전 탭 컨텐츠
#data-tab          데이터 탭 컨텐츠
#map               카카오맵 컨테이너
#address-text      역지오코딩 주소
#location-text     GPS 좌표
```

---

## 알려진 버그 / FIX 이력

| 증상 | 원인 | 수정 |
|---|---|---|
| 시작 후 부트화면으로 복귀 | `onloadedmetadata` 타임아웃 reject | resolve로 변경, readyState>=1 허용 |
| 다시시도 버튼 무반응 | `once:true` + 인라인 `onclick` 중복으로 핸들러 소멸 | `_bindStartBtn()` 헬퍼, `onclick=null` |
| Android 카메라 오픈 실패 | `ideal` constraints 거부 | 3단계 폴백 constraints |
| 줌 순환 인덱스 오류 | `frameCount/2 % len` → 짝수만 순환 | `processCount++` 별도 관리 |
| Worker 블로킹 | `arraySync()` GPU→CPU 동기 전송 | `await tensor.data()` 비동기 전환 |
| 오렌지 조명 오탐 | 야간 RED Hue 상한 15° | 야간 모드 10°로 축소 |

---

## 버전 관리
- 캐시 무효화: 모든 import에 `?v=N` 쿼리 사용
- 현재 버전: `?v=3`
- 업데이트 시 `app.js` import 쿼리와 `index.html` `<script src="app.js?v=N">` 동시 변경
