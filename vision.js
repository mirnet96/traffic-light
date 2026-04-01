/** [ULTRA VISION AI] - vision.js
 *  [FIX] 안드로이드 호환성 최종 수정
 *  - createImageBitmap 옵션: iOS 지원, 삼성/크롬 폴백 이중 구조
 *  - OffscreenCanvas → createElement('canvas') 폴백
 *  [개선 대안3] 보행자 탐지율 향상
 *  - analyzeAndShowSignal: 보행자 모드 시 HSV 임계값 완화 적용
 */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';
import { analyzeROI, analyzePedestrianROI, detectByHSV as analyzeByHSV } from './vision-analyzer.js';

let visionWorker      = null;
let isWorkerBusy      = false;
let lastKnownBox      = null;
let lockCounter       = 0;
let isVisionActive    = true;
let videoStream       = null;
let workerWatchdog    = null;
let detectLoopRunning = false;

const MAX_LOCK_FRAMES   = 30;
const WORKER_TIMEOUT_MS = 3000;

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

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: 'environment' },
                width:  { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        video.srcObject = stream;
        videoStream = stream;
        return new Promise(resolve => {
            video.onloadedmetadata = () => { video.play(); resolve(); };
        });
    } catch (err) {
        console.error("Camera Error:", err);
        throw err;
    }
}

export async function initVision() {
    if (visionWorker)   { visionWorker.terminate(); visionWorker = null; }
    if (workerWatchdog) { clearTimeout(workerWatchdog); workerWatchdog = null; }
    isWorkerBusy = false;

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
                Renderer.drawUI(video, boxes || [], currentZoom, srApplied, edgeSR);

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
            Renderer.updateStatusText('SYSTEM READY');
        } else if (type === 'ERROR') {
            console.error('[Worker Error]:', e.data.message);
            Renderer.updateStatusText('MODEL ERROR');
        }
    };

    visionWorker.onerror = (err) => {
        console.error('[Worker onerror]:', err);
        isWorkerBusy = false;
    };
}

export function startVision() {
    if (!detectLoopRunning) {
        detectLoopRunning = true;
        detectLoop();
    }
}

export async function detectLoop() {
    if (!isVisionActive || !visionWorker) {
        detectLoopRunning = false;
        return;
    }

    const video = document.getElementById('webcam');
    if (!video || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        if (workerWatchdog) clearTimeout(workerWatchdog);
        workerWatchdog = setTimeout(() => {
            console.warn("Worker Timeout - Restarting...");
            initVision().then(() => { isWorkerBusy = false; });
        }, WORKER_TIMEOUT_MS);

        try {
            let bitmap;
            // [FIX] iOS Safari  : 옵션 지원 → resizeWidth/Height 사용 (메모리 최적)
            //       삼성/크롬   : 옵션 미지원 시 예외 catch → 옵션 없이 재시도
            try {
                bitmap = await createImageBitmap(video, {
                    resizeWidth: 1280, resizeHeight: 720, resizeQuality: 'low'
                });
            } catch (_optErr) {
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

function tryHSVFallback(video) {
    try {
        const previewCanvas = document.getElementById('preview-canvas');
        if (!previewCanvas) return;
        const ctx = previewCanvas.getContext('2d');
        const vW  = video.videoWidth  || previewCanvas.width  || 1280;
        const vH  = video.videoHeight || previewCanvas.height || 720;
        const zone = Detector.getScanZone(vW, vH);

        const { signal, box } = analyzeByHSV(ctx, zone);
        if (signal !== 'UNKNOWN' && box) {
            lastKnownBox = box;
            lockCounter  = Math.floor(MAX_LOCK_FRAMES / 2);
            Renderer.updateSignalStatus(signal);
        } else {
            Renderer.updateSignalStatus('UNKNOWN');
        }
    } catch (e) {
        console.warn('[HSV Fallback]:', e.message);
    }
}

// ─────────────────────────────────────────────
// analyzeAndShowSignal
// [FIX] OffscreenCanvas 미지원 → createElement('canvas') 폴백
// [KEEP] pedMode 분기 유지
// ─────────────────────────────────────────────
function analyzeAndShowSignal(video, box) {
    if (!box) return;
    try {
        const w = Math.max(1, Math.floor(box.w));
        const h = Math.max(1, Math.floor(box.h));

        let ctx;
        if (typeof OffscreenCanvas !== 'undefined') {
            const offscreen = new OffscreenCanvas(w, h);
            ctx = offscreen.getContext('2d');
        } else {
            // [FIX] 삼성인터넷/구형 안드로이드 폴백
            const tmp = document.createElement('canvas');
            tmp.width  = w;
            tmp.height = h;
            ctx = tmp.getContext('2d');
        }

        ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, w, h);

        const signal = box.pedMode
            ? analyzePedestrianROI(ctx, { x: 0, y: 0, w, h })
            : analyzeROI(ctx, { x: 0, y: 0, w, h });

        Renderer.updateSignalStatus(signal);
    } catch (e) {
        console.error("ROI Analysis Error:", e);
    }
}

export function setVisionActive(active) {
    isVisionActive = active;
    if (active) {
        if (!detectLoopRunning) { detectLoopRunning = true; detectLoop(); }
    } else {
        detectLoopRunning = false;
    }
}
