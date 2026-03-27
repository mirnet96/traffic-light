/**
 * [ULTRA VISION AI] - vision.js
 * 방해물(사람/자동차) 가림 대응 및 가로 스캔 고정력 강화 버전
 */
import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './utils.js';

let objectDetector;
let lastColor        = "UNKNOWN";
let videoTrack       = null;
let lastDetection    = null; // 보정된 최종 좌표 저장용
let detectionCounter = 0;

// ── 상태 확정 카운터 ───────────────────────────────────
let colorCounter = { RED: 0, GREEN: 0 };
const CONFIRM_THRESHOLD = 5; 

// ── [가로 탐지 및 방해물 대응 파라미터] ──────────────────────
const SCAN_ZONE_TOP    = 0.12; // 스캔 영역 상단 (0.0 ~ 1.0)
const SCAN_ZONE_BOTTOM = 0.58; // 스캔 영역 하단

const PERSIST_LIMIT   = 60;    // 가림 현상 대응: 감지 실패 시 약 2초간 기존 위치 유지 (30 -> 60)
const SMOOTHING       = 0.15;  // 더 묵직하게 고정하여 보행자 움직임에 튀지 않음 (0.20 -> 0.15)
const IOU_THRESHOLD   = 0.30;  // 박스가 급격히 변할 때만 타겟 교체 (0.40 -> 0.30)

// 한국 보행자 신호등 종횡비 및 최소 크기
const ASPECT_MIN      = 0.28;
const ASPECT_MAX      = 0.75; 
const MIN_HEIGHT_PX   = 40;   

// 색상 판정 임계값
const SCORE_THRESHOLD = 180;  
const RATIO_THRESHOLD = 0.50; 

// DOM
const video         = document.getElementById('webcam');
const canvasElement = document.getElementById('webcam-canvas');
const debugPanel    = document.getElementById('debug-panel');
const roiCanvas      = document.getElementById('roi-canvas');

