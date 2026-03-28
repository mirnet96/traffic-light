/** [ULTRA VISION AI] - vision.js (Main Controller) */
import * as Detector from './vision-detector.js';
import * as Analyzer from './vision-analyzer.js';
import * as Renderer from './vision-renderer.js';

let model = null;
let videoElement = null;
let canvasElement = null;
let lastColor = 'UNKNOWN';

export async function initVision() {
    model = await Detector.loadModel();
    videoElement = document.getElementById('webcam');
    canvasElement = document.getElementById('vision-canvas');
}

export async function startVision() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 1280 }
    });
    videoElement.srcObject = stream;
    videoElement.onloadedmetadata = () => {
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
        detectLoop();
    };
}

async function detectLoop() {
    const vW = videoElement.videoWidth;
    const vH = videoElement.videoHeight;
    const ctx = canvasElement.getContext('2d', { willReadFrequently: true });
    
    // 1. 스캔 영역 설정
    const zone = Detector.getScanZone(vW, vH);
    
    // 2. 모델 추론
    const input = tf.tidy(() => {
        return tf.image.resizeBilinear(tf.browser.fromPixels(videoElement), [640, 640])
                 .div(255.0).expandDims(0);
    });
    const res = await model.executeAsync(input);
    tf.dispose(input);

    // 3. 결과 가공 및 분석
    const boxes = Detector.processYOLO(res, vW, vH, zone);
    ctx.clearRect(0, 0, vW, vH);
    
    if (boxes.length > 0) {
        const best = boxes[0]; // 점수 높은 첫 번째 박스
        const color = Analyzer.analyzeROI(ctx, best.x, best.y, best.w, best.h);
        
        Renderer.drawDetection(ctx, best, color);
        Renderer.provideFeedback(color, lastColor);
        lastColor = color;
    } else {
        Renderer.stopBeep();
        lastColor = 'UNKNOWN';
    }

    requestAnimationFrame(detectLoop);
}
