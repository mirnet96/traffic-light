/** [ULTRA VISION AI] - vision.js (기존 로직 보존 + iOS 줌 최적화) */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';
import { analyzeROI, detectByHSV as analyzeByHSV } from './vision-analyzer.js';

let visionWorker = null;
let isWorkerBusy = false;
let lastKnownBox = null;
let lockCounter = 0;
let isVisionActive = true;
let videoStream = null;
let workerWatchdog = null;
const MAX_LOCK_FRAMES = 30;
const WORKER_TIMEOUT_MS = 3000;

export async function startCameraFirst() {
    const video = document.getElementById('webcam');
    if (!video) throw new Error("'webcam' video 태그 없음");

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure) {
        alert('⚠️ 카메라를 사용하려면 HTTPS가 필요합니다.');
        throw new Error('HTTPS_REQUIRED');
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        video.srcObject = stream;
        videoStream = stream;
        return new Promise((resolve) => {
            video.onloadedmetadata = () => { video.play(); resolve(); };
        });
    } catch (err) {
        console.error("Camera Error:", err);
        throw err;
    }
}

export async function initVision() {
    if (visionWorker) visionWorker.terminate();
    visionWorker = new Worker('./vision-worker.js');
    visionWorker.postMessage({ type: 'LOAD' });

    visionWorker.onmessage = (e) => {
        const { type, boxes, currentZoom } = e.data;
        
        if (type === 'RESULT' || type === 'SKIP') {
            isWorkerBusy = false;
            clearTimeout(workerWatchdog);
            
            if (type === 'RESULT') {
                const video = document.getElementById('webcam');
                // 렌더러에 줌 정보 전달 (UI 표시용)
                Renderer.drawUI(video, boxes || [], currentZoom);
                
                if (boxes && boxes.length > 0) {
                    lastKnownBox = boxes[0];
                    lockCounter = MAX_LOCK_FRAMES;
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
        }
    };
}

export async function detectLoop() {
    if (!isVisionActive || !visionWorker) return;

    const video = document.getElementById('webcam');
    if (video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        
        // 워커 응답 지연 시 자동 복구를 위한 와치독
        workerWatchdog = setTimeout(() => {
            console.warn("Worker Timeout - Restarting...");
            initVision();
            isWorkerBusy = false;
        }, WORKER_TIMEOUT_MS);

        try {
            // iOS 메모리 보호: 해상도 제한 및 품질 설정
            const bitmap = await createImageBitmap(video, {
                resizeWidth: 1280, resizeHeight: 720, resizeQuality: 'low'
            });
            visionWorker.postMessage({ type: 'DETECT', data: { bitmap } }, [bitmap]);
        } catch (e) {
            isWorkerBusy = false;
            clearTimeout(workerWatchdog);
        }
    }

    requestAnimationFrame(detectLoop);
}

function tryHSVFallback(video) {
    try {
        const previewCanvas = document.getElementById('preview-canvas');
        if (!previewCanvas) return;
        const ctx = previewCanvas.getContext('2d');
        const vW = video.videoWidth  || previewCanvas.width;
        const vH = video.videoHeight || previewCanvas.height;
        const zone = Detector.getScanZone(vW, vH);

        const { signal, box } = analyzeByHSV(ctx, zone);
        if (signal !== 'UNKNOWN' && box) {
            lastKnownBox = box;
            lockCounter = Math.floor(MAX_LOCK_FRAMES / 2);
            Renderer.updateSignalStatus(signal);
        } else {
            Renderer.updateSignalStatus('UNKNOWN');
        }
    } catch (e) {
        console.warn('[HSV Fallback]:', e.message);
    }
}

function analyzeAndShowSignal(video, box) {
    try {
        const offscreen = new OffscreenCanvas(Math.max(1, Math.floor(box.w)), Math.max(1, Math.floor(box.h)));
        const ctx = offscreen.getContext('2d');
        ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
        const signal = analyzeROI(ctx, { x: 0, y: 0, w: box.w, h: box.h });
        Renderer.updateSignalStatus(signal);
    } catch (e) {
        console.error("ROI Analysis Error:", e);
    }
}

export function setVisionActive(active) {
    isVisionActive = active;
    if (active) detectLoop();
}
