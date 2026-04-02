# ULTRA VISION AI — CLAUDE.md
> Claude 컨텍스트 파일 (v5)

---

## 프로젝트 개요
신호등 실시간 탐지 PWA. YOLOv8n(Web Worker) + HSV로 RED/GREEN 판정 후 TTS+진동 안내.
배포: `mirnet96.github.io/traffic-light` (GitHub Pages, HTTPS)

---

## 파일 구조 & 역할

| 파일 | 역할 | 핵심 export |
|---|---|---|
| `index.html` | UI, 부트화면, 진단배너 | — |
| `app.js` | 탭전환, 시스템시작, WakeLock, visibilitychange | `handleStart`, `switchTab` |
| `vision.js` | 카메라, renderLoop/detectLoop, cross-zoom NMS | `startCameraFirst`, `initVision`, `startVision`, `setVisionActive` |
| `vision-worker.js` | YOLO추론, 줌스캔, 커널캐시 | `LOAD/DETECT` → `LOADED/RESULT/SKIP/ERROR` |
| `vision-analyzer.js` | HSV 색상 분석 | `analyzeROI`, `analyzePedestrianROI`, `detectByHSV` |
| `vision-classifier.js` | MediaPipe ImageClassifier 래퍼 | `initClassifier`, `isReady`, `classifyROIAsync`, `disposeClassifier` |
| `vision-renderer.js` | Canvas 렌더링 | `drawVideo`, `drawBoxes`, `updateSignalStatus` |
| `vision-detector.js` | 스캔존 정의 | `getScanZone`, `getPedestrianScanRects` |
| `api-data.js` | V2X탭: 카카오맵+GPS | `initDataTab`, `stopGPS` |
| `utils.js` | TTS + 진동 | `speak(signal)` ← signal: 'RED'\|'GREEN'\|'UNKNOWN' |

---

## 탐지 파이프라인

```
카메라 → renderLoop(readyState>=1) → preview-canvas
              ↓
         detectLoop(4프레임중 1처리, createImageBitmap 옵션 없음)
              ↓ 탐지성공 줌레벨 최대 3회 우선 반복
        vision-worker.js
         processCount 기반 줌 순환(8단계)
         Sharpening: scale<=0.5 줌만 적용
         YOLO추론 → tensor.data() 비동기 → RESULT
         finally: scoresTensor/boxesTensor dispose 보장
              ↓
        vision.js
         crossZoomNMS(16ms 버퍼) → 중복박스 제거
         scaleX/Y 보정 → ROI 추출
         1순위: MediaPipe classifyROIAsync()
         2순위: analyzeROI / analyzePedestrianROI [HSV]
         3순위: detectByHSV [Fallback]
         동일 signal 캐시 비교 → 스킵
              ↓
        updateSignalStatus() → TTS + 진동
        (UNKNOWN은 TTS/진동 없음)
```

---

## 줌 레벨 8단계

| label | scale | pedMode | Sharpening | lockFrames |
|---|---|---|---|---|
| WIDE | 1.0x | false | 없음 | 30 |
| MID | 2.0x | false | 적용 | 20 |
| TELE | 4.0x | false | 적용 | 10 |
| PED_LEFT | 3.3x | true | 적용 | 15 |
| PED_RIGHT | 3.3x | true | 적용 | 15 |
| PED_NEAR | 2.5x | true | 적용 | 15 |
| PED_LEFT2 | 5.0x | true | 적용 | 15 |
| PED_RIGHT2 | 5.0x | true | 적용 | 15 |

---

## 주요 상수 / 임계값

```
// vision-worker.js
CONF_THRESHOLD      = 0.20
PED_CONF_THRESHOLD  = 0.12
NMS_IOU_THRESHOLD   = 0.45
TRAFFIC_LIGHT_CLASS = 9
SR_ENABLED          = false

// vision.js
LOCK_FRAMES = { WIDE:30, MID:20, TELE:10, PED_*:15 }
SIGNAL_HISTORY_SIZE = 5
WORKER_TIMEOUT_MS   = 15000
crossZoomNMS 버퍼   = 16ms

// vision-analyzer.js (차량 analyzeROI)
상단 38%: RED   Hue 0~15°  / s>0.5 / v>=0.4 / s>=0.3
하단 38%: GREEN Hue 100~170° / s>0.4   ← v5: 85°→100°
최소 크기: w>=2, h>=4

// vision-analyzer.js (보행자 analyzePedestrianROI)
상단 50%: RED   Hue 0~12°(야간 0~10°) / s>0.45
하단 50%: GREEN Hue 100~165° / s>0.22  ← v5: 88°→100°
최소 크기: w>=2, h>=4
isSmall(w<16||h<24): 임계값 30% 완화, minPx=4, scoreMin=15

// detectByHSV (Fallback)
GREEN Hue 100~165°  ← v5: 88°→100° (나트륨등 배제)

// utils.js
UNKNOWN → TTS/진동 없음
RED    → vibrate(200ms)
GREEN  → vibrate([100,50,100])
언어   → navigator.language 기반 ko/en 자동
```

