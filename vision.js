/**
 * [ULTRA VISION AI] - vision.js
 * v0.5.3 — 카메라 안정화 + 로컬 모델 + 한국형 신호등 분석 (전체 소스)
 */
import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './utils.js';

let objectDetector;
let lastColor        = "UNKNOWN";
let videoTrack       = null;
let lastDetection    = null;
let detectionCounter = 0;

// ── 상태 확정 카운터 ──────────────────────────────────────────
let colorCounter = { RED: 0, GREEN: 0 };
const CONFIRM_THRESHOLD = 4;

// ── 탐지 파라미터 (최적화) ──────────────────────────────────────
const SCAN_ZONE_TOP    = 0.03;
const SCAN_ZONE_BOTTOM = 0.72;
const PERSIST_LIMIT    = 45;
const SMOOTHING        = 0.20;
const IOU_THRESHOLD    = 0.25;

const ASPECT_MIN    = 0.18;
const ASPECT_MAX    = 1.00;
const MIN_HEIGHT_PX = 18;

const SCORE_THRESHOLD = 60;
const RATIO_THRESHOLD = 0.25;

// DOM
const video         = document.getElementById('webcam');
const canvasElement = document.getElementById('webcam-canvas');
const debugPanel    = document.getElementById('debug-panel');
const roiCanvas     = document.getElementById('roi-canvas');

// ─────────────────────────────────────────────────────────────
// 1. 모델 초기화
// ─────────────────────────────────────────────────────────────
export async function initVision() {
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        
        // CORS 문제를 피하기 위해 로컬 경로 사용
        objectDetector = await ObjectDetector.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `./models/efficientdet_lite0.tflite`, 
                delegate: "GPU"
            },
            scoreThreshold: 0.22,
            runningMode: "VIDEO"
        });
        
        console.log("Vision AI Model Loaded Successfully!");
        
    } catch (err) {
        console.error("AI Model Initialization Failed:", err);
        speak("에이아이 모델 로딩에 실패했습니다. 모델 파일 경로를 확인하세요.");
    }
}

// ─────────────────────────────────────────────────────────────
// 2. 카메라 시작 (모바일 안정성 강화)
// ─────────────────────────────────────────────────────────────
export async function startVision() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment",
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });

        video.srcObject = stream;

        // metadata 로드 후 재생 및 루프 시작
        video.onloadedmetadata = () => {
            video.play().then(() => {
                predictWebcam();
            }).catch(e => console.error("Play Error:", e));
        };

        videoTrack = stream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities?.() || {};
        
        // 줌 설정 (지원 기기만)
        if (capabilities.zoom) {
            videoTrack.applyConstraints({ advanced: [{ zoom: 1.0 }] }).catch(() => {});
        }

    } catch (err) {
        console.error("Camera Error:", err);
        alert("카메라를 시작할 수 없습니다. 권한 설정을 확인하세요.");
    }
}

// ─────────────────────────────────────────────────────────────
// 3. 매 프레임 루프
// ─────────────────────────────────────────────────────────────
async function predictWebcam() {
    if (objectDetector && video.readyState >= 2) {
        // 캔버스 크기 동기화
        if (canvasElement.width !== video.videoWidth) {
            canvasElement.width  = video.videoWidth;
            canvasElement.height = video.videoHeight;
        }
        
        const result = await objectDetector.detectForVideo(video, performance.now());
        processDetections(result);
    }
    window.requestAnimationFrame(predictWebcam);
}

