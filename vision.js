/** [ULTRA VISION AI] - vision.js */
import * as Detector from './vision-detector.js';
import * as Analyzer from './vision-analyzer.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let pose = null;
let lastColor = 'UNKNOWN';
let smoothedBox = null;
let holdCounter = 0;
let isVisionActive = true;
let isWorkerBusy = false;
let dynamicZoneCoords = null; // MediaPipe에서 계산된 동적 영역 비율
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

/** MediaPipe Pose 초기화 및 시선 분석 설정 */
async function initMediaPipe() {
    pose = new Pose({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });
    pose.setOptions({
        modelComplexity: 0, // 초경량 모드
        smoothLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
    });
    pose.onResults((results) => {
        if (!results.poseLandmarks) {
            dynamicZoneCoords = null;
            return;
        }
        // 코(0)와 양쪽 어깨(11, 12) 좌표로 고개 각도 계산
        const nose = results.poseLandmarks[0];
        const shoulderY = (results.poseLandmarks[11].y + results.poseLandmarks[12].y) / 2;
        
        // 고개가 숙여졌는지 들렸는지에 따라 ROI 비율 조정 (0.0 ~ 1.0)
        if (nose.y > shoulderY + 0.05) { // 고개 숙임
            dynamicZoneCoords = { top: 0.25, bottom: 0.65 };
        } else if (nose.y < shoulderY - 0.05) { // 고개 들음
            dynamicZoneCoords = { top: 0.0, bottom: 0.40 };
        } else { // 정면
            dynamicZoneCoords = { top: 0.05, bottom: 0.50 };
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

    // 루프 시작
    requestAnimationFrame(detectLoop);
}

async function detectLoop() {
    const video = document.getElementById('webcam');
    if (!video || video.readyState < 2 || !isVisionActive) {
        requestAnimationFrame(detectLoop);
        return;
    }

    // MediaPipe 포즈 분석 실행
    await pose.send({ image: video });

    if (!isWorkerBusy) {
        isWorkerBusy = true;
        const vW = video.videoWidth;
        const vH = video.videoHeight;
        
        // Detector에서 동적 좌표 반영하여 zone 생성
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
