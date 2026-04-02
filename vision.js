/** [ULTRA VISION AI] - vision.js v4
 *  [FIX] startCameraFirst: 3단계 constraints 폴백 (HD→후면→any)
 *  [FIX] onloadedmetadata 타임아웃 시 reject → resolve (Android 호환)
 *  [FIX] play().catch(()=>{}) 로 변경, await 제거 (Samsung Internet)
 *  [FIX] readyState >= 1 허용, 타임아웃 8s로 연장
 *  [FIX] OffscreenCanvas 폴백 경로 try-catch 추가 (iOS 16 미만)
 *  [FIX] ROI 추출 시 scaleX/Y 보정 (canvas vs video 크기 불일치)
 *  [FIX] 줌레벨별 lockCounter 차등 적용 (WIDE 30 / MID 20 / TELE 10 / PED 15)
 *  [FIX] initVision 즉시 반환 (Worker LOADED 대기 제거)
 */
import * as Detector from './vision-detector.js?v=4';
import * as Renderer from './vision-renderer.js?v=4';
import {
    analyzeROI, analyzePedestrianROI, detectByHSV as analyzeByHSV
} from './vision-analyzer.js?v=4';
import {
    initClassifier, isReady as isMPReady, classifyROIAsync, disposeClassifier
} from './vision-classifier.js?v=4';

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
const WORKER_TIMEOUT_MS = 15000;

// 줌레벨별 lock 프레임 수
const LOCK_FRAMES = { WIDE: 30, MID: 20, TELE: 10, PED_LEFT: 15, PED_RIGHT: 15, PED_NEAR: 15, PED_LEFT2: 15, PED_RIGHT2: 15 };

function smoothSignal(raw) {
    signalHistory.push(raw);
    if (signalHistory.length > SIGNAL_HISTORY_SIZE) signalHistory.shift();
    if (signalHistory.length < 3) return raw;
    const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
    for (const s of signalHistory) counts[s] = (counts[s] || 0) + 1;
    const [top, cnt] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return cnt > signalHistory.length / 2 ? top : 'UNKNOWN';
}

// ─────────────────────────────────────────────
// 카메라 초기화
// ─────────────────────────────────────────────
export async function startCameraFirst() {
    const video = document.getElementById('webcam');
    if (!video) throw new Error("'webcam' video 태그 없음");

    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure) { alert('⚠️ HTTPS 필요'); throw new Error('HTTPS_REQUIRED'); }

    if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; video.srcObject = null; }

    // [FIX] 3단계 폴백 constraints
    const constraintsList = [
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        { video: { facingMode: 'environment' } },
        { video: true },
    ];

    let stream = null;
    for (const c of constraintsList) {
        try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
        catch (err) {
            console.warn('[Camera] 실패:', JSON.stringify(c.video), err.message);
            if (err.name === 'NotAllowedError') throw err;
        }
    }
    if (!stream) throw new Error('카메라를 열 수 없습니다');

    video.srcObject = stream;
    videoStream = stream;

    // [FIX] 타임아웃 시 resolve (reject → 부트복귀 방지)
    await new Promise(resolve => {
        const timer = setTimeout(() => { console.warn('[Camera] metadata 타임아웃 — 강제 진행'); resolve(); }, 15000);
        video.onloadedmetadata = () => {
            clearTimeout(timer);
            video.play().catch(() => {});  // [FIX] await 제거, 실패 무시
            resolve();
        };
        video.oncanplay = () => {
            if (video.readyState >= 2) { clearTimeout(timer); video.play().catch(() => {}); resolve(); }
        };
    });

    await _waitForVideoReady(video, 8000);
    console.log('[Camera] 준비 완료 readyState:', video.readyState, video.videoWidth, 'x', video.videoHeight);
}

function _waitForVideoReady(video, ms) {
    return new Promise(resolve => {
        if (video.readyState >= 1) { resolve(); return; }  // [FIX] >= 1 허용
        const t = Date.now();
        const check = () => (video.readyState >= 1 || Date.now() - t > ms) ? resolve() : setTimeout(check, 100);
        check();
    });
}

// ─────────────────────────────────────────────
// Vision 초기화
// ─────────────────────────────────────────────
export async function initVision() {
    _initWorker();
    initClassifier().then(ok => console.log('[MP]', ok ? '준비' : 'HSV폴백')).catch(() => {});
    return Promise.resolve();  // [FIX] Worker LOADED 대기 안 함
}

function _initWorker() {
    if (visionWorker)   { visionWorker.terminate(); visionWorker = null; }
    if (workerWatchdog) { clearTimeout(workerWatchdog); workerWatchdog = null; }
    isWorkerBusy = false; isWorkerReady = false;

    visionWorker = new Worker('./vision-worker.js');
    visionWorker.postMessage({ type: 'LOAD' });

    visionWorker.onmessage = e => {
        const { type, boxes, currentZoom, srApplied, edgeSR } = e.data;
        if (type === 'RESULT' || type === 'SKIP') {
            isWorkerBusy = false;
            clearTimeout(workerWatchdog); workerWatchdog = null;

            if (type === 'RESULT') {
                const video = document.getElementById('webcam');
                Renderer.drawBoxes(video, boxes || [], currentZoom, srApplied, edgeSR);
                if (boxes && boxes.length > 0) {
                    lastKnownBox = boxes[0];
                    // [FIX] 줌레벨별 lock 프레임 차등
                    lockCounter = LOCK_FRAMES[currentZoom?.label] ?? 20;
                    analyzeAndShowSignal(video, boxes[0]);
                } else {
                    if (lockCounter > 0) { lockCounter--; analyzeAndShowSignal(video, lastKnownBox); }
                    else tryHSVFallback(video);
                }
            }
        } else if (type === 'LOADED') {
            isWorkerReady = true;
            Renderer.updateStatusText('SYSTEM READY');
        } else if (type === 'ERROR') {
            console.error('[Worker Error]:', e.data.message);
            isWorkerBusy = false; isWorkerReady = false;
            Renderer.updateStatusText('MODEL ERROR');
        }
    };
    visionWorker.onerror = err => { console.error('[Worker onerror]:', err); isWorkerBusy = false; isWorkerReady = false; };
}

