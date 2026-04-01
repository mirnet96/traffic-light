/** [ULTRA VISION AI] - vision.js
 *  [FIX] 안드로이드 검은 화면 해결
 *  1. startCameraFirst(): facingMode exact → ideal 로 변경
 *     exact는 후면 카메라 없으면 에러, ideal은 없으면 전면으로 폴백
 *  2. startCameraFirst(): video.play() 완료를 Promise로 보장
 *  3. renderLoop(): video.readyState >= 2 (HAVE_ENOUGH_DATA) 확인 후 렌더링
 *  4. isWorkerBusy 고착 방지: 모든 경로에서 busy 해제 보장
 *  5. renderLoop / detectLoop 분리 유지
 */
import * as Detector from './vision-detector.js?v=2';
import * as Renderer from './vision-renderer.js?v=2';
import { analyzeROI, analyzePedestrianROI, detectByHSV as analyzeByHSV } from './vision-analyzer.js?v=2';

let visionWorker      = null;
let isWorkerBusy      = false;
let lastKnownBox      = null;
let lockCounter       = 0;
let isVisionActive    = true;
let videoStream       = null;
let workerWatchdog    = null;
let detectLoopRunning = false;
let renderLoopRunning = false;

const MAX_LOCK_FRAMES   = 30;
// [FIX] 모바일 추론 속도 대응: 3초 → 15초로 확대
// 안드로이드/iOS에서 YOLO 첫 추론은 10초 이상 걸릴 수 있음
const WORKER_TIMEOUT_MS = 15000;

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

    // [FIX] exact → ideal: 후면 카메라 없는 기기에서 에러 대신 폴백 허용
    // exact는 조건 불충족 시 OverconstrainedError 발생
    // ideal은 최대한 맞추되 없으면 가용 카메라 사용
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

        // [FIX] loadedmetadata + play() 완료를 모두 기다림
        await new Promise((resolve, reject) => {
            video.onloadedmetadata = async () => {
                try {
                    await video.play();
                    resolve();
                } catch (playErr) {
                    // 일부 브라우저에서 play()가 실패해도 스트림은 유효
                    console.warn('[video.play() 실패]', playErr.message);
                    resolve();
                }
            };
            // 10초 타임아웃
            setTimeout(() => reject(new Error('카메라 메타데이터 타임아웃')), 10000);
        });

        // [FIX] play() 이후 실제로 프레임이 들어오는지 확인
        // readyState가 충분히 오를 때까지 최대 3초 대기
        await _waitForVideoReady(video, 3000);

    } catch (err) {
        console.error("Camera Error:", err);
        throw err;
    }
}

// video.readyState >= 2 가 될 때까지 폴링
function _waitForVideoReady(video, timeoutMs) {
    return new Promise(resolve => {
        if (video.readyState >= 2) { resolve(); return; }
        const start = Date.now();
        const check = () => {
            if (video.readyState >= 2 || Date.now() - start > timeoutMs) {
                resolve();
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
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
            Renderer.updateStatusText('SYSTEM READY');
        } else if (type === 'ERROR') {
            console.error('[Worker Error]:', e.data.message);
            isWorkerBusy = false;
            Renderer.updateStatusText('MODEL ERROR');
        }
    };

    visionWorker.onerror = (err) => {
        console.error('[Worker onerror]:', err);
        isWorkerBusy = false;
    };
}

export function startVision() {
    if (!renderLoopRunning) {
        renderLoopRunning = true;
        renderLoop();
    }
    if (!detectLoopRunning) {
        detectLoopRunning = true;
        detectLoop();
    }
}

// ─────────────────────────────────────────────
// renderLoop: Worker와 무관하게 매 프레임 video → canvas
// ─────────────────────────────────────────────
function renderLoop() {
    if (!isVisionActive) {
        renderLoopRunning = false;
        return;
    }

    const video = document.getElementById('webcam');
    // [FIX] readyState >= 2: 실제 프레임 데이터가 있을 때만 렌더링
    if (video && video.readyState >= 2) {
        Renderer.drawVideo(video);
    }

    requestAnimationFrame(renderLoop);
}

// ─────────────────────────────────────────────
// detectLoop: AI 탐지 전용
// ─────────────────────────────────────────────
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
            console.warn("Worker Timeout - busy 강제 해제");
            isWorkerBusy   = false;
            workerWatchdog = null;
            if (visionWorker) {
                visionWorker.terminate();
                visionWorker = null;
                initVision();
            }
        }, WORKER_TIMEOUT_MS);

        try {
            let bitmap;
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
        if (!renderLoopRunning) { renderLoopRunning = true; renderLoop(); }
        if (!detectLoopRunning) { detectLoopRunning = true; detectLoop(); }
    } else {
        renderLoopRunning = false;
        detectLoopRunning = false;
    }
}