// ─────────────────────────────────────────────────────────────
// 4. 탐지 처리 + 안정화 (Smoothing)
// ─────────────────────────────────────────────────────────────
function processDetections(result) {
    const canvasCtx = canvasElement.getContext("2d");
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

    const vH = video.videoHeight;
    const vW = video.videoWidth;

    const candidates = result.detections.filter(d => {
        if (d.categories[0].categoryName !== "traffic light") return false;
        const b       = d.boundingBox;
        const centerY = (b.originY + b.height / 2) / vH;
        if (centerY < SCAN_ZONE_TOP || centerY > SCAN_ZONE_BOTTOM) return false;
        const aspect   = b.width / b.height;
        const heightPx = b.height * vH;
        return aspect >= ASPECT_MIN && aspect <= ASPECT_MAX && heightPx >= MIN_HEIGHT_PX;
    });

    const best = candidates.reduce((prev, cur) => {
        const area = d => d.boundingBox.width * d.boundingBox.height;
        return !prev || area(cur) > area(prev) ? cur : prev;
    }, null);

    if (best) {
        const newBox = best.boundingBox;
        if (!lastDetection) {
            lastDetection = { ...newBox };
        } else {
            const iou = calcIOU(lastDetection, newBox);
            if (iou < IOU_THRESHOLD) {
                lastDetection = { ...newBox };
            } else {
                lastDetection = {
                    originX: lerp(lastDetection.originX, newBox.originX, SMOOTHING),
                    originY: lerp(lastDetection.originY, newBox.originY, SMOOTHING),
                    width:   lerp(lastDetection.width,   newBox.width,   SMOOTHING),
                    height:  lerp(lastDetection.height,  newBox.height,  SMOOTHING),
                };
            }
        }
        detectionCounter = PERSIST_LIMIT;
    } else {
        if (detectionCounter > 0) detectionCounter--;
    }

    if (detectionCounter > 0 && lastDetection) {
        const { originX: x, originY: y, width: w, height: h } = lastDetection;
        const isOccluded  = !best;
        const colorStatus = isOccluded ? "HIDDEN" : analyzeKoreanSignal(x, y, w, h, canvasCtx);

        updateUI(colorStatus);
        drawROI(x, y, w, h);
        drawBox(x, y, w, h, colorStatus, canvasCtx, isOccluded);
        if (debugPanel) debugPanel.style.opacity = "1";
    } else {
        if (debugPanel) debugPanel.style.opacity = "0";
        updateUI("UNKNOWN");
        lastDetection = null;
    }

    // 스캔존 경계 표시
    canvasCtx.strokeStyle = "rgba(59,130,246,0.3)";
    canvasCtx.lineWidth   = 1;
    canvasCtx.setLineDash([6, 4]);
    canvasCtx.beginPath(); canvasCtx.moveTo(0, SCAN_ZONE_TOP * vH);    canvasCtx.lineTo(vW, SCAN_ZONE_TOP * vH);    canvasCtx.stroke();
    canvasCtx.beginPath(); canvasCtx.moveTo(0, SCAN_ZONE_BOTTOM * vH); canvasCtx.lineTo(vW, SCAN_ZONE_BOTTOM * vH); canvasCtx.stroke();
    canvasCtx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────
// 5. 색상 분석 (Top/Bottom 픽셀 분석)
// ─────────────────────────────────────────────────────────────
function analyzeKoreanSignal(x, y, w, h, canvasCtx) {
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const sw = Math.min(Math.floor(w), video.videoWidth  - sx);
    const sh = Math.min(Math.floor(h), video.videoHeight - sy);
    if (sw < 6 || sh < 12) return "UNKNOWN";

    const { data } = canvasCtx.getImageData(sx, sy, sw, sh);
    const topEnd      = Math.floor(sh * 0.42);
    const bottomStart = Math.floor(sh * 0.58);

    let redScore = 0, redPx = 0, topPx = 0;
    let greenScore = 0, greenPx = 0, botPx = 0;

    for (let row = 0; row < sh; row++) {
        const inTop = row < topEnd;
        const inBot = row >= bottomStart;
        if (!inTop && !inBot) continue;
        for (let col = 0; col < sw; col++) {
            const i  = (row * sw + col) * 4;
            const r  = data[i], g = data[i + 1], b = data[i + 2];
            const br = Math.max(r, g, b);
            if (br < 70) continue;
            if (inTop) {
                topPx++;
                if (isRedPixel(r, g, b)) { redPx++; redScore += br; }
            } else {
                botPx++;
                if (isGreenPixel(r, g, b)) { greenPx++; greenScore += br; }
            }
        }
    }

    const redRatio   = topPx > 0 ? redPx   / topPx : 0;
    const greenRatio = botPx > 0 ? greenPx / botPx : 0;
    updateGauge(redRatio, greenRatio);

    const isRed   = redScore   > SCORE_THRESHOLD && redRatio   > RATIO_THRESHOLD;
    const isGreen = greenScore > SCORE_THRESHOLD && greenRatio > RATIO_THRESHOLD;

    if (isRed  && !isGreen) return "RED";
    if (isGreen && !isRed)  return "GREEN";
    if (isRed  && isGreen)  return redScore >= greenScore ? "RED" : "GREEN";
    return "UNKNOWN";
}

function isRedPixel(r, g, b)   { return r > 110 && r > g * 1.5 && r > b * 1.5; }
function isGreenPixel(r, g, b) { return g > 80  && g > r * 1.1 && g > b * 1.0 && r < 200; }

// ─────────────────────────────────────────────────────────────
// 6. UI 및 결과 처리
// ─────────────────────────────────────────────────────────────
function updateGauge(redRatio, greenRatio) {
    const rPct = Math.round(redRatio   * 100);
    const gPct = Math.round(greenRatio * 100);
    const el = id => document.getElementById(id);
    if (el('red-bar'))   el('red-bar').style.width   = `${rPct}%`;
    if (el('green-bar')) el('green-bar').style.width = `${gPct}%`;
    if (el('red-val'))   el('red-val').innerText     = `${rPct}%`;
    if (el('green-val')) el('green-val').innerText   = `${gPct}%`;
}

function updateUI(color) {
    if (color === "HIDDEN") return;

    if (color === "RED")        { colorCounter.RED++;   colorCounter.GREEN = 0; }
    else if (color === "GREEN") { colorCounter.GREEN++; colorCounter.RED   = 0; }
    else                        { colorCounter.RED = 0; colorCounter.GREEN = 0; }

    let confirmed = "UNKNOWN";
    if (colorCounter.RED   >= CONFIRM_THRESHOLD) confirmed = "RED";
    if (colorCounter.GREEN >= CONFIRM_THRESHOLD) confirmed = "GREEN";

    if (confirmed === lastColor || (confirmed === "UNKNOWN" && color !== "UNKNOWN")) return;

    const overlay = document.getElementById('border-overlay');
    if (confirmed === "RED") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none active-r";
        speak("빨간불입니다. 정지하세요.");
    } else if (confirmed === "GREEN") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none active-g";
        speak("초록불입니다. 건너가세요.");
    } else if (confirmed === "UNKNOWN" && color === "UNKNOWN") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none";
    }

    if (confirmed !== "UNKNOWN") lastColor = confirmed;
}

