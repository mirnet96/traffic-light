/** [ULTRA VISION AI] - vision.js (Main) */
import * as Detector from './vision-detector.js';
import * as Analyzer from './vision-analyzer.js';
import * as Renderer from './vision-renderer.js';

let model = null;
let lastColor = 'UNKNOWN';
let smoothedBox = null;
let holdCounter = 0;
const ALPHA = 0.25;

// 멀티프레임 투표: 최근 5프레임 다수결로 오탐/깜빡임 방지
const colorHistory = [];
const VOTE_WINDOW = 5;

function getVotedColor(newColor) {
    colorHistory.push(newColor);
    if (colorHistory.length > VOTE_WINDOW) colorHistory.shift();

    const counts = { RED: 0, GREEN: 0, UNKNOWN: 0 };
    colorHistory.forEach(c => counts[c]++);
    return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
}

export async function initVision() {
    model = await Detector.loadModel();
}

export async function startVision() {
    const video  = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas');

    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } }
    });
    video.srcObject = stream;
    await video.play();

    // video 준비 완료 후 캔버스 크기 1회 설정
    await new Promise(resolve => {
        if (video.readyState >= 2) {
            resolve();
        } else {
            video.addEventListener('loadeddata', resolve, { once: true });
        }
    });

    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;

    detectLoop();
}

async function detectLoop() {
    const video  = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas');

    if (!video || !canvas || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 1. 탐지 실행
    const zone  = Detector.getScanZone(vW, vH);
    const input = tf.tidy(() =>
        tf.image.resizeBilinear(tf.browser.fromPixels(video), [640, 640]).div(255).expandDims(0)
    );
    const res   = await model.executeAsync(input);
    const boxes = Detector.processYOLO(res, vW, vH, zone);
    tf.dispose(input);

    // 2. 흔들림 보정 (Smoothing & Hold)
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
        if (holdCounter > 0) {
            holdCounter--;
        } else {
            smoothedBox = null;
        }
    }

    // 3. 분석 및 렌더링
    ctx.clearRect(0, 0, vW, vH);

    if (smoothedBox) {
        const rawColor = Analyzer.analyzeROI(ctx, smoothedBox);
        const color    = getVotedColor(rawColor);

        Renderer.drawUI(ctx, smoothedBox, color);
        Renderer.playFeedback(color, lastColor);
        Renderer.updateStatusText(color);
        lastColor = color;
    } else {
        // 미감지 상태: 카메라 원본을 전체화면으로 보여줌
        colorHistory.length = 0;
        Renderer.drawPreview(video);
        Renderer.stopBeep();
        Renderer.updateStatusText('READY');
        lastColor = 'UNKNOWN';
    }

    requestAnimationFrame(detectLoop);
}
