/** [ULTRA VISION AI] - vision.js v5
 *  [FIX] 신호 전환 감지 시 signalHistory 즉시 리셋 (스무딩 지연 제거)
 *  [FIX] 동일 신호 시 analyzeAndShowSignal 재분석 스킵 (캐시 비교)
 *  [FIX] cross-zoom NMS — WIDE/MID/TELE 중복 박스 전역 좌표 기준 제거
 *  [FIX] createImageBitmap resize 옵션 제거 → Worker 내부에서만 resize
 *  [KEEP] 3단계 카메라 폴백, readyState>=1, scaleX/Y ROI 보정
 *  [KEEP] 줌레벨별 lockCounter 차등 적용
 */
import * as Detector from './vision-detector.js?v=5';
import * as Renderer from './vision-renderer.js?v=5';
import {
    analyzeROI, analyzePedestrianROI, detectByHSV as analyzeByHSV
} from './vision-analyzer.js?v=5';
import {
    initClassifier, isReady as isMPReady, classifyROIAsync, disposeClassifier
} from './vision-classifier.js?v=5';

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
let _lastAnalyzedSig  = null;   // [NEW] 재분석 스킵용 캐시

const SIGNAL_HISTORY_SIZE = 5;
const signalHistory     = [];
const WORKER_TIMEOUT_MS = 15000;
const LOCK_FRAMES = { WIDE: 30, MID: 20, TELE: 10, PED_LEFT: 15, PED_RIGHT: 15, PED_NEAR: 15, PED_LEFT2: 15, PED_RIGHT2: 15 };

// ─────────────────────────────────────────────
// 신호 스무딩
// [FIX] 전환 감지 시 히스토리 즉시 리셋
// ─────────────────────────────────────────────
function smoothSignal(raw) {
    const prev = signalHistory.length ? signalHistory[signalHistory.length - 1] : null;

    // [FIX] 이전과 다른 신호가 2회 연속이면 히스토리 리셋 → 즉시 반영
    if (prev && prev !== raw) {
        const prevPrev = signalHistory.length >= 2 ? signalHistory[signalHistory.length - 2] : null;
        if (prevPrev && prevPrev !== raw) {
            // 이번이 2회 연속 전환 신호
            signalHistory.length = 0;
        }
    }

    signalHistory.push(raw);
    if (signalHistory.length > SIGNAL_HISTORY_SIZE) signalHistory.shift();
    if (signalHistory.length < 3) return raw;

    const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
    for (const s of signalHistory) counts[s] = (counts[s] || 0) + 1;
    const [top, cnt] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return cnt > signalHistory.length / 2 ? top : 'UNKNOWN';
}

// ─────────────────────────────────────────────
// [NEW] Cross-zoom NMS — 전역 좌표 기준 중복 박스 제거
// ─────────────────────────────────────────────
function crossZoomNMS(boxes, iouThr = 0.45) {
    if (!boxes || boxes.length <= 1) return boxes;
    boxes.sort((a, b) => b.score - a.score);
    const kept = [], sup = new Set();
    for (let i = 0; i < boxes.length; i++) {
        if (sup.has(i)) continue;
        kept.push(boxes[i]);
        for (let j = i + 1; j < boxes.length; j++) {
            if (sup.has(j)) continue;
            if (_iou(boxes[i], boxes[j]) > iouThr) sup.add(j);
        }
    }
    return kept;
}
function _iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}

// 누적 박스 버퍼 (여러 줌레벨 결과를 모아 cross-zoom NMS)
let _boxBuffer = [];
let _boxBufferTimer = null;

function _flushBoxBuffer(video) {
    if (_boxBuffer.length === 0) return;
    const merged = crossZoomNMS(_boxBuffer);
    _boxBuffer = [];
    if (merged.length > 0) {
        lastKnownBox = merged[0];
        lockCounter  = LOCK_FRAMES[merged[0].zoomLabel] ?? 20;
        analyzeAndShowSignal(video, merged[0]);
    }
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

    await new Promise(resolve => {
        const timer = setTimeout(() => { console.warn('[Camera] metadata 타임아웃 — 강제 진행'); resolve(); }, 15000);
        video.onloadedmetadata = () => { clearTimeout(timer); video.play().catch(() => {}); resolve(); };
        video.oncanplay = () => { if (video.readyState >= 2) { clearTimeout(timer); video.play().catch(() => {}); resolve(); } };
    });

    await _waitForVideoReady(video, 8000);
    console.log('[Camera] 준비 완료 readyState:', video.readyState, video.videoWidth, 'x', video.videoHeight);
}

function _waitForVideoReady(video, ms) {
    return new Promise(resolve => {
        if (video.readyState >= 1) { resolve(); return; }
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
    return Promise.resolve();
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
                    // [NEW] 박스를 버퍼에 쌓고 16ms 후 cross-zoom NMS 처리
                    _boxBuffer.push(...boxes);
                    clearTimeout(_boxBufferTimer);
                    _boxBufferTimer = setTimeout(() => _flushBoxBuffer(video), 16);
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
    if (video && video.readyState >= 1) Renderer.drawVideo(video);
    requestAnimationFrame(renderLoop);
}

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
            isWorkerBusy = false; isWorkerReady = false; workerWatchdog = null;
            if (visionWorker) { visionWorker.terminate(); visionWorker = null; _initWorker(); }
        }, WORKER_TIMEOUT_MS);

        try {
            // [FIX] resize 옵션 제거 → Worker 내부에서만 리사이즈
            const bitmap = await createImageBitmap(video);
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
        const ctx = canvas.getContext('2d');
        const vW  = video.videoWidth  || canvas.width  || 1280;
        const vH  = video.videoHeight || canvas.height || 720;
        const { signal, box } = analyzeByHSV(ctx, Detector.getScanZone(vW, vH));
        if (signal !== 'UNKNOWN' && box) {
            lastKnownBox = box; lockCounter = 10;
            Renderer.updateSignalStatus(smoothSignal(signal));
        } else Renderer.updateSignalStatus(smoothSignal('UNKNOWN'));
    } catch (e) { console.warn('[HSV Fallback]:', e.message); }
}

// ─────────────────────────────────────────────
// ROI 분석
// [FIX] 동일 신호 시 재분석 스킵
// ─────────────────────────────────────────────
async function analyzeAndShowSignal(video, box) {
    if (!box) return;
    try {
        const canvas = document.getElementById('preview-canvas');
        const cW = canvas?.width  || video.videoWidth  || 1280;
        const cH = canvas?.height || video.videoHeight || 720;
        const vW = video.videoWidth  || cW;
        const vH = video.videoHeight || cH;

        const scaleX = vW / cW, scaleY = vH / cH;
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
            console.warn('[ROI] canvas 실패:', e.message);
            tryHSVFallback(video); return;
        }

        let signal = 'UNKNOWN';
        if (isMPReady()) signal = await classifyROIAsync(roiCanvas, box.pedMode);
        if (signal === 'UNKNOWN') {
            signal = box.pedMode
                ? analyzePedestrianROI(ctx, { x: 0, y: 0, w: rw, h: rh })
                : analyzeROI(ctx, { x: 0, y: 0, w: rw, h: rh });
        }

        const smoothed = smoothSignal(signal);

        // [FIX] 이전과 동일한 결과면 renderer 호출 스킵
        if (smoothed === _lastAnalyzedSig) return;
        _lastAnalyzedSig = smoothed;
        Renderer.updateSignalStatus(smoothed);

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
