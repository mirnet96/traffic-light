/** [ULTRA VISION AI] - vision.js (Main) */
import * as Detector from './vision-detector.js';
import * as Analyzer from './vision-analyzer.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let lastColor = 'UNKNOWN';
let smoothedBox = null;
let holdCounter = 0;
let isVisionActive = true;
let isWorkerBusy = false;
const ALPHA = 0.35; // 스무딩 속도 (0.25 -> 0.35로 반응성 상향)

const colorHistory = [];
const VOTE_WINDOW = 5;

function getVotedColor(newColor) {
    colorHistory.push(newColor);
    if (colorHistory.length > VOTE_WINDOW) colorHistory.shift();
    const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
    colorHistory.forEach(c => counts[c]++);
    return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
}

export function setVisionActive(active) {
    isVisionActive = active;
    if (!active) {
        Renderer.stopBeep();
        Renderer.updateStatusText('PAUSED');
    }
}

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
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: 'environment', 
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        video.srcObject = stream;
        
        // 카메라 줌 설정 (지원되는 경우 1.5배~2배 줌 고정)
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities();
        if (caps.zoom) {
            track.applyConstraints({ advanced: [{ zoom: 1.8 }] });
        }
        
        await video.play();
        requestAnimationFrame(detectLoop);
    } catch (err) {
        console.error("Camera Start Failed:", err);
    }
}

async function detectLoop() {
    const video = document.getElementById('webcam');
    if (!video || video.readyState < 2 || !isVisionActive) {
        requestAnimationFrame(detectLoop);
        return;
    }

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        const vW = video.videoWidth;
        const vH = video.videoHeight;
        // 탐지 영역 가져오기
        const zone = Detector.getScanZone(vW, vH);

        // 현재 프레임을 비트맵으로 캡처하여 워커로 전달 (오버헤드 최소화)
        const bitmap = await createImageBitmap(video);
        visionWorker.postMessage({
            type: 'DETECT',
            data: { bitmap, vW, vH, zone }
        }, [bitmap]);
    }

    requestAnimationFrame(detectLoop);
}

function handleWorkerResult(boxes) {
    if (!isVisionActive) { isWorkerBusy = false; return; }

    const video = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    // 분석을 위해 캔버스에 비디오 프레임 그리기
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const currentBox = boxes.length > 0 ? boxes[0] : null;

    if (currentBox) {
        holdCounter = 20; // 박스 유지 프레임 상향
        if (!smoothedBox) {
            smoothedBox = currentBox;
        } else {
            // 위치 부드럽게 보정
            smoothedBox = {
                x: smoothedBox.x * (1 - ALPHA) + currentBox.x * ALPHA,
                y: smoothedBox.y * (1 - ALPHA) + currentBox.y * ALPHA,
                w: smoothedBox.w * (1 - ALPHA) + currentBox.w * ALPHA,
                h: smoothedBox.h * (1 - ALPHA) + currentBox.h * ALPHA
            };
        }
    } else {
        if (holdCounter > 0) holdCounter--;
        else smoothedBox = null;
    }

    if (smoothedBox) {
        const rawColor = Analyzer.analyzeROI(ctx, smoothedBox);
        const color = getVotedColor(rawColor);
        
        Renderer.drawUI(ctx, smoothedBox, color);
        Renderer.playFeedback(color, lastColor);
        Renderer.updateStatusText(color);
        lastColor = color;
    } else {
        colorHistory.length = 0;
        Renderer.drawPreview(video);
        Renderer.stopBeep();
        Renderer.updateStatusText('READY');
        lastColor = 'UNKNOWN';
    }
    isWorkerBusy = false;
}
