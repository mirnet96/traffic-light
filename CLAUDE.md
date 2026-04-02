# ULTRA VISION AI — CLAUDE.md
> Claude가 이 프로젝트를 이해하기 위한 최소 컨텍스트 파일 (v4)

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
| `vision-worker.js` | YOLO 추론, 줌스캔 (Web Worker) | `onmessage: LOAD/DETECT` → `LOADED/RESULT/SKIP/ERROR` |
| `vision-analyzer.js` | HSV 색상 분석 | `analyzeROI`, `analyzePedestrianROI`, `detectByHSV` |
| `vision-classifier.js` | MediaPipe ImageClassifier 래퍼 | `initClassifier`, `isReady`, `classifyROIAsync`, `disposeClassifier` |
| `vision-renderer.js` | Canvas 렌더링 | `drawVideo`, `drawBoxes`, `updateSignalStatus` |
| `vision-detector.js` | 스캔존 정의 | `getScanZone`, `getPedestrianScanRects` |
| `api-data.js` | V2X탭: 카카오맵 + GPS | `initDataTab` |
| `utils.js` | TTS | `speak` |

---

## 탐지 파이프라인 (요약)

```
카메라 → renderLoop(매프레임, readyState>=1) → preview-canvas 표시
              ↓
         detectLoop(4프레임중 1처리)
              ↓ [NEW] 탐지성공 줌레벨 최대 3회 우선 반복
        vision-worker.js
         줌레벨 순환(8단계, processCount 기반) → YOLO추론 → RESULT
              ↓
        vision.js analyzeAndShowSignal()
         scaleX/Y 보정 후 ROI 추출 (canvas vs video 불일치 대응)
         1순위: MediaPipe classifyROIAsync()
         2순위: analyzeROI() / analyzePedestrianROI() [HSV]
         3순위: detectByHSV() [YOLO탐지 실패시 Fallback]
              ↓
        updateSignalStatus() → RED/GREEN/UNKNOWN 표시 + TTS
```

---

## 줌 레벨 8단계

| label | scale | pedMode | SR | lockFrames |
|---|---|---|---|---|
| WIDE | 1.0x | false | 없음 | 30 |
| MID | 2.0x | false | 없음 | 20 |
| TELE | 4.0x | false | 없음 | 10 |
| PED_LEFT | 3.3x | true | 없음 | 15 |
| PED_RIGHT | 3.3x | true | 없음 | 15 |
| PED_NEAR | 2.5x | true | 없음 | 15 |
| PED_LEFT2 | 5.0x | true | 없음 | 15 |
| PED_RIGHT2 | 5.0x | true | 없음 | 15 |

> SR_ENABLED=false (v4): SRCNN-lite 랜덤가중치 연산낭비 방지. 학습된 가중치 확보 후 재활성화.

---

## 주요 상수 / 임계값

```
// vision-worker.js
CONF_THRESHOLD      = 0.20
PED_CONF_THRESHOLD  = 0.12
NMS_IOU_THRESHOLD   = 0.45
TRAFFIC_LIGHT_CLASS = 9
SR_ENABLED          = false  ← v4 변경

// vision.js
LOCK_FRAMES = { WIDE:30, MID:20, TELE:10, PED_*:15 }  ← v4 차등 적용
SIGNAL_HISTORY_SIZE = 5
WORKER_TIMEOUT_MS   = 15000

// vision-analyzer.js (차량 analyzeROI)
상단 38%: RED  Hue 0~15° / s>0.5 / v>=0.4 / s>=0.3
하단 38%: GREEN Hue 85~170° / s>0.4
최소 크기: w>=2, h>=4

// vision-analyzer.js (보행자 analyzePedestrianROI)
상단 50%: RED  Hue 0~12°(야간 0~10°) / s>0.45
하단 50%: GREEN Hue 88~165° / s>0.22
최소 크기: w>=2, h>=4  ← v4 완화 (기존 w>=4, h>=8)
isSmall(w<16||h<24): 임계값 30% 완화, minPx=4
조도적응: 야간(avgV<0.25) / 직사광(avgV>0.70) / 주간
```

---

## Worker 메시지 프로토콜

```
// main → worker
{ type: 'LOAD' }
{ type: 'DETECT', data: { bitmap } }  // Transferable

// worker → main
{ type: 'LOADED' }
{ type: 'RESULT', boxes, currentZoom, srApplied, edgeSR }
{ type: 'SKIP' }
{ type: 'ERROR', message }

// box 객체
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
#color-overlay     신호 색상 플래시
#status-main       신호 텍스트 (RED/GREEN/UNKNOWN)
#status-sub        상세 설명 텍스트
#mp-badge          MediaPipe 상태 배지
#diag-banner       에러 진단 배너 (하단 빨간바)
#boot-screen       부트/시작 화면
#start-btn         시작 버튼 (onclick 인라인 없음, app.js에서 단일 등록)
#tab-v-btn / #tab-d-btn  탭 버튼
#vision-tab / #data-tab  탭 컨텐츠
#map               카카오맵 컨테이너 (height:220px 고정)
#address-text      역지오코딩 주소
#location-text     GPS 좌표
```

---

## 버그 FIX 이력 (v4 누적)

| 증상 | 원인 | 수정 |
|---|---|---|
| 시작 후 부트화면 복귀 (Android) | onloadedmetadata 타임아웃 reject | resolve로 변경, readyState>=1 허용 |
| 카메라 오픈 실패 (Android) | ideal constraints 거부 | 3단계 폴백 constraints |
| 다시시도 버튼 무반응 (iOS) | once:true + onclick 중복 핸들러 소멸 | _bindStartBtn(), _handleStarting 플래그 |
| TTS 씹힘 (iOS) | cancel() 직후 speak() 무시 | 50ms 지연 후 _doSpeak() |
| ROI 좌표 어긋남 | canvas vs video 크기 불일치 | scaleX/Y 보정 적용 |
| OffscreenCanvas 크래시 (iOS<16) | 미지원 기기에서 예외 | try-catch + HSV 직접 폴백 |
| 줌 순환 인덱스 오류 | frameCount/2 → 짝수만 | processCount 별도 관리 |
| TELE 박스 위치 어긋남 | 역매핑 소수점 오차 | Math.round, zoomRect 정수화 |
| SR 연산 낭비 | SRCNN-lite 랜덤가중치 | SR_ENABLED=false |
| 보행자 원거리 미탐지 | 최소 크기 조건 너무 엄격 | w<2, h<4로 완화 + isSmall 분기 |
| 가로등 오탐 (야간) | RED Hue 상한 15° → 오렌지 포함 | 야간 10°로 축소 |
| 간판 오탐 | 클러스터 최소 픽셀 8개 | 20개, 밀도 12, 종횡비 검증 |
| iOS 지도 찌그러짐 | relayout 300ms 부족 | 600ms, map height px 고정 |
| Worker 블로킹 | arraySync() 동기 전송 | await tensor.data() |
| WebGL 실패 시 Worker 고착 | 동기 setBackend | initBackend() 비동기 + cpu 폴백 |
| lockCounter 일괄 적용 | 모든 줌 30프레임 고착 | 줌레벨별 차등 (WIDE30/MID20/TELE10/PED15) |

---

## 버전 관리
- 캐시 무효화: 모든 import `?v=N`
- 현재 버전: `?v=4`
- 업데이트 시 app.js import + index.html script src 동시 변경
