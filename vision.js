import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './app.js';

let objectDetector;
let lastColor = "UNKNOWN";
let videoTrack = null;

const video = document.getElementById('webcam');
const canvasElement = document.getElementById("webcam-canvas");
const canvasCtx = canvasElement.getContext("2d", { willReadFrequently: true });

/**
 * 1. AI 비전 모델 초기화
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
        scoreThreshold: 0.35, // 먼 거리의 작은 신호등 인식을 위해 임계값 하향
        runningMode: "VIDEO"
    });
}

/**
 * 2. 카메라 시작 및 줌 설정
 */
export async function startVision() {
    try {
        const constraints = { 
            video: { 
                facingMode: "environment", 
                width: { ideal: 1280 }, 
                height: { ideal: 720 } 
            } 
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0];

        // 안드로이드 크롬 등에서 지원하는 경우 디지털 줌 적용 (원거리 대응)
        const capabilities = videoTrack.getCapabilities();
        if (capabilities.zoom) {
            videoTrack.applyConstraints({ advanced: [{ zoom: 2.0 }] });
        }

        video.onloadeddata = () => {
            video.play();
            predictWebcam();
        };
    } catch (err) {
        console.error("카메라 시작 실패:", err);
    }
}

/**
 * 3. 프레임별 예측 루프
 */
async function predictWebcam() {
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;

    if (objectDetector && video.readyState >= 2) {
        const startTimeMs = performance.now();
        const detections = await objectDetector.detectForVideo(video, startTimeMs);
        processDetections(detections);
    }
    window.requestAnimationFrame(predictWebcam);
}

/**
 * 4. 검출 결과 처리 (한국 보행자 신호등 필터링)
 */
function processDetections(result) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    let signalFound = false;

    result.detections.forEach(detection => {
        const category = detection.categories[0].categoryName;
        const score = detection.categories[0].score;

        if (category === "traffic light") {
            const { originX, originY, width, height } = detection.boundingBox;

            // [규격 검증] 한국 보행자 신호등은 세로가 가로보다 긴 직사각형 (비율 약 1:2)
            if (height > width * 1.2) { 
                signalFound = true;
                
                // [정밀 분석] 상하단 분할 색상 인식
                const colorStatus = analyzeKoreanSignal(originX, originY, width, height);
                
                updateUI(colorStatus);
                drawSmartBox(originX, originY, width, height, colorStatus, score);
            }
        }
    });

    if (!signalFound) updateUI("UNKNOWN");
}

/**
 * 5. 대한민국 보행자 신호등 맞춤형 색상 분석 로직
 */
function analyzeKoreanSignal(x, y, w, h) {
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    
    // 픽셀 데이터 추출
    const imgData = canvasCtx.getImageData(startX, startY, w, h).data;
    
    let redInUpper = 0;   // 상단 영역 (빨간색 - 정지)
    let greenInLower = 0; // 하단 영역 (초록색 - 보행)
    
    const midPoint = Math.floor(h / 2); // 등기구 중앙 분리점

    // 샘플링 분석 (연산량 최적화)
    for (let row = 0; row < h; row += 2) {
        for (let col = 0; col < w; col += 2) {
            const i = (row * w + col) * 4;
            const r = imgData[i], g = imgData[i+1], b = imgData[i+2];

            if (row < midPoint) {
                // 상단: 빨간불 검사 (R 채널이 G, B보다 월등히 높아야 함)
                if (r > 160 && r > g + 50 && r > b + 50) redInUpper++;
            } else {
                // 하단: 초록불 검사 (보행등 특유의 청록색 포함)
                if (g > 150 && g > r + 30) greenInLower++;
            }
        }
    }

    // 판별 기준 (노이즈 방지를 위해 일정 픽셀 이상 검출 시 인정)
    if (redInUpper > greenInLower && redInUpper > 5) return "RED";
    if (greenInLower > redInUpper && greenInLower > 5) return "GREEN";
    
    return "UNKNOWN";
}

/**
 * 6. UI 업데이트 및 음성 안내
 */
function updateUI(color) {
    if (color === lastColor) return;

    const overlay = document.getElementById('border-overlay');
    overlay.className = "absolute inset-0 z-[12] pointer-events-none transition-all duration-300";

    if (color === "RED") {
        overlay.classList.add('active-r');
        speak("빨간불입니다. 건너지 마세요.");
    } else if (color === "GREEN") {
        overlay.classList.add('active-g');
        speak("초록불입니다. 건너셔도 좋습니다.");
    }

    lastColor = color;
}

/**
 * 7. 화면에 박스 및 상태 표시
 */
function drawSmartBox(x, y, w, h, color, score) {
    // 상태별 색상 설정
    const strokeColor = color === "RED" ? "#ef4444" : (color === "GREEN" ? "#22c55e" : "#3b82f6");
    
    canvasCtx.strokeStyle = strokeColor;
    canvasCtx.lineWidth = 4;
    canvasCtx.strokeRect(x, y, w, h);

    // 상하단 분석 구분선 (시각적 피드백)
    canvasCtx.setLineDash([5, 5]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, y + h/2);
    canvasCtx.lineTo(x + w, y + h/2);
    canvasCtx.stroke();
    canvasCtx.setLineDash([]);

    // 텍스트 정보 표시
    canvasCtx.fillStyle = strokeColor;
    canvasCtx.font = "bold 16px Arial";
    canvasCtx.fillText(`${color} (${Math.round(score * 100)}%)`, x, y > 20 ? y - 10 : y + 20);
}
