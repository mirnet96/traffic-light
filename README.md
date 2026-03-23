# 🚦 신호등 알리미 Pro (Traffic Light Pro)

![Version](https://img.shields.io/badge/Version-4.0-blue) ![Engine](https://img.shields.io/badge/Engine-MediaPipe-orange) ![License](https://img.shields.io/badge/License-MIT-green)

**신호등 알리미 Pro**는 저시력 보행자가 횡단보도에서 보다 안전하게 신호를 인지할 수 있도록 돕는 **AI 비전 보조 도구**입니다. 구글의 MediaPipe 엔진을 사용하여 별도의 앱 설치 없이 웹 브라우저에서 실시간으로 신호를 분석합니다.

🔗 **서비스 URL:** [https://mirnet96.github.io/traffic-light](https://mirnet96.github.io/traffic-light)

---

## ✨ 핵심 기능 (Key Features)

### 1. 차세대 AI 객체 탐지
* **MediaPipe EfficientDet:** 기존 모델보다 빠르고 정확하게 신호등의 위치를 추적합니다.
* **시계열 검증 시스템:** 찰나의 빛 번짐이나 간판 노이즈를 방지하기 위해 연속된 프레임을 분석하여 4/6 이상의 일치 확률 시에만 안내합니다.

### 2. 저시력자 맞춤형 피드백
* **지능형 비프음 (Beep):** 초록불(높은 음, 짧은 주기)과 빨간불(낮은 음, 긴 주기)을 소리만으로 즉각 구분합니다.
* **강력한 진동 패턴:** 신호 변화 시 모바일 기기의 진동을 통해 촉각적 알림을 제공합니다.
* **TTS 음성 안내:** 현재 신호 상태와 보행 안전 수칙을 한국어로 가이드합니다.

### 3. 스마트 가이드 시스템
* **기울기 감지 (Gyroscope):** 스마트폰 각도가 부적절할 경우 "폰을 세워주세요" 배너와 가이드를 제공합니다.
* **자동 줌 탐색:** 신호등이 포착되지 않으면 카메라 배율을 0.5배씩 높여 원거리 신호를 탐색합니다.
* **야간 모드 최적화:** 빛 번짐 억제를 위해 카메라 노출(Exposure)을 자동 보정합니다.

---

## 🛠 사용 방법 (How to Use)

1. **접속:** 스마트폰 브라우저(삼성 인터넷, 크롬 권장)에서 위 URL에 접속합니다.
2. **권한 승인:** 카메라, 오디오, 자이로 센서 권한 요청 시 **'허용'**을 선택합니다.
3. **시스템 가동:** 화면 중앙의 **[시스템 가동]** 버튼을 누릅니다.
4. **위치 고정:** 기기를 정면으로 높게 들어 건너편 신호등을 비춥니다.
5. **안내 수신:** 음성, 진동, 비프음 주기에 따라 안전하게 대기하거나 횡단합니다.

---

## ⚠️ 주의 사항 (Safety Warning)

* **법적 고지:** 본 서비스는 보행 보조 도구일 뿐이며, 모든 판단의 최종 책임은 사용자에게 있습니다.
* **안전 거리 확보:** 반드시 인도 안쪽에서 사용하시고, 건너기 전에는 직접 주변 차량의 움직임을 확인하십시오.
* **환경 제약:** 야간, 역광, 우천 시 인식률이 저하될 수 있으므로 전적으로 의존하지 마십시오.

---

## 💻 기술 스택 (Tech Stack)

* **AI Engine:** Google MediaPipe Tasks Vision (EfficientDet Lite0)
* **Frontend:** HTML5, Tailwind CSS, JavaScript (ES6+)
* **Web APIs:** Web Audio, Vibration, DeviceOrientation, SpeechSynthesis

---

### 👨‍💻 유지보수 및 업데이트
* ** 테스트 중입니다.
* **Maintainer:** [mirnet96](https://github.com/mirnet96)
* **최근 업데이트:** 2026.03 (v0.4 - MediaPipe 및 기울기 가이드 엔진 통합)

