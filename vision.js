/**
 * [ULTRA VISION AI] - vision.js
 * 흔들림 방지(Smoothing) 및 원거리 색상 인식 최적화 로직 포함
 */
import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './app.js';

let objectDetector;
let lastColor = "UNKNOWN";
let videoTrack = null;

// --- [보정 및 상태 유지 변수] ---
let lastDetection = null;      // 보존 및 보정된 좌표
let detectionCounter = 0;      // 상태 유지 프레임 카운트
const PERSIST_LIMIT = 20;      // 감지 중단 시 약 0.7초간 유지
const SMOOTHING = 0.7;         // 보간 계수 (높을수록 반응 빠름)

// DOM 요소 참조
const video = document.getElementById('webcam');
const canvasElement = document.getElementById("webcam-canvas");
const debugPanel = document.getElementById('debug-panel');
const roiCanvas = document.getElementById('roi-canvas');

/**
 * 1. AI 모델 초기화
 */
export async function initVision() {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    objectDetector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
            delegate: "GPU"
        },
        scoreThreshold: 0.35,
        runningMode: "VIDEO"
    });
}

/**
 * 2. 카메라 시작 및 줌 고정
 */
export async function startVision() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280, height: 720 }
        });
        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0];

        // 지원되는 경우 디지털 줌 적용 (보행자 시야 확보)
        const capabilities = videoTrack.getCapabilities();
        if (capabilities.zoom) {
            videoTrack.applyConstraints({ advanced: [{ zoom: 2.5 }] });
        }

        video.onloadeddata = () => {
            video.play();
            predictWebcam();
        };
    } catch (err) { 
        console.error("Camera Error:", err); 
        alert("카메라를 시작할 수 없습니다.");
    }
}

/**
 * 3. 매 프레임 예측 실행
 */
async function predictWebcam() {
    if (objectDetector && video.readyState >= 2) {
        canvasElement.width = video.videoWidth;
        canvasElement.height = video.videoHeight;

        const detections = await objectDetector.detectForVideo(video, performance.now());
        processDetections(detections);
    }
    window.requestAnimationFrame(predictWebcam);
}

/**
 * 4. 좌표 보간(Smoothing) 및 필터링
 */
function processDetections(result) {
    const canvasCtx = canvasElement.getContext("2d");
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // 신호등 찾기 (세로형 신호등 필터)
    const currentSignal = result.detections.find(d =>
        d.categories[0].categoryName === "traffic light" &&
        d.boundingBox.height > d.boundingBox.width * 1.05
    );

    if (currentSignal) {
        const newBox = currentSignal.boundingBox;
        if (!lastDetection) {
            lastDetection = newBox;
        } else {
            // [Smoothing] 떨림 방지 로직
            lastDetection = {
                originX: lastDetection.originX * (1 - SMOOTHING) + newBox.originX * SMOOTHING,
                originY: lastDetection.originY * (1 - SMOOTHING) + newBox.originY * SMOOTHING,
                width: lastDetection.width * (1 - SMOOTHING) + newBox.width * SMOOTHING,
                height: lastDetection.height * (1 - SMOOTHING) + newBox.height * SMOOTHING
            };
        }
        detectionCounter = PERSIST_LIMIT;
    } else {
        detectionCounter--;
    }

    // 감지 유지 상태일 때만 분석 실행
    if (detectionCounter > 0 && lastDetection) {
        const { originX, originY, width, height } = lastDetection;

        drawROI(originX, originY, width, height);
        const colorStatus = analyzeSignalColor(originX, originY, width, height, canvasCtx);
        updateUI(colorStatus);
        drawBox(originX, originY, width, height, colorStatus, canvasCtx);

        if (debugPanel) debugPanel.style.opacity = "1";
    } else {
        if (debugPanel) debugPanel.style.opacity = "0";
        updateUI("UNKNOWN");
        lastDetection = null;
    }
}

/**
 * 5. 핵심 분석: 밝기 기반 색상 판정 (한국형 신호등 최적화)
 */
function analyzeSignalColor(x, y, w, h, canvasCtx) {
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    const safeW = Math.min(Math.floor(w), video.videoWidth - startX);
    const safeH = Math.min(Math.floor(h), video.videoHeight - startY);

    if (safeW < 5 || safeH < 10) return "UNKNOWN";

    const data = canvasCtx.getImageData(startX, startY, safeW, safeH).data;
    let upperScore = 0;
    let lowerScore = 0;
    const mid = Math.floor(safeH / 2);

    for (let row = 0; row < safeH; row += 2) {
        for (let col = 0; col < safeW; col += 2) {
            const i = (row * safeW + col) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];

            const brightness = Math.max(r, g, b);
            if (brightness < 100) continue; 

            if (row < mid) {
                if (r > g && r > b) upperScore += brightness;
                else if (r > 200 && g > 150) upperScore += (brightness * 0.5); 
            } else {
                if (g > r) lowerScore += brightness;
                else if (g > 200 && r > 150) lowerScore += (brightness * 0.5); 
            }
        }
    }

    // UI 게이지 업데이트 (요소가 있는 경우에만)
    const redBar = document.getElementById('red-bar');
    const greenBar = document.getElementById('green-bar');
    if (redBar && greenBar) {
        const total = (upperScore + lowerScore) || 1;
        const rPct = Math.round((upperScore / total) * 100);
        const gPct = Math.round((lowerScore / total) * 100);
        redBar.style.width = `${rPct}%`;
        greenBar.style.width = `${gPct}%`;
        if (document.getElementById('red-val')) document.getElementById('red-val').innerText = `${rPct}%`;
        if (document.getElementById('green-val')) document.getElementById('green-val').innerText = `${gPct}%`;

        if (rPct > 65 && upperScore > 500) return "RED";
        if (gPct > 65 && lowerScore > 500) return "GREEN";
    }
    
    return "UNKNOWN";
}

/**
 * 6. ROI 추출 및 디버그 화면 출력
 */
function drawROI(x, y, w, h) {
    if (!roiCanvas) return;
    const roiCtx = roiCanvas.getContext('2d');
    roiCanvas.width = w;
    roiCanvas.height = h;
    roiCtx.drawImage(video, x, y, w, h, 0, 0, w, h);
}

/**
 * 7. 상태 변화에 따른 음성 안내 및 오버레이
 */
function updateUI(color) {
    if (color === lastColor) return;
    
    // index.html에 border-overlay 요소가 있어야 함
    const overlay = document.getElementById('border-overlay');
    
    if (color === "RED") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none active-r";
        speak("빨간불입니다. 정지하세요.");
    } else if (color === "GREEN") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none active-g";
        speak("초록불입니다. 건너가세요.");
    } else {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none";
    }
    lastColor = color;
}

/**
 * 8. 감지 박스 그리기
 */
function drawBox(x, y, w, h, color, canvasCtx) {
    canvasCtx.strokeStyle = color === "RED" ? "#ef4444" : (color === "GREEN" ? "#22c55e" : "#3b82f6");
    canvasCtx.lineWidth = 6;
    canvasCtx.strokeRect(x, y, w, h);
}
