/** [ULTRA VISION AI] - vision.js (Auto-Scanning) */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let isWorkerBusy = false;
let smoothedBox = null;
let currentZoom = 1.0;
let scanCount = 0;
let lockBox = null; // 찾은 신호등 좌표 고정용

export async function initVision() {
    return new Promise((resolve) => {
        visionWorker = new Worker('vision-worker.js');
        visionWorker.postMessage({ type: 'LOAD' });
        visionWorker.onmessage = (e) => {
            if (e.data.type === 'LOADED') resolve();
            if (e.data.type === 'RESULT') handleWorkerResult(e.data.boxes);
        };
    });
}

export async function startVision() {
    const video = document.getElementById('webcam');
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } }
    });
    video.srcObject = stream;
    await video.play();
    requestAnimationFrame(detectLoop);
}

async function detectLoop() {
    const video = document.getElementById('webcam');
    if (!video || video.readyState < 2) { requestAnimationFrame(detectLoop); return; }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        const bitmap = await createImageBitmap(video);
        visionWorker.postMessage({
            type: 'DETECT',
            data: { 
                bitmap, 
                vW: video.videoWidth, 
                vH: video.videoHeight, 
                zone: Detector.getScanZone(video.videoWidth, video.videoHeight) 
            }
        }, [bitmap]);
    }
    requestAnimationFrame(detectLoop);
}

async function handleWorkerResult(boxes) {
    const video = document.getElementById('webcam');
    const track = video.srcObject.getVideoTracks()[0];
    const caps = track.getCapabilities();

    if (boxes.length > 0) {
        // [찾았음] -> 해당 좌표 고정 및 줌 유지
        lockBox = boxes[0];
        scanCount = 0;
        // 찾았을 때 사용자에게 알림 (진동 등 추가 가능)
        Renderer.updateStatusText('신호등 확인됨');
    } else {
        // [못 찾았음] -> 스캔 카운트 증가 및 자동 줌 확대
        scanCount++;
        if (scanCount > 15) { // 약 0.5초 동안 못 찾으면
            if (caps.zoom) {
                currentZoom = Math.min(currentZoom + 0.5, caps.zoom.max || 3.0);
                track.applyConstraints({ advanced: [{ zoom: currentZoom }] });
            }
            scanCount = 0;
            lockBox = null;
            Renderer.updateStatusText('신호등 찾는 중... 줌 확대');
        }
    }

    // 화면 렌더링 (찾은 박스가 있으면 그 부분을 확대해서 보여줌)
    renderResult(video, lockBox || boxes[0]);
    isWorkerBusy = false;
}

function renderResult(video, box) {
    const canvas = document.getElementById('webcam-canvas');
    const ctx = canvas.getContext('2d');
    if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    ctx.drawImage(video, 0, 0);
    
    if (box) {
        // 찾은 신호등 주변에 가이드라인 표시
        Renderer.drawUI(ctx, box, 'UNKNOWN'); 
        // Renderer.js의 drawUI에서 이 box 좌표를 기반으로 
        // roi-canvas에 전체화면 확대를 수행하도록 설계되어 있어야 함
    }
}
