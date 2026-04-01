/** [ULTRA VISION AI] - vision.js
 *  [FIX] startCameraFirst — onloadedmetadata 타임아웃 10s → 15s
 *  [FIX] video.play() 실패해도 진행 (Android 일부 브라우저 호환)
 *  [FIX] _waitForVideoReady 타임아웃 3s → 8s, readyState >= 1 도 허용
 *  [FIX] getUserMedia constraints 단순화 — 일부 기기에서 ideal 조건이 카메라 오픈 실패 유발
 *  [FIX] initVision에서 Worker 로드 완료를 기다리지 않고 반환 (UI 블로킹 제거)
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
const signalHistory     = [];
const MAX_LOCK_FRAMES   = 30;
const WORKER_TIMEOUT_MS = 15000;

// ─────────────────────────────────────────────
// 신호 스무딩
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
// [FIX] constraints 단순화 + 타임아웃 연장 + play() 실패 허용
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

    // 기존 스트림 정리
    if (videoStream) {
        videoStream.getTracks().forEach(t => t.stop());
        videoStream = null;
        video.srcObject = null;
    }

    // [FIX] 단순화된 constraints — 복잡한 ideal 조건이 일부 Android에서 실패 유발
    let stream = null;
    const constraintsList = [
        // 1순위: 후면 카메라 HD
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        // 2순위: 후면 카메라만 (해상도 제한 없음)
        { video: { facingMode: 'environment' } },
        // 3순위: 아무 카메라
        { video: true },
    ];

    for (const constraints of constraintsList) {
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            break;
        } catch (err) {
            console.warn('[Camera] constraints 실패, 다음 시도:', JSON.stringify(constraints.video), err.message);
            if (err.name === 'NotAllowedError') throw err;  // 권한 거부는 즉시 throw
        }
    }

    if (!stream) throw new Error('카메라를 열 수 없습니다. 모든 constraints 실패');

    video.srcObject = stream;
    videoStream = stream;

    // [FIX] onloadedmetadata 타임아웃 15초, play() 실패해도 계속 진행
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            console.warn('[Camera] onloadedmetadata 타임아웃 — 강제 진행');
            resolve();  // [FIX] reject 대신 resolve로 변경 — 타임아웃이어도 진행 시도
        }, 15000);

        video.onloadedmetadata = async () => {
            clearTimeout(timer);
            try {
                await video.play();
            } catch (e) {
                console.warn('[video.play() 실패 — 무시하고 진행]', e.message);
            }
            resolve();
        };

        // [FIX] oncanplay도 폴백으로 추가
        video.oncanplay = () => {
            if (video.readyState >= 2) {
                clearTimeout(timer);
                video.play().catch(() => {});
                resolve();
            }
        };
    });

    // [FIX] readyState >= 1(HAVE_METADATA) 도 허용, 타임아웃 8초
    await _waitForVideoReady(video, 8000);
    console.log('[Camera] 준비 완료, readyState:', video.readyState, 'size:', video.videoWidth, 'x', video.videoHeight);
}

function _waitForVideoReady(video, timeoutMs) {
    return new Promise(resolve => {
        // [FIX] readyState >= 1 도 통과 허용 (HAVE_METADATA 이상이면 충분)
        if (video.readyState >= 1) { resolve(); return; }
        const start = Date.now();
        const check = () => {
            if (video.readyState >= 1 || Date.now() - start > timeoutMs) resolve();
            else setTimeout(check, 100);
        };
        check();
    });
}

// ─────────────────────────────────────────────
// Vision 초기화
// [FIX] Worker 로드를 기다리지 않고 즉시 반환 — UI 블로킹 제거
// ─────────────────────────────────────────────
export async function initVision() {
    _initWorker();

    // MediaPipe 비동기 초기화 (실패해도 HSV 폴백으로 동작)
    initClassifier().then(ok => {
        console.log('[Vision] MP Classifier:', ok ? '준비 완료' : 'HSV 폴백 모드');
    }).catch(() => {
        console.warn('[Vision] MP Classifier 초기화 예외 — HSV 폴백');
    });

    // [FIX] Worker LOADED 신호를 기다리지 않고 바로 반환
    // detectLoop에서 isWorkerReady 플래그로 안전하게 대기함
    return Promise.resolve();
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
    // [FIX] readyState >= 1 도 허용
    if (video && video.readyState >= 1) Renderer.drawVideo(video);
    requestAnimationFrame(renderLoop);
}

// ─────────────────────────────────────────────
// detectLoop
// ─────────────────────────────────────────────
export async function detectLoop() {
    if (!isVisionActive || !visionWorker) { detectLoopRunning = false; return; }

    const video = document.getElementById('webcam');
    if (!video || video.readyState < 1) { requestAnimationFrame(detectLoop); return; }
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
// ─────────────────────────────────────────────
async function analyzeAndShowSignal(video, box) {
    if (!box) return;
    try {
        const w = Math.max(1, Math.floor(box.w));
        const h = Math.max(1, Math.floor(box.h));

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

        if (isMPReady()) {
            signal = await classifyROIAsync(roiCanvas, box.pedMode);
        }

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
