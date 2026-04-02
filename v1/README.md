# [BETA] 신호등 알리미 Pro (Traffic Light Pro)

> **주의: 본 서비스는 현재 v0.5 테스트 및 개발 단계에 있습니다.**  
> 8~10차선 대형 교차로 인식을 위한 멀티 스케일 줌 스캔 기능 및 보행자 신호등 전용 분석 기능이 포함되어 있습니다.

---

## 1. 신호등 탐지 전체 흐름

```
[카메라 프레임 입력]
        │
        ▼
[renderLoop]  ──────────────────────────────────────────►  preview-canvas에 매 프레임 렌더링
        │
        ▼
[detectLoop]
  createImageBitmap(video)
        │
        ▼
[vision-worker.js]  ── 4프레임 중 1프레임 처리 (모바일 성능 최적화)
        │
        ├─► 줌 레벨 순환 (WIDE → MID → TELE → PED_LEFT → PED_RIGHT → PED_NEAR → ...)
        │         │
        │         ▼
        │   [전처리]
        │   - 줌 영역 크롭 (getZoomRect)
        │   - SR 적용 여부 분기
        │     · PED_LEFT / PED_RIGHT : Edge-aware 4x SR (Sobel 엣지맵 기반)
        │     · MID / TELE           : SRCNN-lite 2x SR
        │     · WIDE / PED_NEAR      : SR 없음
        │   - Laplacian Sharpening (경계선 강화)
        │   - 640×640 리사이즈
        │         │
        │         ▼
        │   [YOLOv8n 추론]
        │   - COCO class 9 (traffic light) 탐지
        │   - 신뢰도 임계값: 차량 0.20 / 보행자 0.12
        │   - NMS (IoU 0.45) 중복 박스 제거
        │   - 로컬 좌표 → 원본 이미지 좌표 역매핑
        │         │
        │         ▼
        │   [RESULT 메시지 → vision.js]
        │
        ├─► 탐지 성공 (boxes.length > 0)
        │         │
        │         ▼
        │   [analyzeAndShowSignal]
        │   - box.pedMode 분기
        │     · pedMode = true  → analyzePedestrianROI()  보행자 전용 분석
        │     · pedMode = false → analyzeROI()             차량 신호 분석
        │         │
        │         ▼
        │   [HSV 색상 분석 (vision-analyzer.js)]
        │   ┌─────────────────────────────────────────────┐
        │   │  차량용 analyzeROI                           │
        │   │  - 상단 38% : 빨간불 검사 (Hue 0~15°)       │
        │   │  - 하단 38% : 초록불 검사 (Hue 85~170°)     │
        │   │  - v ≥ 0.4, s ≥ 0.3 필터링                  │
        │   ├─────────────────────────────────────────────┤
        │   │  보행자용 analyzePedestrianROI               │
        │   │  - 상단 50% : 빨간 사람 (Hue 0~12°)         │
        │   │  - 하단 50% : 초록 사람 (Hue 88~165°)       │
        │   │  - 조도 적응형 임계값 (_getAdaptiveThresholds)│
        │   │    · 야간  : minV 0.25, minS 0.14           │
        │   │    · 직사광: minV 0.48, minS 0.12           │
        │   │    · 주간  : minV 0.35, minS 0.20           │
        │   └─────────────────────────────────────────────┘
        │         │
        │         ▼
        │   [신호 판정] RED / GREEN / UNKNOWN
        │
        └─► 탐지 실패
                  │
                  ├─► lockCounter > 0 : 이전 박스로 재분석 (최대 30프레임 유지)
                  │
                  └─► lockCounter = 0 : detectByHSV() HSV Fallback
                            - 전체 스캔존 직접 HSV 스캔
                            - 밀집 클러스터 탐지 (16px 셀 기반)
                            - RED / GREEN 클러스터 비교 후 판정
                                  │
                                  ▼
                          [updateSignalStatus()]
                          - 화면 텍스트 색상 변경
                          - TTS 음성 안내 (speak())
```

---

## 2. 줌 레벨 구성

