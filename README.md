# 신호등 확대기 (Traffic Light Magnifier)

> **베타 버전 (Beta)** — 현재 기능 검증 단계입니다. 실제 도로 횡단 시 반드시 육안으로 신호를 직접 확인하세요.

[![Beta](https://img.shields.io/badge/status-beta-orange)](https://mirnet96.github.io/traffic-light)
[![GitHub Pages](https://img.shields.io/badge/deploy-GitHub%20Pages-blue)](https://mirnet96.github.io/traffic-light)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 소개

길 건너편 보행 신호등을 카메라로 자동 감지하고 전체화면으로 확대하여, 저시력자가 신호 색상을 쉽고 빠르게 확인할 수 있도록 돕는 웹 앱입니다.

별도 설치 없이 브라우저에서 바로 사용할 수 있습니다.

**[지금 사용해보기 →](https://mirnet96.github.io/traffic-light)**

---

## 베타 버전 안내

> **이 앱은 현재 베타 테스트 단계입니다.**

| 항목 | 내용 |
|---|---|
| 버전 | Beta v0.1 |
| 감지 정확도 | 환경에 따라 상이 (역광·야간·소형 신호등에서 오감지 가능) |
| 권장 용도 | 기능 체험 및 피드백 수집 |
| 주의 사항 | 실제 횡단 시 육안 확인 병행 필수 |

버그 및 개선 의견은 [Issues](https://github.com/mirnet96/traffic-light/issues)에 남겨주세요.

---

## 주요 기능

- **실시간 감지** — TensorFlow.js SSD MobileNet v2로 2~10차선 건너편 신호등 자동 탐지
- **전체화면 확대** — 감지된 신호등을 화면 전체에 크게 표시, 정지·보행 텍스트 병기
- **야간 모드** — 주변 밝기 자동 측정 후 필터 적용, 수동 전환도 지원
- **폴백 감지** — 모델 로드 실패 시 픽셀 색상 분석 모드로 자동 전환
- **진동 피드백** — 신호 감지 시 햅틱 진동 (정지: 짧게 두 번 / 보행: 길게 한 번)
- **카메라 전환** — 전·후면 카메라 전환 지원

---

## 사용 방법

1. 브라우저에서 [https://mirnet96.github.io/traffic-light](https://mirnet96.github.io/traffic-light) 접속
2. **카메라 시작** 버튼 탭 → 카메라 권한 허용
3. 건너편 신호등에 카메라를 향하기
4. 하단에 감지된 신호등 카드 탭 → 전체화면 확대
5. 화면 아무 곳이나 탭하면 카메라 뷰로 복귀

> HTTPS 환경에서만 카메라 API가 동작합니다. GitHub Pages는 기본 HTTPS 지원.

---

## 기술 스택

| 분류 | 기술 |
|---|---|
| 마크업 | HTML5 |
| 스타일 | Tailwind CSS (CDN) |
| 아이콘 | Google Material Symbols Rounded |
| ML 감지 | TensorFlow.js 4.17 — SSD MobileNet v2 |
| 카메라 | getUserMedia API |
| 배포 | GitHub Pages |

---

## 파일 구조

```
traffic-light/
├── index.html    — 구조 (DOM), CDN 로드
├── style.css     — 커스텀 스타일 (Tailwind 보완)
├── app.js        — 카메라 · ML · UI 로직
├── README.md
└── CLAUDE.md     — AI 개발 컨텍스트 문서
```

---

## 로컬 실행

카메라 API는 HTTPS 또는 `localhost`에서만 동작합니다.

```bash
git clone https://github.com/mirnet96/traffic-light
cd traffic-light

# Node.js
npx serve .

# Python
python -m http.server 8080
```

브라우저에서 `http://localhost:8080` 접속.

---

## 로드맵

- [x] 실시간 카메라 감지
- [x] TF.js AI 모델 통합
- [x] 전체화면 확대
- [x] 야간 모드 (자동/수동)
- [x] 진동 피드백
- [ ] TTS 음성 안내
- [ ] 카운트다운 타이머
- [ ] PWA 오프라인 지원
- [ ] 경량 모델 교체 (YOLOv8n)

---

## 주의 및 면책

이 앱은 저시력자의 보조 도구로 개발되었으며, **신호 인식을 100% 보장하지 않습니다.**
횡단보도 이용 시 반드시 주변 상황을 직접 확인하고 안전하게 이용하십시오.

---

## 라이선스

MIT License © 2025 mirnet96
