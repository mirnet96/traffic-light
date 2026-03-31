/** [ULTRA VISION AI] - vision.js (iOS 카메라 수정 + Watchdog + Worker 자동 복구) */
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
        alert('⚠️ 카메라를 사용하려면 HTTPS가 필요합니다.\n\n현재 주소: ' + location.origin);
        throw new Error('HTTPS_REQUIRED');
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('⚠️ 이 브라우저는 카메라를 지원하지 않습니다.\nSafari 최신 버전에서 HTTPS로 접속해주세요.');
        throw new Error('CAMERA_API_UNAVAILABLE');
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        return await _attachStream(video, stream);
    } catch (err) {
        console.warn("[카메라] exact:environment 실패 →", err.name, err.message);

        if (err.name === 'NotReadableError') {
            alert('⚠️ 카메라가 다른 앱에서 사용 중입니다.\n다른 앱을 종료 후 다시 시도해주세요.');
            throw err;
        }
        if (err.name === 'NotAllowedError') {
            alert('⚠️ 카메라 권한이 거부되었습니다.\n\niPhone 설정 > Safari > 카메라 > "묻기" 또는 "허용"으로 변경 후 새로고침해주세요.');
            throw err;
        }

        console.warn("[카메라] 제약 완화 후 재시도 중...");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
            return await _attachStream(video, stream);
        } catch (err2) {
            console.warn("[카메라] environment 실패 → 전면 카메라로 최종 시도:", err2.message);
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                return await _attachStream(video, stream);
            } catch (err3) {
                console.error("[카메라] 완전 실패:", err3);
                alert('⚠️ 카메라를 시작할 수 없습니다.\n\n오류: ' + err3.message);
                throw err3;
            }
        }
    }
}
class KalmanBox {
    constructor() {
        // 상태: [x, y, w, h, vx, vy]
        this.x = null;
        this.P = 100; // 초기 불확실성
        this.Q = 1;   // 프로세스 노이즈 (움직임 예측 오차)
        this.R = 10;  // 측정 노이즈 (YOLO 탐지 오차)
    }

    predict(box) {
        if (this.x === null) {
            // 첫 탐지 → 초기화
            this.x = { ...box };
            this.vx = 0; this.vy = 0;
            this.P = 100;
            return box;
        }
        // 속도 기반 위치 예측
        this.x.x += this.vx;
        this.x.y += this.vy;
        this.P += this.Q;
        return this.x;
    }

    update(measured) {
        if (this.x === null) { this.x = { ...measured }; return measured; }

        const K = this.P / (this.P + this.R); // 칼만 게인

        // 속도 추정 (이전 위치와의 차이)
        this.vx = (measured.x - this.x.x) * 0.3;
        this.vy = (measured.y - this.x.y) * 0.3;

        // 위치 보정
        this.x.x += K * (measured.x - this.x.x);
        this.x.y += K * (measured.y - this.x.y);
        this.x.w += K * (measured.w - this.x.w);
        this.x.h += K * (measured.h - this.x.h);
        this.x.score = measured.score;

        this.P = (1 - K) * this.P;
        return { ...this.x };
    }

    reset() { this.x = null; this.P = 100; this.vx = 0; this.vy = 0; }
}

class SignalVoter {
    constructor(windowSize = 8) {
        this.window = [];
        this.size = windowSize;
    }

    vote(signal) {
        this.window.push(signal);
        if (this.window.length > this.size) this.window.shift();

        const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
        for (const s of this.window) counts[s] = (counts[s] || 0) + 1;

        // ★ RED/GREEN이 60% 이상일 때만 확정 (노이즈 프레임 무시)
        const threshold = this.size * 0.6;
        if (counts.RED >= threshold)   return 'RED';
        if (counts.GREEN >= threshold) return 'GREEN';
        return 'UNKNOWN';
    }

    reset() { this.window = []; }
}

const kalman = new KalmanBox();
const signalVoter = new SignalVoter(8); // 최근 8프레임 투표

// handleWorkerResult 수정
function handleWorkerResult(boxes) {
    clearTimeout(workerWatchdog);
    const video = document.getElementById('webcam');

    if (boxes && boxes.length > 0) {
        // ★ 칼만 필터로 위치 보정
        const smoothedBox = kalman.update(boxes[0]);
        lastKnownBox = smoothedBox;
        lockCounter = MAX_LOCK_FRAMES;
        analyzeAndShowSignal(video, lastKnownBox);
    } else {
        if (lockCounter > 0) {
            lockCounter--;
            // ★ 미탐지 구간에서도 위치 예측 유지
            if (lastKnownBox) lastKnownBox = kalman.predict(lastKnownBox);
        } else {
            lastKnownBox = null;
            kalman.reset();
            tryHSVFallback(video);
        }
    }

    if (lastKnownBox) Renderer.drawUI(video, lastKnownBox);
    else Renderer.drawPreview(video);

    isWorkerBusy = false;
}

