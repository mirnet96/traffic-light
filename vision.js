/** [ULTRA VISION AI] - vision.js
 *  [FIX] 안드로이드 검은 화면 해결
 *  1. startCameraFirst(): facingMode exact → ideal 로 변경
 *  2. startCameraFirst(): video.play() 완료를 Promise로 보장
 *  3. renderLoop(): video.readyState >= 2 확인 후 렌더링
 *  4. isWorkerBusy 고착 방지: 모든 경로에서 busy 해제 보장
 *  5. renderLoop / detectLoop 분리 유지
 *  [FIX] analyzePedestrianROI import 누락 수정
 *  [FIX] Worker 재초기화 중 DETECT 메시지 유실 방지 (isWorkerReady 플래그)
 *  [NEW] 신호 스무딩: 최근 5프레임 과반수 투표로 오탐/깜빡임 억제
 */
import * as Detector from './vision-detector.js?v=2';
import * as Renderer from './vision-renderer.js?v=2';
import {
    analyzeROI,
    analyzePedestrianROI,          // [FIX] 누락된 import 추가
    detectByHSV as analyzeByHSV
} from './vision-analyzer.js?v=2';

let visionWorker      = null;
let isWorkerBusy      = false;
let isWorkerReady     = false;   // [FIX] 모델 LOADED 이후에만 DETECT 전송
let lastKnownBox      = null;
let lockCounter       = 0;
let isVisionActive    = true;
let videoStream       = null;
let workerWatchdog    = null;
let detectLoopRunning = false;
let renderLoopRunning = false;

// [NEW] 신호 스무딩용 히스토리 (최근 5프레임)
const SIGNAL_HISTORY_SIZE = 5;
const signalHistory = [];

const MAX_LOCK_FRAMES   = 30;
const WORKER_TIMEOUT_MS = 15000;

// ─────────────────────────────────────────────
// [NEW] 신호 스무딩: 최근 N프레임 과반수 투표
// ─────────────────────────────────────────────
function smoothSignal(raw) {
    signalHistory.push(raw);
    if (signalHistory.length > SIGNAL_HISTORY_SIZE) signalHistory.shift();

    const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
    for (const s of signalHistory) counts[s] = (counts[s] || 0) + 1;

    // 과반수 기준: 히스토리가 3개 이상 쌓였을 때만 적용
    if (signalHistory.length >= 3) {
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const [topSignal, topCount] = sorted[0];
        // 과반수(절반 초과)일 때만 신호 변경, 아니면 UNKNOWN 유지
        if (topCount > signalHistory.length / 2) return topSignal;
        return 'UNKNOWN';
    }
    return raw;
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
                try {
                    await video.play();
                    resolve();
                } catch (playErr) {
                    console.warn('[video.play() 실패]', playErr.message);
                    resolve();
                }
            };
            setTimeout(() => reject(new Error('카메라 메타데이터 타임아웃')), 10000);
        });

        await _waitForVideoReady(video, 3000);

    } catch (err) {
        console.error("Camera Error:", err);
        throw err;
    }
}

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

// ─────────────────────────────────────────────
// Worker 초기화
// ─────────────────────────────────────────────
export async function initVision() {
    if (visionWorker)   { visionWorker.terminate(); visionWorker = null; }
    if (workerWatchdog) { clearTimeout(workerWatchdog); workerWatchdog = null; }
    isWorkerBusy  = false;
    isWorkerReady = false;  // [FIX] 재초기화 시 준비 상태 초기화

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
            isWorkerReady = true;  // [FIX] 모델 로드 완료 후에만 DETECT 허용
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

    // [FIX] Worker가 LOADED 응답을 보내기 전까지 DETECT 전송 차단
    if (!isWorkerReady) {
        requestAnimationFrame(detectLoop);
        return;
    }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        if (workerWatchdog) clearTimeout(workerWatchdog);
        workerWatchdog = setTimeout(() => {
            console.warn("Worker Timeout - busy 강제 해제 및 재초기화");
            isWorkerBusy   = false;
            isWorkerReady  = false;  // [FIX] 재초기화 전 준비 상태 해제
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

// ─────────────────────────────────────────────
// HSV Fallback
// ─────────────────────────────────────────────
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
            Renderer.updateSignalStatus(smoothSignal(signal));  // [NEW] 스무딩 적용
        } else {
            Renderer.updateSignalStatus(smoothSignal('UNKNOWN'));
        }
    } catch (e) {
        console.warn('[HSV Fallback]:', e.message);
    }
}

// ─────────────────────────────────────────────
// ROI 분석 및 신호 표시
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
            const tmp = document.createElement('canvas');
            tmp.width  = w;
            tmp.height = h;
            ctx = tmp.getContext('2d');
        }

        // [NOTE] video에서 직접 읽어 CSS filter 영향 배제
        ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, w, h);

        // [FIX] pedMode 분기 — 이제 analyzePedestrianROI가 올바르게 import됨
        const rawSignal = box.pedMode
            ? analyzePedestrianROI(ctx, { x: 0, y: 0, w, h })
            : analyzeROI(ctx, { x: 0, y: 0, w, h });

        // [NEW] 스무딩 후 렌더링
        Renderer.updateSignalStatus(smoothSignal(rawSignal));
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
