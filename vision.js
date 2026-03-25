/**
 * [ULTRA VISION AI] - vision.js
 * 흔들림 방지(Smoothing) 및 원거리 색상 인식 최적화
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
const SMOOTHING = 0.7;         // 0~1 사이값 (높을수록 현재 위치 즉시 반영, 낮을수록 부드러움)

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
        
        const capabilities = videoTrack.getCapabilities();
        if (capabilities.zoom) {
            videoTrack.applyConstraints({ advanced: [{ zoom: 2.5 }] });
        }

        video.onloadeddata = () => {
            video.play();
            predictWebcam();
        };
    } catch (err) { console.error(err); }
}

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
 * 3. 좌표 보간(Smoothing) 및 필터링
 */
function processDetections(result) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // 신호등 찾기 (비율 필터 약간 완화)
    const currentSignal = result.detections.find(d => 
        d.categories[0].categoryName === "traffic light" && 
        d.boundingBox.height > d.boundingBox.width * 1.05
    );

    if (currentSignal) {
        const newBox = currentSignal.boundingBox;
        if (!lastDetection) {
            lastDetection = newBox;
        } else {
            // [Smoothing 적용] 현재값과 이전값을 섞어 떨림 방지
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

    if (detectionCounter > 0 && lastDetection) {
        const { originX, originY, width, height } = lastDetection;

        drawROI(originX, originY, width, height);
        const colorStatus = analyzeKoreanSignal(originX, originY, width, height);
        updateUI(colorStatus);
        drawBox(originX, originY, width, height, colorStatus);
        
        debugPanel.style.opacity = "1";
    } else {
        debugPanel.style.opacity = "0";
        updateUI("UNKNOWN");
        lastDetection = null;
    }
}

/**
 * 4. 핵심 분석: 밝기 기반 색상 판정
 * (이미지에서 보인 '흰색에 가까운 빨강/초록'을 잡기 위함)
 */
function analyzeKoreanSignal(x, y, w, h) {
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

            // 단순히 r, g 값만 비교하면 빛 번짐(흰색)을 못 잡으므로 밝기 합산 사용
            const brightness = Math.max(r, g, b);
            if (brightness < 100) continue; // 너무 어두운 픽셀 제외

            if (row < mid) {
                // 상단: 빨간색 성분이 조금이라도 우세하면 밝기 점수 가산
                if (r > g && r > b) upperScore += brightness;
                else if (r > 200 && g > 150) upperScore += (brightness * 0.5); // 아주 밝은 주황빛 대응
            } else {
                // 하단: 초록색(또는 청록색) 성분이 우세하면 밝기 점수 가산
                if (g > r) lowerScore += brightness;
                else if (g > 200 && r > 150) lowerScore += (brightness * 0.5); // 아주 밝은 연두빛 대응
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

    // 판정 로직: 한쪽 점수가 확연히 높고 일정 강도 이상일 때
    if (rPct > 65 && upperScore > 500) return "RED";
    if (gPct > 65 && lowerScore > 500) return "GREEN";
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
        speak("빨간불입니다.");
    } else if (color === "GREEN") {
        overlay.classList.add('active-g');
        speak("초록불입니다.");
    }
    lastColor = color;
}

function drawBox(x, y, w, h, color) {
    canvasCtx.strokeStyle = color === "RED" ? "#ef4444" : (color === "GREEN" ? "#22c55e" : "#3b82f6");
    canvasCtx.lineWidth = 5;
    canvasCtx.strokeRect(x, y, w, h);
}
