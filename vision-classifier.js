/** [ULTRA VISION AI] - vision-classifier.js
 *  MediaPipe Tasks Vision — ImageClassifier 래퍼
 *
 *  역할:
 *    - YOLO가 탐지한 바운딩 박스 ROI를 받아 RED / GREEN / PEDESTRIAN_RED / PEDESTRIAN_GREEN 분류
 *    - MediaPipe 초기화 실패 시 isReady() === false 반환 → 호출부에서 HSV 폴백 사용
 *
 *  파이프라인:
 *    vision.js  →  analyzeAndShowSignal()
 *                    ├─ classifyROI()  [MP 준비됨]
 *                    └─ analyzeROI()  [HSV 폴백]
 *
 *  모델:
 *    기본값으로 efficientnet_lite0 기반 커스텀 .tflite 모델을 사용.
 *    현재는 범용 MobileNetV3 Small을 임시 사용하며, 파인튜닝된 신호등
 *    전용 모델(./models/signal_classifier.tflite)로 교체하면 정확도가 크게 향상됨.
 *
 *  출력 레이블 규약 (모델 학습 시 맞춰야 함):
 *    0: red          — 차량 빨간 신호
 *    1: green        — 차량 초록 신호
 *    2: ped_red      — 보행자 빨간 신호
 *    3: ped_green    — 보행자 초록 신호
 *    4: unknown      — 분류 불가
 */

const MP_TASKS_VISION_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

// 파인튜닝된 전용 모델이 없으면 이 경로가 임시 사용됨
// AI Hub 데이터로 파인튜닝 후 교체 권장
const DEFAULT_MODEL_URL =
    './models/signal_classifier.tflite';

// 분류 결과 → 내부 신호 코드 매핑
const LABEL_MAP = {
    'red':        'RED',
    'green':      'GREEN',
    'ped_red':    'RED',
    'ped_green':  'GREEN',
    // MobileNet 범용 모델 fallback 매핑 (파인튜닝 전 임시)
    'traffic light': null,   // 클래스 레이블 무시, UNKNOWN 처리
};

// 보행자 전용 레이블
const PED_LABELS = new Set(['ped_red', 'ped_green']);

let _classifier  = null;
let _ready       = false;
let _initFailed  = false;
let _initPromise = null;

// ─────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────
export async function initClassifier(modelUrl = DEFAULT_MODEL_URL) {
    if (_ready) return true;
    if (_initFailed) return false;
    if (_initPromise) return _initPromise;

    _initPromise = _doInit(modelUrl);
    return _initPromise;
}

async function _doInit(modelUrl) {
    try {
        // MediaPipe Tasks Vision 동적 import
        const { ImageClassifier, FilesetResolver } =
            await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');

        const vision = await FilesetResolver.forVisionTasks(MP_TASKS_VISION_URL);

        _classifier = await ImageClassifier.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: modelUrl,
                // GPU Delegate 우선, 실패 시 WASM CPU 자동 폴백
                delegate: 'GPU',
            },
            runningMode:    'IMAGE',
            maxResults:     5,
            scoreThreshold: 0.20,
        });

        _ready = true;
        _updateBadge('MP READY', '#22c55e');
        console.log('[MP Classifier] 초기화 완료:', modelUrl);
        return true;

    } catch (err) {
        _initFailed = true;
        _ready      = false;
        _updateBadge('MP OFF', '#71717a');
        console.warn('[MP Classifier] 초기화 실패 → HSV 폴백 사용:', err.message);
        return false;
    }
}

// ─────────────────────────────────────────────
// 준비 상태 확인
// ─────────────────────────────────────────────
export function isReady() {
    return _ready && _classifier !== null;
}

// ─────────────────────────────────────────────
// ROI 분류 (메인 API)
//
// @param {HTMLCanvasElement|OffscreenCanvas} canvas  - 분석할 ROI 캔버스
// @param {boolean} pedMode  - 보행자 신호등 모드 여부
// @returns {'RED'|'GREEN'|'UNKNOWN'}
// ─────────────────────────────────────────────
export function classifyROI(canvas, pedMode = false) {
    if (!isReady()) return 'UNKNOWN';

    try {
        // OffscreenCanvas는 MP가 직접 받지 못하므로 ImageBitmap 경유
        // 일반 HTMLCanvasElement는 직접 전달
        const result = _classifier.classify(canvas);

        if (!result?.classifications?.length) return 'UNKNOWN';

        const categories = result.classifications[0].categories;
        if (!categories?.length) return 'UNKNOWN';

        // 점수 상위 후보 중 pedMode와 맞는 레이블 우선 선택
        for (const cat of categories) {
            const label      = (cat.categoryName || cat.displayName || '').toLowerCase().trim();
            const isPedLabel = PED_LABELS.has(label);

            // pedMode가 켜져 있으면 보행자 레이블 우선, 꺼져 있으면 차량 레이블 우선
            if (pedMode && !isPedLabel) continue;
            if (!pedMode && isPedLabel) continue;

            const mapped = LABEL_MAP[label];
            if (mapped) return mapped;
        }

        // pedMode 필터를 적용한 후보가 없으면 전체에서 최고 점수 사용
        for (const cat of categories) {
            const label  = (cat.categoryName || cat.displayName || '').toLowerCase().trim();
            const mapped = LABEL_MAP[label];
            if (mapped) return mapped;
        }

        return 'UNKNOWN';

    } catch (err) {
        console.warn('[MP Classifier] classifyROI 실패:', err.message);
        return 'UNKNOWN';
    }
}

// ─────────────────────────────────────────────
// OffscreenCanvas → ImageBitmap 변환 후 분류
// (Worker 외부, vision.js 에서 OffscreenCanvas 사용 시)
// ─────────────────────────────────────────────
export async function classifyROIAsync(canvas, pedMode = false) {
    if (!isReady()) return 'UNKNOWN';

    try {
        let target = canvas;

        // OffscreenCanvas는 createImageBitmap으로 변환
        if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
            target = await createImageBitmap(canvas);
        }

        const signal = classifyROI(target, pedMode);

        if (target instanceof ImageBitmap) target.close();
        return signal;

    } catch (err) {
        console.warn('[MP Classifier] classifyROIAsync 실패:', err.message);
        return 'UNKNOWN';
    }
}

// ─────────────────────────────────────────────
// UI 배지 업데이트 (화면 우상단)
// ─────────────────────────────────────────────
function _updateBadge(text, color) {
    const badge = document.getElementById('mp-badge');
    if (!badge) return;
    badge.innerText  = text;
    badge.style.color = color;
    badge.style.background = color + '18';  // 투명도 ~10%
}

// ─────────────────────────────────────────────
// 리소스 해제 (앱 종료 또는 재초기화 시)
// ─────────────────────────────────────────────
export function disposeClassifier() {
    if (_classifier) {
        try { _classifier.close(); } catch (_) {}
        _classifier = null;
    }
    _ready      = false;
    _initFailed = false;
    _initPromise = null;
    _updateBadge('MP OFF', '#71717a');
}