---

## Worker 메시지 프로토콜

```
main → worker: { type:'LOAD' } | { type:'DETECT', data:{bitmap} }
worker → main: { type:'LOADED' } | { type:'RESULT', boxes, currentZoom, srApplied, edgeSR }
               { type:'SKIP' }   | { type:'ERROR', message }

box: { x, y, w, h, score, zoomLabel, pedMode, srApplied, edgeSR }
```

---

## 모델 파일

```
./models/yolov8n_web_model/model.json   필수
./models/signal_classifier.tflite       선택 (없으면 HSV폴백)
```

---

## 외부 의존성

```
TensorFlow.js 4.10.0  (cdn.jsdelivr.net)
Tailwind CSS           (cdn.tailwindcss.com)
카카오맵 SDK           appkey: 3696a1a72981f0d97505a7dc983c1d39
                       ※ 카카오 콘솔에서 허용도메인 mirnet96.github.io 설정 필수
@mediapipe/tasks-vision 0.10.14  (동적 import, vision-classifier.js)
```

---

## DOM 주요 ID

```
#webcam            video (숨김)
#preview-canvas    메인 렌더링 캔버스
#status-main       RED/GREEN/UNKNOWN 텍스트
#status-sub        상세 설명
#mp-badge          MediaPipe 상태 배지
#diag-banner       에러 배너 (하단 빨간바)
#boot-screen       부트화면
#start-btn         시작버튼 (onclick 없음, app.js 단일 등록)
#map               카카오맵 (height:220px 고정)
#address-text      역지오코딩 주소
#location-text     GPS 좌표
```

---

## FIX 이력 전체 (v1→v5)

| 증상 | 수정 버전 |
|---|---|
| 시작 후 부트복귀 (Android onloadedmetadata) | v4 |
| 카메라 오픈 실패 (constraints) | v4 |
| 다시시도 무반응 (once+onclick 충돌) | v4 |
| TTS 씹힘 iOS cancel() | v3 |
| ROI 좌표 어긋남 (scaleX/Y) | v4 |
| OffscreenCanvas 크래시 iOS<16 | v4 |
| 줌 인덱스 짝수 스킵 | v4 |
| TELE 박스 어긋남 (Math.round) | v4 |
| SR 연산낭비 (랜덤가중치) | v4 |
| 보행자 원거리 미탐지 (isSmall) | v4 |
| 야간 RED 오탐 가로등 (Hue 10°) | v4 |
| 간판 오탐 (클러스터 강화) | v3 |
| iOS 지도 찌그러짐 | v4 |
| Worker arraySync 블로킹 | v3 |
| WebGL 실패 Worker 고착 | v3 |
| lockCounter 일괄 적용 | v4 |
| tensor dispose 미보장 (finally) | v5 |
| GPS 미해제 (배터리 낭비) | v5 |
| 커널 재초기화 누수 | v5 |
| 신호 전환 스무딩 지연 | v5 |
| cross-zoom 중복 박스 | v5 |
| createImageBitmap CPU 폴백 | v5 |
| 동일 신호 재분석 낭비 | v5 |
| 나트륨 가로등 GREEN 오탐 (Hue 100°) | v5 |
| UNKNOWN TTS 발화 | v5 |
| 화면 꺼짐 (WakeLock) | v5 |
| 백그라운드 루프 (visibilitychange) | v5 |
| TTS 한국어 고정 | v5 |
| 진동 피드백 없음 | v5 |
| WIDE Sharpening 낭비 | v5 |

---

## 버전 관리
- 캐시 무효화: 모든 import `?v=N`
- 현재 버전: `?v=5`
- 업데이트: app.js import + index.html script src 동시 변경
