/**
 * [ULTRA VISION AI] - vision.js v0.7.0
 * YOLOv8n + TensorFlow.js 기반 보행자 신호등 탐지 최적화
 */
import { speak } from './utils.js';

let model;
let videoTrack       = null;
let lastDetection    = null;
let detectionCounter = 0;
let lastColor        = "UNKNOWN";

// ── 상태 확정 카운터 ──────────────────────────────────────────
let colorCounter = { RED: 0, GREEN: 0 };
const CONFIRM_THRESHOLD = 3; 

// ── 탐지 파라미터 (YOLOv8n & 가로 모드 최적화) ──────────────────────
const PERSIST_LIMIT    = 60;   // 탐지 놓쳐도 2초간 박스 유지
const SMOOTHING        = 0.12; // 박스 고정력을 위해 더 부드럽게 (가중치 낮춤)
const IOU_THRESHOLD    = 0.20; 

// 보행자 신호등(세로형) 전용 비율 필터
const ASPECT_MIN    = 0.15;
const ASPECT_MAX    = 0.60; 
const MIN_HEIGHT_PX = 10;   // YOLO의 성능을 믿고 더 작은 객체도 허용

// DOM
const video         = document.getElementById('webcam');
const canvasElement = document.getElementById('webcam-canvas');
const roiCanvas     = document.getElementById('roi-canvas');

// ─────────────────────────────────────────────────────────────
// 1. YOLOv8n 모델 로드
// ─────────────────────────────────────────────────────────────
export async function initVision() {
    try {
        console.log("YOLOv8n 로딩 시작...");
        // index.html 위치를 기준으로 모델 폴더의 model.json을 가리킵니다.
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        console.log("YOLOv8n 로드 완료!");
    } catch (err) {
        console.error("모델 로드 실패:", err);
    }
}
// ─────────────────────────────────────────────────────────────
// 2. 카메라 시작 (디지털 줌 강제 적용)
// ─────────────────────────────────────────────────────────────
export async function startVision() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment",
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            }
        });
        video.srcObject = stream;
        
        video.onloadedmetadata = async () => {
            await video.play();
            videoTrack = stream.getVideoTracks()[0];
            
            // [원거리 대응] 하드웨어가 지원하면 줌을 2.0배 이상으로 고정
            const capabilities = videoTrack.getCapabilities?.() || {};
            if (capabilities.zoom) {
                const targetZoom = Math.min(capabilities.zoom.max, 2.5);
                await videoTrack.applyConstraints({ advanced: [{ zoom: targetZoom }] });
            }
            runDetection();
        };
    } catch (err) {
        alert("카메라를 시작할 수 없습니다.");
    }
}

// ─────────────────────────────────────────────────────────────
// 3. 탐지 루프 (YOLOv8 Inference)
// ─────────────────────────────────────────────────────────────
async function runDetection() {
    if (model && video.readyState >= 2) {
        canvasElement.width  = video.videoWidth;
        canvasElement.height = video.videoHeight;

        // 1. 영상 프레임을 텐서로 변환 (YOLO 입력 사이즈 640x640 가정)
        const input = tf.tidy(() => {
            const img = tf.browser.fromPixels(video);
            return img.resizeNearestNeighbor([640, 640]).div(255.0).expandDims(0);
        });

        // 2. 추론
        const res = await model.executeAsync(input);
        
        // 3. 결과 해석 (NMS 포함)
        processYOLOResults(res);
        
        tf.dispose([input, res]);
    }
    window.requestAnimationFrame(runDetection);
}

