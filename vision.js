/** [ULTRA VISION AI] - vision.js (Main) */
import * as Detector from './vision-detector.js';
import * as Analyzer from './vision-analyzer.js';
import * as Renderer from './vision-renderer.js';

let model = null;
let lastColor = 'UNKNOWN';
let smoothedBox = null;  // 흔들림 보정용 저장소
let holdCounter = 0;     // 일시적 사라짐 방지용
const ALPHA = 0.25;      // 보정 계수 (낮을수록 더 부드럽게 움직임)

export async function initVision() {
    model = await Detector.loadModel();
}

export async function startVision() {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas'); // [BUG1 FIX] 'vision-canvas' → 'webcam-canvas'

    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } }
    });
    video.srcObject = stream;
    await video.play();

    // [BUG2 FIX] video.play() 완료 + 메타데이터 로드 후 캔버스 크기 1회만 설정하고 루프 시작
    await new Promise(resolve => {
        if (video.readyState >= 2) {
            resolve();
        } else {
            video.addEventListener('loadeddata', resolve, { once: true });
        }
    });

    // [BUG3 FIX] 캔버스 크기를 여기서 1회만 설정 (detectLoop 안에서 매 프레임 재설정 제거)
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    detectLoop();
}

async function detectLoop() {
    const video = document.getElementById('webcam');
    const canvas = document.getElementById('webcam-canvas'); // [BUG1 FIX] 올바른 ID
    if (!video || !canvas || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    // [BUG3 FIX] canvas.width / canvas.height 재설정 제거
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // 1. 탐지 실행
    const zone = Detector.getScanZone(vW, vH);
    const input = tf.tidy(() => tf.image.resizeBilinear(tf.browser.fromPixels(video), [640, 640]).div(255).expandDims(0));
    const res = await model.executeAsync(input);
    const boxes = Detector.processYOLO(res, vW, vH, zone);
    tf.dispose(input);

    // 2. 흔들림 보정 (Smoothing & Hold) 로직
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
        const color = Analyzer.analyzeROI(ctx, smoothedBox);
        Renderer.drawUI(ctx, smoothedBox, color, vW, vH);
        Renderer.playFeedback(color, lastColor);
        Renderer.updateStatusText(color);
        lastColor = color;
    } else {
        Renderer.stopBeep();
        Renderer.updateStatusText('READY');
        lastColor = 'UNKNOWN';
    }

    requestAnimationFrame(detectLoop);
}