function drawROI(x, y, w, h) {
    if (!roiCanvas) return;
    const ctx = roiCanvas.getContext('2d');
    roiCanvas.width  = w;
    roiCanvas.height = h;
    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    [h * 0.42, h * 0.58].forEach(lineY => {
        ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(w, lineY); ctx.stroke();
    });
    ctx.setLineDash([]);
}

function drawBox(x, y, w, h, color, canvasCtx, isOccluded = false) {
    const c = { RED: "#ef4444", GREEN: "#22c55e", UNKNOWN: "#3b82f6", HIDDEN: "#9ca3af" };
    canvasCtx.strokeStyle = isOccluded ? c.HIDDEN : (c[color] || c.UNKNOWN);
    canvasCtx.lineWidth   = 4;
    if (isOccluded) canvasCtx.setLineDash([5, 5]);
    canvasCtx.strokeRect(x, y, w, h);
    canvasCtx.setLineDash([]);
    canvasCtx.fillStyle = canvasCtx.strokeStyle;
    canvasCtx.font      = "bold 13px monospace";
    canvasCtx.fillText(isOccluded ? `OCCLUDED r:${(w/h).toFixed(2)}` : `${color} r:${(w/h).toFixed(2)}`, x + 4, y - 6);
}

// ─────────────────────────────────────────────────────────────
// 7. 유틸리티
// ─────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a * (1 - t) + b * t; }
function calcIOU(a, b) {
    const ax2 = a.originX + a.width,  ay2 = a.originY + a.height;
    const bx2 = b.originX + b.width,  by2 = b.originY + b.height;
    const ix  = Math.max(0, Math.min(ax2, bx2) - Math.max(a.originX, b.originX));
    const iy  = Math.max(0, Math.min(ay2, by2) - Math.max(a.originY, b.originY));
    const inter = ix * iy;
    if (inter === 0) return 0;
    return inter / (a.width * a.height + b.width * b.height - inter);
}