export function startVision() {
    if (!renderLoopRunning) { renderLoopRunning = true; renderLoop(); }
    if (!detectLoopRunning) { detectLoopRunning = true; detectLoop(); }
}

function renderLoop() {
    if (!isVisionActive) { renderLoopRunning = false; return; }
    const video = document.getElementById('webcam');
    if (video && video.readyState >= 1) Renderer.drawVideo(video);  // [FIX] >= 1
    requestAnimationFrame(renderLoop);
}

export async function detectLoop() {
    if (!isVisionActive || !visionWorker) { detectLoopRunning = false; return; }
    const video = document.getElementById('webcam');
    if (!video || video.readyState < 1) { requestAnimationFrame(detectLoop); return; }  // [FIX] < 1
    if (!isWorkerReady)                  { requestAnimationFrame(detectLoop); return; }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        if (workerWatchdog) clearTimeout(workerWatchdog);
        workerWatchdog = setTimeout(() => {
            console.warn('Worker Timeout — 재초기화');
            isWorkerBusy = false; isWorkerReady = false; workerWatchdog = null;
            if (visionWorker) { visionWorker.terminate(); visionWorker = null; _initWorker(); }
        }, WORKER_TIMEOUT_MS);

        try {
            let bitmap;
            try { bitmap = await createImageBitmap(video, { resizeWidth: 1280, resizeHeight: 720, resizeQuality: 'low' }); }
            catch (_) { bitmap = await createImageBitmap(video); }
            visionWorker.postMessage({ type: 'DETECT', data: { bitmap } }, [bitmap]);
        } catch (e) {
            console.warn('[detectLoop] bitmap 실패:', e.message);
            isWorkerBusy = false; clearTimeout(workerWatchdog); workerWatchdog = null;
        }
    }
    requestAnimationFrame(detectLoop);
}

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
            lastKnownBox = box; lockCounter = 10;
            Renderer.updateSignalStatus(smoothSignal(signal));
        } else Renderer.updateSignalStatus(smoothSignal('UNKNOWN'));
    } catch (e) { console.warn('[HSV Fallback]:', e.message); }
}

// ─────────────────────────────────────────────
// ROI 분석
// [FIX] scaleX/Y 보정으로 canvas vs video 불일치 해결
// [FIX] OffscreenCanvas 폴백 try-catch (iOS 16 미만)
// ─────────────────────────────────────────────
async function analyzeAndShowSignal(video, box) {
    if (!box) return;
    try {
        const canvas = document.getElementById('preview-canvas');
        const cW = canvas?.width  || video.videoWidth  || 1280;
        const cH = canvas?.height || video.videoHeight || 720;
        const vW = video.videoWidth  || cW;
        const vH = video.videoHeight || cH;

        // [FIX] canvas 좌표 → video 원본 좌표 역산
        const scaleX = vW / cW;
        const scaleY = vH / cH;
        const rx = box.x * scaleX, ry = box.y * scaleY;
        const rw = Math.max(1, Math.floor(box.w * scaleX));
        const rh = Math.max(1, Math.floor(box.h * scaleY));

        let roiCanvas, ctx;
        try {
            if (typeof OffscreenCanvas !== 'undefined') {
                roiCanvas = new OffscreenCanvas(rw, rh);
            } else {
                roiCanvas = document.createElement('canvas');
                roiCanvas.width = rw; roiCanvas.height = rh;
            }
            ctx = roiCanvas.getContext('2d');
            ctx.drawImage(video, rx, ry, rw, rh, 0, 0, rw, rh);
        } catch (e) {
            // [FIX] iOS 폴백: 직접 HSV 분석
            console.warn('[ROI] canvas 생성 실패, HSV 직접 호출:', e.message);
            tryHSVFallback(video); return;
        }

        let signal = 'UNKNOWN';
        if (isMPReady()) signal = await classifyROIAsync(roiCanvas, box.pedMode);
        if (signal === 'UNKNOWN') {
            signal = box.pedMode
                ? analyzePedestrianROI(ctx, { x: 0, y: 0, w: rw, h: rh })
                : analyzeROI(ctx, { x: 0, y: 0, w: rw, h: rh });
        }
        Renderer.updateSignalStatus(smoothSignal(signal));
    } catch (e) { console.error('ROI Error:', e); }
}

export function setVisionActive(active) {
    isVisionActive = active;
    if (active) {
        if (!renderLoopRunning) { renderLoopRunning = true; renderLoop(); }
        if (!detectLoopRunning) { detectLoopRunning = true; detectLoop(); }
    } else {
        renderLoopRunning = false; detectLoopRunning = false;
        disposeClassifier();
    }
}
