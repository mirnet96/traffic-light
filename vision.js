/** [ULTRA VISION AI] - vision.js
 *  [NEW] MediaPipe ImageClassifier 2단계 파이프라인 통합
 *    - YOLO 탐지 → ROI를 MP 분류기에 전달 → RED/GREEN 판정
 *    - MP 미준비 시 기존 HSV 분석(analyzeROI / analyzePedestrianROI)으로 자동 폴백
 *  [FIX] analyzePedestrianROI import 추가
 *  [FIX] isWorkerReady 플래그로 Worker 재초기화 중 DETECT 차단
 *  [NEW] 신호 스무딩: 최근 5프레임 과반수 투표
 */
import * as Detector  from './vision-detector.js?v=3';
import * as Renderer  from './vision-renderer.js?v=3';
import {
    analyzeROI,
    analyzePedestrianROI,
    detectByHSV as analyzeByHSV
} from './vision-analyzer.js?v=3';
import {
    initClassifier,
    isReady       as isMPReady,
    classifyROIAsync,
    disposeClassifier
} from './vision-classifier.js?v=3';

let visionWorker      = null;
let isWorkerBusy      = false;
let isWorkerReady     = false;
let lastKnownBox      = null;
let lockCounter       = 0;
let isVisionActive    = true;
let videoStream       = null;
let workerWatchdog    = null;
let detectLoopRunning = false;
let renderLoopRunning = false;

const SIGNAL_HISTORY_SIZE = 5;
const signalHistory = [];
const MAX_LOCK_FRAMES   = 30;
const WORKER_TIMEOUT_MS = 15000;

// ─────────────────────────────────────────────
// 신호 스무딩 (최근 N프레임 과반수 투표)
// ─────────────────────────────────────────────
function smoothSignal(raw) {
    signalHistory.push(raw);
    if (signalHistory.length > SIGNAL_HISTORY_SIZE) signalHistory.shift();
    if (signalHistory.length < 3) return raw;

    const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
    for (const s of signalHistory) counts[s] = (counts[s] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const [topSignal, topCount] = sorted[0];
    return topCount > signalHistory.length / 2 ? topSignal : 'UNKNOWN';
}

// ─────────────────────────────────────────────
// 카메라 초기화
// ─────────────────────────────────────────────
export async function startCameraFirst() {
    const video = document.getElementById('webcam');
    if (!video) throw new Error("'webcam' video 태그 없음");

    const isSecure =
        location.protocol === 'https:' ||
        location.hostname  === 'localhost' ||
        location.hostname  === '127.0.0.1';
    if (!isSecure) {
        alert('⚠️ 카메라를 사용하려면 HTTPS가 필요합니다.');
        throw new Error('HTTPS_REQUIRED');
    }

    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
        video.srcObject = null;
    }

    const constraints = {
        video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1280 },
            height: { ideal: 720 }
        }
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        videoStream = stream;

        await new Promise((resolve, reject) => {
            video.onloadedmetadata = async () => {
                try { await video.play(); resolve(); }
                catch (e) { console.warn('[video.play()]', e.message); resolve(); }
            };
            setTimeout(() => reject(new Error('카메라 메타데이터 타임아웃')), 10000);
        });
        await _waitForVideoReady(video, 3000);
    } catch (err) {
        console.error('Camera Error:', err);
        throw err;
    }
}

function _waitForVideoReady(video, timeoutMs) {
    return new Promise(resolve => {
        if (video.readyState >= 2) { resolve(); return; }
        const start = Date.now();
        const check = () => {
            if (video.readyState >= 2 || Date.now() - start > timeoutMs) resolve();
            else setTimeout(check, 100);
        };
        check();
    });
}

// ─────────────────────────────────────────────
// Vision 초기화 (YOLO Worker + MP Classifier 병렬 기동)
// ─────────────────────────────────────────────
export async function initVision() {
    // Worker 초기화
    _initWorker();

    // [NEW] MediaPipe ImageClassifier 비동기 초기화 (실패해도 앱 계속 동작)
    initClassifier().then(ok => {
        console.log('[Vision] MP Classifier:', ok ? '준비 완료' : 'HSV 폴백 모드');
    });
}

function _initWorker() {
    if (visionWorker)   { visionWorker.terminate(); visionWorker = null; }
    if (workerWatchdog) { clearTimeout(workerWatchdog); workerWatchdog = null; }
    isWorkerBusy  = false;
    isWorkerReady = false;

    visionWorker = new Worker('./vision-worker.js');
    visionWorker.postMessage({ type: 'LOAD' });

    visionWorker.onmessage = (e) => {
        const { type, boxes, currentZoom, srApplied, edgeSR } = e.data;

        if (type === 'RESULT' || type === 'SKIP') {
            isWorkerBusy = false;
            clearTimeout(workerWatchdog);
            workerWatchdog = null;

            if (type === 'RESULT') {
                const video = document.getElementById('webcam');
                Renderer.drawBoxes(video, boxes || [], currentZoom, srApplied, edgeSR);

                if (boxes && boxes.length > 0) {
                    lastKnownBox = boxes[0];
                    lockCounter  = MAX_LOCK_FRAMES;
                    analyzeAndShowSignal(video, boxes[0]);
                } else {
                    if (lockCounter > 0) {
                        lockCounter--;
                        analyzeAndShowSignal(video, lastKnownBox);
                    } else {
                        tryHSVFallback(video);
                    }
                }
            }
        } else if (type === 'LOADED') {
            isWorkerReady = true;
            Renderer.updateStatusText('SYSTEM READY');
        } else if (type === 'ERROR') {
            console.error('[Worker Error]:', e.data.message);
            isWorkerBusy  = false;
            isWorkerReady = false;
            Renderer.updateStatusText('MODEL ERROR');
        }
    };

    visionWorker.onerror = (err) => {
        console.error('[Worker onerror]:', err);
        isWorkerBusy  = false;
        isWorkerReady = false;
    };
}

