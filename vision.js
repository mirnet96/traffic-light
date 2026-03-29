/** [ULTRA VISION AI] - vision.js */
import * as Detector from './vision-detector.js';
import * as Analyzer from './vision-analyzer.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let poseDetector = null;
let lastColor = 'UNKNOWN';
let smoothedBox = null;
let holdCounter = 0;
let isVisionActive = true;
let isWorkerBusy = false;
let dynamicZoneCoords = null; 
const ALPHA = 0.25;

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

/** MediaPipe Pose 초기화 */
async function initMediaPipe() {
    // window.Pose 가 로드되었는지 확인
    if (!window.Pose) return;
    
    poseDetector = new window.Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });
    poseDetector.setOptions({
        modelComplexity: 0,
        smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
    });
    poseDetector.onResults((results) => {
        if (!results.poseLandmarks) {
            dynamicZoneCoords = null;
            return;
        }
        const nose = results.poseLandmarks[0];
        const shoulderY = (results.poseLandmarks[11].y + results.poseLandmarks[12].y) / 2;
        
        // 고개 위치에 따른 ROI 비율 조정
        if (nose.y > shoulderY + 0.05) { 
            dynamicZoneCoords = { top: 0.25, bottom: 0.65 }; // 하단 집중
        } else if (nose.y < shoulderY - 0.05) { 
            dynamicZoneCoords = { top: 0.0, bottom: 0.40 };  // 상단 집중
        } else {
            dynamicZoneCoords = { top: 0.05, bottom: 0.50 }; // 정면
        }
    });
}

export async function initVision() {
    await initMediaPipe();
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
    if (!video || video.readyState < 2 || !isVisionActive) {
        requestAnimationFrame(detectLoop);
        return;
    }

    // MediaPipe 분석 수행
    if (poseDetector) await poseDetector.send({ image: video });

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        const vW = video.videoWidth;
        const vH = video.videoHeight;
        const zone = Detector.getScanZone(vW, vH, dynamicZoneCoords);

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

    const currentBox = boxes.length > 0 ? boxes[0] : null;

    if (currentBox) {
        holdCounter = 15;
        if (!smoothedBox) {
            smoothedBox = currentBox;
        } else {
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

    ctx.clearRect(0, 0, canvas.width, canvas.height);

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
