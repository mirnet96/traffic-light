/** [ULTRA VISION AI] - vision.js */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let isWorkerBusy = false;
let lastKnownBox = null; // 마지막으로 확인된 좌표 고정용
let lockCounter = 0;     // 좌표 유지 프레임 카운트
const MAX_LOCK_FRAMES = 30; // 탐지 실패 시 약 1초간 마지막 좌표 유지

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
    if (!video || video.readyState < 2 || isWorkerBusy) {
        requestAnimationFrame(detectLoop);
        return;
    }

    isWorkerBusy = true;
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const zone = Detector.getScanZone(vW, vH);

    const bitmap = await createImageBitmap(video);
    visionWorker.postMessage({
        type: 'DETECT',
        data: { bitmap, vW, vH, zone }
    }, [bitmap]);

    requestAnimationFrame(detectLoop);
}

function handleWorkerResult(boxes) {
    const video = document.getElementById('webcam');
    
    if (boxes.length > 0) {
        // [탐지 성공] 신규 좌표 업데이트 및 카운트 초기화
        lastKnownBox = boxes[0];
        lockCounter = MAX_LOCK_FRAMES; 
    } else {
        // [탐지 실패] 기존 좌표가 있다면 카운트 감소하며 버티기
        if (lockCounter > 0) {
            lockCounter--;
        } else {
            lastKnownBox = null;
        }
    }

    // 화면 렌더링: lastKnownBox가 있으면 해당 영역을 고정해서 보여줌
    if (lastKnownBox) {
        Renderer.drawUI(video, lastKnownBox);
        Renderer.updateStatusText('DETECTED');
    } else {
        Renderer.drawPreview(video);
        Renderer.updateStatusText('READY');
    }

    isWorkerBusy = false;
}
