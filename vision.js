import { speak } from './app.js';

let objectDetector;
let lastColor = "UNKNOWN";
const video = document.getElementById('webcam');
const canvasElement = document.getElementById("webcam-canvas");
const canvasCtx = canvasElement.getContext("2d", { willReadFrequently: true });

export async function initVision() {
    const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm");
    objectDetector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: { 
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
            delegate: "GPU" 
        },
        scoreThreshold: 0.45,
        runningMode: "VIDEO"
    });
}

export async function startVision() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    video.onloadeddata = predictWebcam;
}

async function predictWebcam() {
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;
    if (objectDetector) {
        const detections = await objectDetector.detectForVideo(video, performance.now());
        processDetections(detections);
    }
    window.requestAnimationFrame(predictWebcam);
}

function processDetections(result) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    let signalFound = false;

    result.detections.forEach(detection => {
        if (detection.categories[0].categoryName === "traffic light") {
            signalFound = true;
            const { originX, originY, width, height } = detection.boundingBox;
            const colorStatus = analyzeSignal(originX, originY, width, height);
            updateUI(colorStatus);
            drawBox(originX, originY, width, height, colorStatus);
        }
    });
    if(!signalFound) updateUI("UNKNOWN");
}

function analyzeSignal(x, y, w, h) {
    const data = canvasCtx.getImageData(x, y, w, h).data;
    let rV = 0, gV = 0;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        if (r > 180 && r > g+60) rV++;
        if (g > 150 && g > r+40) gV++;
    }
    if (rV > gV && rV > 20) return "RED";
    if (gV > rV && gV > 20) return "GREEN";
    return "UNKNOWN";
}

function updateUI(color) {
    if (color === lastColor) return;
    const overlay = document.getElementById('border-overlay');
    overlay.className = color === "RED" ? "absolute inset-0 active-r" : (color === "GREEN" ? "absolute inset-0 active-g" : "absolute inset-0");
    if(color !== "UNKNOWN") speak(color === "RED" ? "빨간불입니다 정지" : "초록불입니다 건너세요");
    lastColor = color;
}

function drawBox(x, y, w, h, color) {
    canvasCtx.strokeStyle = color === "RED" ? "#ef4444" : "#22c55e";
    canvasCtx.lineWidth = 4;
    canvasCtx.strokeRect(x, y, w, h);
}
