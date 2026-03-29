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
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas');

    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } }
    });
    video.srcObject = stream;
    await video.play();

    // video.play() 완료 + 메타데이터 로드 후 캔버스 크기 1회만 설정하고 루프 시작
    await new Promise(resolve => {
        if (video.readyState >= 2) {
            resolve();
        } else {
            video.addEventListener('loadeddata', resolve, { once: true });
        }
    });

    // 캔버스 크기를 여기서 1회만 설정
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    detectLoop();
}

async function detectLoop() {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas');
    if (!video || !canvas || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 1. 탐지 실행
    const zone = Detector.getScanZone(vW, vH);
    const input = tf.tidy(() =>
        tf.image.resizeBilinear(tf.browser.fromPixels(video), [640, 640]).div(255).expandDims(0)
    );
    const res = await model.executeAsync(input);
    const boxes = Detector.processYOLO(res, vW, vH, zone);
    tf.dispose(input);

    // 2. 흔들림 보정 (Smoothing & Hold)
    let currentBox = boxes.length > 0 ? boxes[0] : null;

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
        // 멀티프레임 투표로 최종 색상 결정 (오탐/깜빡임 방지)
        const color = getVotedColor(rawColor);
        Renderer.drawUI(ctx, smoothedBox, color, vW, vH);
        Renderer.playFeedback(color, lastColor);
        Renderer.updateStatusText(color);
        lastColor = color;
    } else {
        colorHistory.length = 0; // 신호등 사라지면 투표 기록 초기화
        Renderer.stopBeep();
        Renderer.updateStatusText('READY');
        lastColor = 'UNKNOWN';
    }

    requestAnimationFrame(detectLoop);
}