| 레벨 | 배율 | 중심 위치 | SR 방식 | 대상 |
|---|---|---|---|---|
| WIDE | 1x | 화면 중앙 상단 | 없음 | 근거리 차량 신호 |
| MID | 2x | 화면 중앙 | SRCNN-lite | 중거리 차량 신호 |
| TELE | 4x | 화면 중앙 하단 | SRCNN-lite | 원거리 차량 신호 |
| PED_LEFT | 3.3x | 좌측 가장자리 | Edge-aware 4x | 보행자 신호 (좌) |
| PED_RIGHT | 3.3x | 우측 가장자리 | Edge-aware 4x | 보행자 신호 (우) |
| PED_NEAR | 2.5x | 하단 전폭 | 없음 | 근거리 보행자 신호 |
| PED_LEFT2 | 5x | 좌측 하단 | Edge-aware 4x | 초근거리 보행자 (좌) |
| PED_RIGHT2 | 5x | 우측 하단 | Edge-aware 4x | 초근거리 보행자 (우) |

---

## 3. 멀티 스케일 줌 스캔 절차

### [단계별 스캔 프로세스]
1. **WIDE 스캔 (1x):** 화면 상단 전체 영역을 탐지하여 근거리 및 중거리 신호등을 포착합니다.
2. **MID 스캔 (2x):** 화면 중앙부를 2배 확대하여 4~6차선 거리의 신호등 형태를 정밀하게 분석합니다.
3. **TELE 스캔 (4x):** 소실점(도로 끝) 부근을 4배 확대하여 10차선 이상의 초원거리 신호등 후보지를 탐색합니다.
4. **PED 스캔:** 화면 좌/우 가장자리 및 하단을 전용 줌으로 확대하여 보행자 신호등을 탐지합니다.

### [좌표 역매핑 (Coordinate Mapping)]
- 각 줌 레벨에서 탐지된 객체는 `vision-worker.js`에서 원본 이미지 좌표계로 즉시 역산됩니다.
- 줌 영역에서 계산된 `(Local X, Y)`를 `(Global X, Y)`로 변환하여 화면 렌더링 및 색상 분석 엔진에 전달합니다.

---

## 4. 핵심 알고리즘 및 기술 스택

- **AI 엔진:** YOLOv8n (COCO pretrained, traffic light class 9)
- **SR 엔진:** SRCNN-lite (차량용 2x) / Edge-aware Sobel SR (보행자용 4x)
- **전처리:** Laplacian Sharpening 필터를 통한 원거리 객체 경계선 강화
- **색상 분석:** HSV 색 공간 기반 신호 상태(RED/GREEN) 판별 + 조도 적응형 임계값
- **폴백:** YOLO 탐지 실패 시 HSV 직접 스캔 + 밀집 클러스터 탐지
- **최적화:** Web Worker 기반 비동기 처리 (4프레임 중 1프레임 추론, renderLoop 분리)

---

## 5. 파일 구조

```
├── index.html          # 메인 UI, 부트 화면, 진단 배너
├── app.js              # 탭 전환, 시스템 시작 흐름 관리
├── vision.js           # 카메라 초기화, renderLoop / detectLoop 관리
├── vision-worker.js    # YOLO 추론, SR 처리, 줌 스캔 (Web Worker)
├── vision-analyzer.js  # HSV 색상 분석 (차량/보행자/Fallback)
├── vision-renderer.js  # Canvas 렌더링 (drawVideo / drawBoxes 분리)
├── vision-detector.js  # 스캔존 정의, 보행자 전용 스캔 영역
├── api-data.js         # V2X DATA 탭 (카카오맵, GPS, 신호 API)
└── utils.js            # TTS 음성 안내 (speak)
```

---

## 6. 사용 가이드

1. **접속 환경:** HTTPS 또는 localhost 환경 필수 (카메라 권한 요구)
2. **카메라 각도:** 스마트폰을 지면과 수평이 되도록 들고 정면을 향하게 하십시오.
3. **인식 범위:** 줌 스캔 기능을 통해 최대 50m 이상의 신호등까지 탐지가 가능합니다.
4. **피드백:** 신호가 감지되면 화면 상태 텍스트 변경과 함께 TTS 음성 안내가 제공됩니다.

---

## 7. 브라우저 호환성

| 브라우저 | 지원 여부 | 비고 |
|---|---|---|
| iOS Safari | ✅ | HTTPS 필수 |
| Android Chrome | ✅ | |
| Android 삼성 인터넷 | ✅ | |
| PC Chrome / Edge | ✅ | |