export function startVision() {
    if (!renderLoopRunning) { renderLoopRunning = true; renderLoop(); }
    if (!detectLoopRunning) { detectLoopRunning = true; detectLoop(); }
}

// ─────────────────────────────────────────────
// renderLoop
// ─────────────────────────────────────────────
function renderLoop() {
    if (!isVisionActive) { renderLoopRunning = false; return; }
    const video = document.getElementById('webcam');
    if (video && video.readyState >= 2) Renderer.drawVideo(video);
    requestAnimationFrame(renderLoop);
}

// ─────────────────────────────────────────────
// detectLoop
// ─────────────────────────────────────────────
export async function detectLoop() {
    if (!isVisionActive || !visionWorker) { detectLoopRunning = false; return; }

    const video = document.getElementById('webcam');
    if (!video || video.readyState < 2) { requestAnimationFrame(detectLoop); return; }
    if (!isWorkerReady)                  { requestAnimationFrame(detectLoop); return; }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        if (workerWatchdog) clearTimeout(workerWatchdog);
        workerWatchdog = setTimeout(() => {
            console.warn('Worker Timeout — 재초기화');
            isWorkerBusy  = false;
            isWorkerReady = false;
            workerWatchdog = null;
            if (visionWorker) {
                visionWorker.terminate();
                visionWorker = null;
                _initWorker();
            }
        }, WORKER_TIMEOUT_MS);

        try {
            let bitmap;
            try {
                bitmap = await createImageBitmap(video, {
                    resizeWidth: 1280, resizeHeight: 720, resizeQuality: 'low'
                });
            } catch (_) {
                bitmap = await createImageBitmap(video);
            }
            visionWorker.postMessage({ type: 'DETECT', data: { bitmap } }, [bitmap]);
        } catch (e) {
            console.warn('[detectLoop] createImageBitmap 실패:', e.message);
            isWorkerBusy = false;
            clearTimeout(workerWatchdog);
            workerWatchdog = null;
        }
    }
    requestAnimationFrame(detectLoop);
}

// ─────────────────────────────────────────────
// HSV Fallback
// ─────────────────────────────────────────────
function tryHSVFallback(video) {
    try {
        const canvas = document.getElementById('preview-canvas');
        if (!canvas) return;
        const ctx  = canvas.getContext('2d');
        const vW   = video.videoWidth  || canvas.width  || 1280;
        const vH   = video.videoHeight || canvas.height || 720;
        const zone = Detector.getScanZone(vW, vH);

        const { signal, box } = analyzeByHSV(ctx, zone);
        if (signal !== 'UNKNOWN' && box) {
            lastKnownBox = box;
            lockCounter  = Math.floor(MAX_LOCK_FRAMES / 2);
            Renderer.updateSignalStatus(smoothSignal(signal));
        } else {
            Renderer.updateSignalStatus(smoothSignal('UNKNOWN'));
        }
    } catch (e) {
        console.warn('[HSV Fallback]:', e.message);
    }
}

// ─────────────────────────────────────────────
// ROI 분석 — 2단계 파이프라인
//
//   1순위: MediaPipe ImageClassifier
//   2순위: HSV 분석 (MP 미준비 또는 UNKNOWN 반환 시)
// ─────────────────────────────────────────────
async function analyzeAndShowSignal(video, box) {
    if (!box) return;
    try {
        const w = Math.max(1, Math.floor(box.w));
        const h = Math.max(1, Math.floor(box.h));

        // ROI 캔버스 생성 (CSS filter 영향 배제 — video에서 직접 읽기)
        let roiCanvas;
        let ctx;
        if (typeof OffscreenCanvas !== 'undefined') {
            roiCanvas = new OffscreenCanvas(w, h);
            ctx = roiCanvas.getContext('2d');
        } else {
            roiCanvas = document.createElement('canvas');
            roiCanvas.width  = w;
            roiCanvas.height = h;
            ctx = roiCanvas.getContext('2d');
        }
        ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, w, h);

        let signal = 'UNKNOWN';

        // ── 1순위: MediaPipe 분류기 ──────────────────
        if (isMPReady()) {
            signal = await classifyROIAsync(roiCanvas, box.pedMode);
        }

        // ── 2순위: HSV 분석 폴백 ─────────────────────
        // MP가 준비 안 됐거나 UNKNOWN을 반환한 경우
        if (signal === 'UNKNOWN') {
            signal = box.pedMode
                ? analyzePedestrianROI(ctx, { x: 0, y: 0, w, h })
                : analyzeROI(ctx, { x: 0, y: 0, w, h });
        }

        Renderer.updateSignalStatus(smoothSignal(signal));

    } catch (e) {
        console.error('ROI Analysis Error:', e);
    }
}

export function setVisionActive(active) {
    isVisionActive = active;
    if (active) {
        if (!renderLoopRunning) { renderLoopRunning = true; renderLoop(); }
        if (!detectLoopRunning) { detectLoopRunning = true; detectLoop(); }
    } else {
        renderLoopRunning = false;
        detectLoopRunning = false;
        disposeClassifier();
    }
}
