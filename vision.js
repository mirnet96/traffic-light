/**
 * [ULTRA VISION AI] - vision.js
 * 대한민국 보행자 신호등(세로형) 최적화 분석 모듈
 */
import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './app.js';

let objectDetector;
let lastColor = "UNKNOWN";
let videoTrack = null;

// DOM 요소 참조
const video = document.getElementById('webcam');
const canvasElement = document.getElementById("webcam-canvas");
const canvasCtx = canvasElement.getContext("2d", {监测Frequently: true });

// [ROI 분석용] 객체 확대 및 데이터 표시용 요소
const debugPanel = document.getElementById('debug-panel');
const roiCanvas = document.getElementById('roi-canvas');
const roiCtx = roiCanvas.getContext('2d');
const redBar = document.getElementById('red-bar');
const greenBar = document.getElementById('green-bar');
const redValText = document.getElementById('red-val');
const greenValText = document.getElementById('green-val');

/**
 * 1. AI 모델 초기화
 * MediaPipe의 ObjectDetector를 로드합니다.
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
        scoreThreshold: 0.35, // 멀리 있는 작은 객체도 잡기 위해 임계값 하향
        runningMode: "VIDEO"
    });
}

/**
 * 2. 카메라 시작 및 줌 제어
 */
export async function startVision() {
    try {
        const constraints = { 
            video: { facingMode: "environment", width: 1280, height: 720 } 
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        
        // 원거리 신호등 대응을 위한 디지털 줌 적용 (지원 기기 한정)
        videoTrack = stream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities();
        if (capabilities.zoom) {
            videoTrack.applyConstraints({ advanced: [{ zoom: 2.5 }] });
        }

        video.onloadeddata = () => {
            video.play();
            predictWebcam();
        };
    } catch (err) {
        console.error("카메라 권한 오류:", err);
    }
}

/**
 * 3. 메인 분석 루프
 */
async function predictWebcam() {
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;
    
    if (objectDetector && video.readyState >= 2) {
        const detections = await objectDetector.detectForVideo(video, performance.now());
        processDetections(detections);
    }
    window.requestAnimationFrame(predictWebcam);
}

/**
 * 4. 객체 필터링 및 분석 실행
 */
function processDetections(result) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    let signalFound = false;

    result.detections.forEach(detection => {
        const category = detection.categories[0].categoryName;
        
        if (category === "traffic light") {
            const { originX, originY, width, height } = detection.boundingBox;

            // [규격 필터] 한국 보행자 신호등은 세로가 가로보다 긴 직사각형입니다.
            if (height > width * 1.2) {
                signalFound = true;
                
                // [ROI 업데이트] 감지된 신호등만 잘라서 디버깅 패널에 표시
                drawROI(originX, originY, width, height);

                // [색상 분석] 위치 기반(상/하) 분석 수행
                const colorStatus = analyzeKoreanSignal(originX, originY, width, height);
                updateUI(colorStatus);
                drawBox(originX, originY, width, height, colorStatus);
            }
        }
    });

    // 신호등이 감지될 때만 분석 패널 노출
    debugPanel.style.opacity = signalFound ? "1" : "0";
    if (!signalFound) updateUI("UNKNOWN");
}

/**
 * 5. 대한민국 보행자 신호등 핵심 분석 로직 (위치 우선 원칙)
 * "상단(50%) 영역이 밝으면 빨강, 하단(50%) 영역이 밝으면 초록"
 */
function analyzeKoreanSignal(x, y, w, h) {
    // 픽셀 데이터 가져오기 (성능을 위해 정수화)
    const startX = Math.max(0, Math.floor(x));
    const startY = Math.max(0, Math.floor(y));
    const data = canvasCtx.getImageData(startX, startY, w, h).data;
    
    let upperScore = 0; // 상단 영역 점수
    let lowerScore = 0; // 하단 영역 점수
    const mid = Math.floor(h / 2); // 박스의 정중앙

    // 픽셀 전체를 조사하되 성능을 위해 간격(step)을 둠
    for (let row = 0; row < h; row += 2) {
        for (let col = 0; col < w; col += 2) {
            const i = (row * w + col) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];

            // 단순히 밝기(Luminance)가 높은 픽셀을 찾습니다.
            const brightness = Math.max(r, g, b);

            if (row < mid) {
                // 상단 영역: 빨간색 성분이 강할 때만 점수 가산
                if (r > g + 40 && r > b + 40) upperScore += brightness;
            } else {
                // 하단 영역: 초록색 성분이 강할 때만 점수 가산
                if (g > r + 30) lowerScore += brightness;
            }
        }
    }

    // 디버깅 패널 그래프 수치 업데이트
    const totalScore = (upperScore + lowerScore) || 1;
    const rPct = Math.round((upperScore / totalScore) * 100);
    const gPct = Math.round((lowerScore / totalScore) * 100);
    
    redBar.style.width = `${rPct}%`;
    redValText.innerText = `${rPct}%`;
    greenBar.style.width = `${gPct}%`;
    greenValText.innerText = `${gPct}%`;

    // 최종 판정 (상대적 점수 비교)
    if (upperScore > lowerScore && upperScore > 500) return "RED";
    if (lowerScore > upperScore && lowerScore > 500) return "GREEN";
    return "UNKNOWN";
}

/**
 * 6. 잘라낸 이미지(ROI)를 디버깅 패널에 그리기
 */
function drawROI(x, y, w, h) {
    roiCanvas.width = w;
    roiCanvas.height = h;
    roiCtx.drawImage(video, x, y, w, h, 0, 0, w, h);
}

/**
 * 7. UI 및 음성 안내 업데이트
 */
function updateUI(color) {
    if (color === lastColor) return; // 상태 변화가 없을 시 중복 실행 방지
    
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

/**
 * 8. 메인 화면 박스 그리기
 */
function drawBox(x, y, w, h, color) {
    canvasCtx.strokeStyle = color === "RED" ? "#ef4444" : (color === "GREEN" ? "#22c55e" : "#3b82f6");
    canvasCtx.lineWidth = 5;
    canvasCtx.strokeRect(x, y, w, h);
    
    // 분석 기준선(중앙선) 표시
    canvasCtx.setLineDash([5, 5]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(x, y + h/2);
    canvasCtx.lineTo(x + w, y + h/2);
    canvasCtx.stroke();
    canvasCtx.setLineDash([]);
}
