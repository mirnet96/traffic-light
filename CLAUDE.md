# CLAUDE.md — 저시력자용 보행 신호등 확대기

## 프로젝트 개요

길 건너편 보행 신호등을 실시간으로 감지하고 전체화면으로 확대하여
저시력자가 신호를 쉽게 식별할 수 있도록 돕는 웹/모바일 앱.

배포 주소: https://mirnet96.github.io/traffic-light

---

## 1차 목표 (최우선)

- 카메라로 2~10차선 건너편 신호등 자동 감지
- 감지된 신호등을 전체화면으로 확대 표시
- 정지(빨강) / 보행(초록) 상태를 크고 명확하게 표시

---

## 기술 스택

| 분류 | 선택 |
|---|---|
| 마크업 | HTML5 |
| 스타일 | Tailwind CSS (CDN) + style.css (커스텀 보완) |
| 아이콘 | Google Material Symbols Rounded (FILL=1) |
| ML 감지 | TensorFlow.js 4.17.0 — SSD MobileNet v2 (COCO class 10) |
| 카메라 | `getUserMedia` API (HTTPS 필수) |
| 배포 | GitHub Pages |

### CDN 출처 (허용 목록)

```
https://cdn.tailwindcss.com
https://fonts.googleapis.com  (Material Symbols)
https://cdn.jsdelivr.net      (TensorFlow.js)
https://tfhub.dev             (모델 가중치)
```

---

## 파일 구조

```
traffic-light/
├── index.html    — 구조 (DOM), CDN 로드
├── style.css     — Tailwind 보완용 커스텀 스타일만 작성
├── app.js        — 모든 로직 (카메라, ML, 감지, UI)
└── CLAUDE.md
```

### 역할 분리 원칙

- `index.html` — 구조와 Tailwind 유틸리티 클래스. 인라인 스타일 금지.
- `style.css`  — Tailwind로 표현 불가한 것만 작성 (애니메이션, 필터, font-variation-settings 등).
- `app.js`     — DOM 조작 시 Tailwind 클래스 추가/제거 우선. 불가피한 경우만 `style` 직접 설정.

---

## 아이콘 사용 규칙

Google Material Symbols Rounded 사용. 이모지 사용 금지.

```html
<span class="material-symbols-rounded">icon_name</span>
```

font-variation-settings 기본값 (`style.css`에 전역 설정):

```css
.material-symbols-rounded {
  font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}
```

| 용도 | 아이콘 이름 |
|---|---|
| 카메라 시작 | `videocam` |
| 카메라 전환 | `flip_camera_ios` |
| 야간 모드 OFF | `dark_mode` |
| 야간 모드 ON | `light_mode` |
| 오류 | `error` |
| 다시 시도 | `refresh` |
| 탐색 중 | `radar` |
| 보행 신호 | `directions_walk` |
| 정지 신호 | `do_not_walk` |
| 신호등 (불명) | `traffic` |

---

## 감지 파이프라인

```
카메라 프레임 (150ms 간격)
  └─> TF.js SSD MobileNet v2
        └─> COCO class 10 (traffic light), score >= 0.35
              └─> ROI 픽셀 색상 분석
                    └─> 정지 / 보행 / 알 수 없음
                          └─> 전체화면 확대
```

### 폴백 (모델 로드 실패 시 자동 전환)

픽셀 클러스터 탐색:
- 빨강: `R > 180, G < 80, B < 80`
- 초록: `G > 160, R < 100, B < 100`
- 최소 클러스터 크기: 8픽셀

---

## 핵심 상수 (`app.js`)

```js
MODEL_URL  = 'https://tfhub.dev/...'
TL_CLASS   = 10       // COCO 클래스 인덱스
SCAN_MS    = 150      // 감지 루프 주기 (ms)
MIN_SCORE  = 0.35     // 최소 신뢰도
NIGHT_THR  = 60       // 야간 전환 밝기 기준 (0~255)
```

---

## 야간 모드

- 3초마다 프레임 평균 밝기 측정 → 자동 전환
- 수동 토글 버튼 제공 (아이콘: `dark_mode` / `light_mode`)
- CSS 클래스로 제어: `#video.night` / `#video.day`

```css
#video.night { filter: brightness(1.6) contrast(1.4) saturate(1.3); }
#video.day   { filter: brightness(1.05) contrast(1.1) saturate(1.1); }
```

---

## 전체화면 확대 규격

- 배경: 신호 색상 기반 단색 (정지 `#1a0000` / 보행 `#001a08`)
- 원형 신호: `min(72vw, 72vh)` — 글로우 `box-shadow`
- 상태 텍스트: `min(18vw, 18vh)` font-size
- SVG 보행자 아이콘: 60 × 72 영역
- 진동: 정지 `[100, 50, 100]` / 보행 `[200]`
- 닫기: 화면 아무 곳이나 탭

---

## 앱 상태 흐름

```
init
  └─ 카메라 시작 버튼
        └─> loading
              ├─> live  (스캔 루프 + 야간 감지 루프)
              └─> error (권한 거부 / 하드웨어 오류)
```

---

## 향후 로드맵

- [ ] TTS 음성 안내 ("초록불입니다, 건너셔도 됩니다")
- [ ] 카운트다운 타이머 (남은 보행 시간)
- [ ] 온디바이스 경량 모델 교체 (YOLOv8n TFLite)
- [ ] PWA Service Worker (오프라인 캐싱)
- [ ] 접근성: 고대비 모드, 폰트 크기 설정

---

## 개발 규칙

- 이모지 사용 금지 — 아이콘은 Material Symbols만 사용
- `localStorage` / `sessionStorage` 사용 금지 — 상태는 JS 변수로 관리
- `style.css`에는 Tailwind로 불가능한 스타일만 작성
- 카메라는 HTTPS 환경 필수 (`localhost` 예외)
- 외부 리소스는 위 CDN 허용 목록에서만 로드