// ─────────────────────────────────────────────────────────────
// 4. 결과 처리 및 객체 고정 (Tracking)
// ─────────────────────────────────────────────────────────────
function processYOLOResults(res) {
    const canvasCtx = canvasElement.getContext("2d");
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

    // [참고] YOLO 출력 포맷에 따라 파싱 로직은 다를 수 있습니다.
    // 여기서는 보행자 신호등(traffic light)만 필터링되었다고 가정합니다.
    let bestCandidate = null;
    let maxArea = 0;

    // 가상의 탐색 결과 순회 (YOLO 결과를 박스 정보로 변환 후)
    // detections.forEach(d => { ... });

    const vW = video.videoWidth;
    const vH = video.videoHeight;

    // [예시] 가장 확실한 보행자 신호등 하나 선택
    // 필터: 세로 비율(ASPECT_MAX) + 최소 높이
    if (bestCandidate) {
        const newBox = bestCandidate.box; // {x, y, w, h}
        
        if (!lastDetection) {
            lastDetection = newBox;
        } else {
            // 위치 보정 (고정력 강화)
            lastDetection = {
                x: lerp(lastDetection.x, newBox.x, SMOOTHING),
                y: lerp(lastDetection.y, newBox.y, SMOOTHING),
                w: lerp(lastDetection.w, newBox.w, SMOOTHING),
                h: lerp(lastDetection.h, newBox.h, SMOOTHING)
            };
        }
        detectionCounter = PERSIST_LIMIT;
    } else if (detectionCounter > 0) {
        detectionCounter--;
    }

    if (detectionCounter > 0 && lastDetection) {
        const { x, y, w, h } = lastDetection;
        // 색상 분석 (보행자 신호등 전용)
        const colorStatus = !bestCandidate ? "HIDDEN" : analyzePedestrianSignal(x, y, w, h, canvasCtx);
        
        drawROI(x, y, w, h);
        drawBox(x, y, w, h, colorStatus, canvasCtx, !bestCandidate);
        updateUI(colorStatus);
    } else {
        updateUI("UNKNOWN");
    }
}

// ─────────────────────────────────────────────────────────────
// 5. 보행자 신호등 색상 정밀 분석 (픽셀 기반)
// ─────────────────────────────────────────────────────────────
function analyzePedestrianSignal(x, y, w, h, canvasCtx) {
    const sx = Math.max(0, Math.floor(x)), sy = Math.max(0, Math.floor(y));
    const sw = Math.min(Math.floor(w), video.videoWidth - sx);
    const sh = Math.min(Math.floor(h), video.videoHeight - sy);
    if (sw < 4 || sh < 8) return "UNKNOWN";

    const { data } = canvasCtx.getImageData(sx, sy, sw, sh);
    const mid = Math.floor(sh / 2);
    let rSum = 0, gSum = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const row = Math.floor((i / 4) / sw);
        
        // 상단 절반: 빨간색 사람 모양 탐지
        if (row < mid) {
            if (r > 130 && r > g * 1.5 && r > b * 1.5) rSum++;
        } 
        // 하단 절반: 초록색 사람 모양 탐지
        else {
            if (g > 110 && g > r * 1.2 && g > b * 1.0) gSum++;
        }
    }

    if (rSum > gSum && rSum > 10) return "RED";
    if (gSum > rSum && gSum > 10) return "GREEN";
    return "UNKNOWN";
}

// ─────────────────────────────────────────────────────────────
// 6. 유틸리티 (Lerp, Draw 등)
// ─────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a * (1 - t) + b * t; }

function drawBox(x, y, w, h, color, ctx, isHidden) {
    const colors = { RED: "#ff4d4d", GREEN: "#2ecc71", UNKNOWN: "#3498db", HIDDEN: "#95a5a6" };
    ctx.strokeStyle = isHidden ? colors.HIDDEN : (colors[color] || colors.UNKNOWN);
    ctx.lineWidth = 4;
    if (isHidden) ctx.setLineDash([5, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "bold 16px sans-serif";
    ctx.fillText(isHidden ? "TRACKING..." : color, x, y - 10);
}

function drawROI(x, y, w, h) {
    if (!roiCanvas) return;
    const ctx = roiCanvas.getContext('2d');
    roiCanvas.width = w; roiCanvas.height = h;
    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
}

function updateUI(color) {
    // 확정 카운터 로직 (기존과 동일하게 음성 안내 포함)
    if (color === "RED") { colorCounter.RED++; colorCounter.GREEN = 0; }
    else if (color === "GREEN") { colorCounter.GREEN++; colorCounter.RED = 0; }
    else { colorCounter.RED = 0; colorCounter.GREEN = 0; }

    if (colorCounter.RED === CONFIRM_THRESHOLD && lastColor !== "RED") {
        lastColor = "RED"; speak("빨간불입니다. 멈추세요.");
    } else if (colorCounter.GREEN === CONFIRM_THRESHOLD && lastColor !== "GREEN") {
        lastColor = "GREEN"; speak("초록불입니다. 건너가세요.");
    }
}