async function _attachStream(video, stream) {
    videoStream = stream;
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('muted', 'true');
    video.muted = true;

    await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };

        video.onloadedmetadata = () => {
            video.play()
                .then(() => done())
                .catch((e) => {
                    console.warn("[video.play()] 실패, muted 재시도:", e.message);
                    video.muted = true;
                    video.play().then(() => done()).catch(() => done());
                });
        };
        setTimeout(() => done(), 4000);
    });

    console.log("[카메라] 활성화 성공:", video.videoWidth, "x", video.videoHeight);
    return true;
}

export async function initVision(options = {}) {
    console.log("[Vision Worker] 초기화 시작...");
    return new Promise((resolve, reject) => {
        try {
            visionWorker = new Worker('vision-worker.js');

            const timeout = setTimeout(() => {
                reject(new Error("모델 로딩 시간 초과 (Network 확인)"));
            }, 30000);

            visionWorker.postMessage({ type: 'LOAD', options });

            visionWorker.onmessage = (e) => {
                if (e.data.type === 'LOADED') {
                    clearTimeout(timeout);
                    console.log("[Vision Model] 로드 완료.");
                    resolve();
                }
                if (e.data.type === 'RESULT') {
                    handleWorkerResult(e.data.boxes);
                }
                if (e.data.type === 'ERROR') {
                    clearTimeout(timeout);
                    console.error("[Worker Error]:", e.data.message);
                    isWorkerBusy = false;
                    clearTimeout(workerWatchdog);
                    setTimeout(() => _respawnWorker(), 1000);
                }
            };

            visionWorker.onerror = (e) => {
                console.error("[Worker onerror]:", e.message);
                isWorkerBusy = false;
                clearTimeout(workerWatchdog);
                setTimeout(() => _respawnWorker(), 1000);
            };

        } catch (err) {
            reject(err);
        }
    });
}

function _respawnWorker() {
    console.log('[Vision] Worker 재생성 중...');
    if (visionWorker) { visionWorker.terminate(); visionWorker = null; }
    isWorkerBusy = false;

    const worker = new Worker('vision-worker.js');
    visionWorker = worker;

    worker.postMessage({ type: 'LOAD', options: { minDetectionConfidence: 0.35, minTrackingConfidence: 0.4 } });

    worker.onmessage = (e) => {
        if (e.data.type === 'LOADED') { console.log('[Vision] Worker 재생성 완료'); }
        if (e.data.type === 'RESULT') { handleWorkerResult(e.data.boxes); }
        if (e.data.type === 'ERROR') {
            console.error('[Worker 재생성 후 ERROR]:', e.data.message);
            isWorkerBusy = false;
            clearTimeout(workerWatchdog);
            setTimeout(() => _respawnWorker(), 2000);
        }
    };

    worker.onerror = (e) => {
        console.error('[Worker 재생성 onerror]:', e.message);
        isWorkerBusy = false;
        clearTimeout(workerWatchdog);
        setTimeout(() => _respawnWorker(), 2000);
    };
}

export function startVision() {
    console.log("[탐지 루프] 시작");
    requestAnimationFrame(detectLoop);
}

export function setVisionActive(active) {
    isVisionActive = active;
}

async function detectLoop() {
    const video = document.getElementById('webcam');

    if (!isVisionActive || !video || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    if (isWorkerBusy) {
        if (lastKnownBox) Renderer.drawUI(video, lastKnownBox);
        else Renderer.drawPreview(video);
        requestAnimationFrame(detectLoop);
        return;
    }

    isWorkerBusy = true;

    clearTimeout(workerWatchdog);
    workerWatchdog = setTimeout(() => {
        console.warn('[Watchdog] Worker 응답 없음 → busy 강제 해제');
        isWorkerBusy = false;
    }, WORKER_TIMEOUT_MS);

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    if (!vW || !vH) {
        isWorkerBusy = false;
        clearTimeout(workerWatchdog);
        requestAnimationFrame(detectLoop);
        return;
    }

    const zone = Detector.getScanZone(vW, vH);

    try {
        const bitmap = await createImageBitmap(video);

        visionWorker.postMessage({
            type: 'DETECT',
            data: { bitmap, vW, vH, zone, lastBox: lastKnownBox } // ★ 추가
        }, [bitmap]);


    } catch (e) {
        console.error("[Bitmap 생성 에러]:", e);
        isWorkerBusy = false;
        clearTimeout(workerWatchdog);
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
        const rawResult = analyzeROI(ctx, { x: 0, y: 0, w: box.w, h: box.h });

        // ★ 투표로 최종 결정
        const finalResult = signalVoter.vote(rawResult);
        Renderer.updateSignalStatus(finalResult);
    } catch (e) {
        console.warn("[색상분석]:", e.message);
    }
}


