/**
 * [ULTRA VISION AI] - vision.js
 * 원거리 신호등 깜빡임 방지 및 상태 유지 로직 적용
 */
import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './app.js';

let objectDetector;
let lastColor = "UNKNOWN";
let videoTrack = null;

// --- [깜빡임 방지 및 상태 유지 변수] ---
let lastDetection = null;      // 마지막으로 유효하게 감지된 신호등의 좌표
let detectionCounter = 0;      // 감지가 끊겨도 유지할 프레임 수
const PERSIST_LIMIT = 15;      // 약 0.5초(15프레임) 동안 객체 정보 유지

// DOM 요소 참조
const video = document.getElementById('webcam');
const canvasElement = document.getElementById("webcam-canvas");
const canvasCtx = canvasElement.getContext("2d");

const debugPanel = document.getElementById('debug-panel');
const roiCanvas = document.getElementById('roi-canvas');
const roiCtx = roiCanvas.getContext('2d');
const redBar = document.getElementById('red-bar');
const greenBar = document.getElementById('green-bar');
const redValText = document.getElementById('red-val');
const greenValText = document.getElementById('green-val');

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
        scoreThreshold: 0.3, // 원거리 탐지를 위해 임계값 하향 조정
        runningMode: "VIDEO"
    });
}

/**
 * 2. 카메라 시작 및 디지털 줌 적용
 */
export async function startVision() {
    try {
        const constraints = { 
            video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } 
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        
        videoTrack = stream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities();
        if (capabilities.zoom) {
            // 원거리 신호등을 위해 2.5배 줌 고정 (기기 사양에 따라 조절 가능)
            videoTrack.applyConstraints({ advanced: [{ zoom: 2.5 }] });
        }

        video.onloadeddata = () => {
            video.play();
            predictWebcam();
        };
    } catch (err) {
        console.error("카메라 시작 오류:", err);
    }
}

/**
 * 3. 메인 분석 루프
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
 * 4. 객체 필터링 및 '상태 유지' 로직
 */
function processDetections(result) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // 이번 프레임에서 신호등 찾기 (한국형 세로 비율 필터 적용)
    const currentSignal = result.detections.find(d => {
        const cat = d.categories[0].categoryName;
        const box = d.boundingBox;
        return cat === "traffic light" && box.height > box.width * 1.1;
    });

    if (currentSignal) {
        // 새로운 감지가 있으면 정보 갱신 및 카운터 초기화
        lastDetection = currentSignal.boundingBox;
        detectionCounter = PERSIST_LIMIT;
    } else {
        // 감지가 없으면 카운터 감소
        detectionCounter--;
    }

    // 카운터가 유효할 때만 분석 및 UI 표시 진행
    if (detectionCounter > 0 && lastDetection) {
        const { originX, originY, width, height } = lastDetection;

        // ROI 분석 및 그리기
        drawROI(originX, originY, width, height);
        const colorStatus = analyzeKoreanSignal(originX, originY, width, height);
        updateUI(colorStatus);
        drawBox(originX, originY, width, height, colorStatus);

        debugPanel.style.opacity = "1";
    } else {
        // 완전히 사라졌다고 판단될 때
        debugPanel.style.opacity = "0";
        updateUI("UNKNOWN");
        lastDetection = null;
    }
}

/**
 * 5. 대한민국 보행자 신호등 분석 (상/하단 밝기 비교)
 */
function analyzeKoreanSignal(x, y, w, h) {
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    const safeW = Math.min(w, video.videoWidth - startX);
    const safeH = Math.min(h, video.videoHeight - startY);

    if (safeW <= 0 || safeH <= 0) return "UNKNOWN";

    const data = canvasCtx.getImageData(startX, startY, safeW, safeH).data;
    
    let upperScore = 0;
    let lowerScore = 0;
    const mid = Math.floor(safeH / 2);

    for (let row = 0; row < safeH; row += 2) {
        for (let col = 0; col < safeW; col += 2) {
            const i = (row * safeW + col) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            const brightness = Math.max(r, g, b);

            if (row < mid) {
                // 상단: 빨간색 강조
                if (r > g + 35 && r > b + 35) upperScore += brightness;
            } else {
                // 하단: 초록색 강조
                if (g > r + 25 && g > b + 10) lowerScore += brightness;
            }
        }
    }

    const total = (upperScore + lowerScore) || 1;
    const rPct = Math.round((upperScore / total) * 100);
    const gPct = Math.round((lowerScore / total) * 100);
    
    redBar.style.width = `${rPct}%`;
    redValText.innerText = `${rPct}%`;
    greenBar.style.width = `${gPct}%`;
    greenValText.innerText = `${gPct}%`;

    if (upperScore > lowerScore && upperScore > 300) return "RED";
    if (lowerScore > upperScore && lowerScore > 300) return "GREEN";
    return "UNKNOWN";
}

function drawROI(x, y, w, h) {
    roiCanvas.width = w;
    roiCanvas.height = h;
    roiCtx.drawImage(video, x, y, w, h, 0, 0, w, h);
}

function updateUI(color) {
    if (color === lastColor) return;
    const overlay = document.getElementById('border-overlay');
    overlay.className = "absolute inset-0 z-[12] pointer-events-none transition-all duration-300";

    if (color === "RED") {
        overlay.classList.add('active-r');
        speak("빨간불입니다. 정지하세요.");
    } else if (color === "GREEN") {
        overlay.classList.add('active-g');
        speak("초록불입니다. 건너셔도 좋습니다.");
    }
    lastColor = color;
}

function drawBox(x, y, w, h, color) {
    canvasCtx.strokeStyle = color === "RED" ? "#ef4444" : (color === "GREEN" ? "#22c55e" : "#3b82f6");
    canvasCtx.lineWidth = 4;
    canvasCtx.strokeRect(x, y, w, h);
    
    canvasCtx.setLineDash([5, 5]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, y + h/2);
    canvasCtx.lineTo(x + w, y + h/2);
    canvasCtx.stroke();
    canvasCtx.setLineDash([]);
}