// ─────────────────────────────────────────────────────────────
// 1. 모델 초기화
// ─────────────────────────────────────────────────────────────
export async function initVision() {
    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    objectDetector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite`,
            delegate: "GPU"
        },
        scoreThreshold: 0.40, // 사람/차량 오검출 방지를 위해 문턱값 상향
        runningMode: "VIDEO"
    });
}

// ─────────────────────────────────────────────────────────────
// 2. 카메라 시작 (광각 및 와이드 뷰 확보)
// ─────────────────────────────────────────────────────────────
export async function startVision() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: "environment", 
                width: { ideal: 1280 }, 
                height: { ideal: 720 },
                aspectRatio: { ideal: 1.777 }
            }
        });
        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0];

        const capabilities = videoTrack.getCapabilities();
        const constraints = { advanced: [] };
        
        if (capabilities.zoom) {
            constraints.advanced.push({ zoom: 1.0 }); // 광각 유지
        }
        
        if (capabilities.exposureCompensation) {
            constraints.advanced.push({ exposureCompensation: -1.5 });
        }

        if (constraints.advanced.length > 0) {
            await videoTrack.applyConstraints(constraints);
        }

        video.onloadeddata = () => { video.play(); predictWebcam(); };
    } catch (err) {
        console.error("Camera Error:", err);
        alert("카메라를 시작할 수 없습니다.");
    }
}

async function predictWebcam() {
    if (objectDetector && video.readyState >= 2) {
        canvasElement.width  = video.videoWidth;
        canvasElement.height = video.videoHeight;
        const result = await objectDetector.detectForVideo(video, performance.now());
        processDetections(result);
    }
    window.requestAnimationFrame(predictWebcam);
}

// ─────────────────────────────────────────────────────────────
// 4. 가로 스캔 필터 + 가림(Occlusion) 대응 로직
// ─────────────────────────────────────────────────────────────
function processDetections(result) {
    const canvasCtx = canvasElement.getContext("2d");
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

    const candidates = result.detections.filter(d => {
        if (d.categories[0].categoryName !== "traffic light") return false;
        const b = d.boundingBox;
        const vH = video.videoHeight;
        const centerY = (b.originY + b.height / 2) / vH;
        
        // 1. 가로 스캔 존 필터링
        if (centerY < SCAN_ZONE_TOP || centerY > SCAN_ZONE_BOTTOM) return false;

        // 2. 종횡비 및 크기 필터링
        const aspect = b.width / b.height;
        return aspect >= ASPECT_MIN && aspect <= ASPECT_MAX && (b.height * vH) >= MIN_HEIGHT_PX;
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
            // 가려짐이 발생하더라도 기존 위치 근처면 부드럽게 추적
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
        // [핵심] 신호등이 가려졌을 때(best 없음) 기존 박스를 즉시 지우지 않고 카운트다운
        if (detectionCounter > 0) detectionCounter--;
    }

    if (detectionCounter > 0 && lastDetection) {
        const { originX: x, originY: y, width: w, height: h } = lastDetection;
        
        // 가려진 상태(best가 없을 때)에서는 색상 분석을 시도하지 않고 'HIDDEN' 상태 전달
        let colorStatus = "UNKNOWN";
        if (best) {
            colorStatus = analyzeKoreanSignal(x, y, w, h, canvasCtx);
        } else {
            colorStatus = "HIDDEN"; // 추적은 하되 색상은 알 수 없음
        }

        updateUI(colorStatus); 
        drawROI(x, y, w, h);
        drawBox(x, y, w, h, colorStatus, canvasCtx, !best);
        if (debugPanel) debugPanel.style.opacity = "1";
    } else {
        if (debugPanel) debugPanel.style.opacity = "0";
        updateUI("UNKNOWN");
        lastDetection = null;
    }
}

// ─────────────────────────────────────────────────────────────
// 5. 색상 분석 (기존 유지)
// ─────────────────────────────────────────────────────────────
function analyzeKoreanSignal(x, y, w, h, canvasCtx) {
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const sw = Math.min(Math.floor(w), video.videoWidth  - sx);
    const sh = Math.min(Math.floor(h), video.videoHeight - sy);
    if (sw < 8 || sh < 16) return "UNKNOWN";

    const { data } = canvasCtx.getImageData(sx, sy, sw, sh);
    const topEnd      = Math.floor(sh * 0.42);
    const bottomStart = Math.floor(sh * 0.58);

    let redScore = 0,   redPx = 0,   topPx = 0;
    let greenScore = 0, greenPx = 0, botPx = 0;

    for (let row = 0; row < sh; row++) {
        const inTop = row < topEnd;
        const inBot = row >= bottomStart;
        if (!inTop && !inBot) continue;

        for (let col = 0; col < sw; col++) {
            const i  = (row * sw + col) * 4;
            const r  = data[i], g = data[i + 1], b = data[i + 2];
            const br = Math.max(r, g, b);

            if (br < 80) continue;

            if (inTop) {
                topPx++;
                if (isRedPixel(r, g, b)) { redPx++;   redScore   += br; }
            } else if (inBot) {
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

function isRedPixel(r, g, b) { return r > 140 && r > g * 1.8 && r > b * 1.8; }
function isGreenPixel(r, g, b) { return g > 100 && g > r * 1.2 && g > b * 1.1 && r < 180; }

// ─────────────────────────────────────────────────────────────
// 7. UI / 렌더링
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
    // 가려진 상태(HIDDEN)일 때는 기존 음성 안내와 상태를 유지함
    if (color === "HIDDEN") return; 

    if (color === "RED") {
        colorCounter.RED++;
        colorCounter.GREEN = 0;
    } else if (color === "GREEN") {
        colorCounter.GREEN++;
        colorCounter.RED = 0;
    } else {
        colorCounter.RED = 0;
        colorCounter.GREEN = 0;
    }

    let confirmedColor = "UNKNOWN";
    if (colorCounter.RED >= CONFIRM_THRESHOLD) confirmedColor = "RED";
    if (colorCounter.GREEN >= CONFIRM_THRESHOLD) confirmedColor = "GREEN";

    if (confirmedColor === lastColor || (confirmedColor === "UNKNOWN" && color !== "UNKNOWN")) return;

    const overlay = document.getElementById('border-overlay');
    if (confirmedColor === "RED") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none active-r";
        speak("빨간불입니다. 정지하세요.");
    } else if (confirmedColor === "GREEN") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none active-g";
        speak("초록불입니다. 건너가세요.");
    } else if (confirmedColor === "UNKNOWN" && color === "UNKNOWN") {
        if (overlay) overlay.className = "absolute inset-0 z-[12] pointer-events-none";
    }
    
    if (confirmedColor !== "UNKNOWN") {
        lastColor = confirmedColor;
    }
}

function drawROI(x, y, w, h) {
    if (!roiCanvas) return;
    const ctx = roiCanvas.getContext('2d');
    roiCanvas.width  = w;
    roiCanvas.height = h;
    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
}

function drawBox(x, y, w, h, color, canvasCtx, isOccluded = false) {
    const c = { RED: "#ef4444", GREEN: "#22c55e", UNKNOWN: "#3b82f6", HIDDEN: "#9ca3af" };
    canvasCtx.strokeStyle = isOccluded ? c.HIDDEN : (c[color] || c.UNKNOWN);
    
    // 가려진 상태면 점선으로 표시
    if (isOccluded) canvasCtx.setLineDash([5, 5]);
    
    canvasCtx.lineWidth = 4;
    canvasCtx.strokeRect(x, y, w, h);
    
    canvasCtx.fillStyle = isOccluded ? c.HIDDEN : (c[color] || c.UNKNOWN);
    canvasCtx.font = "bold 16px monospace";
    const label = isOccluded ? "TRACKING (OCCLUDED)" : `${color} (LOCKED)`;
    canvasCtx.fillText(label, x + 4, y - 8);
    
    canvasCtx.setLineDash([]); // 대시 초기화
}

// ─────────────────────────────────────────────────────────────
// 8. 수학 유틸
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
