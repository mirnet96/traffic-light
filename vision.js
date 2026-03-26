/**
 * [ULTRA VISION AI] - vision.js
 * 대한민국 보행자 신호등 전용 인식 로직
 *
 * [버그 수정]
 * - BUG FIX: reduce 콜백 내 변수 섀도잉 ('b' → 'd') 으로 인한 런타임 에러 수정
 * - BUG FIX: MIN_HEIGHT_PX 단위 불일치 수정 — MediaPipe boundingBox는 픽셀이 아닌
 *            정규화 좌표(0~1)이므로 video.videoHeight를 곱해 실제 픽셀로 변환
 * - BUG FIX: getImageData 전 drawImage 누락 가능성 수정
 *            — detectionCounter > 0 블록 진입 전에 항상 canvas를 최신 프레임으로 갱신
 *
 * 핵심 전략:
 * 1. MediaPipe "traffic light" 후보에서 세로 직사각형 종횡비만 통과
 * 2. ROI를 상(42%) / 중간 제외 / 하(42%)로 분리
 *    상단 존: 빨간 픽셀 비율 (서 있는 사람)
 *    하단 존: 초록 픽셀 비율 (걷는 사람)
 * 3. 검은 배경 위 밝은 색만 유효 (brightness < 80 제외)
 * 4. IOU 기반 안정화: 같은 신호등이면 스무딩, 다른 위치면 즉시 교체
 */
import { ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";
import { speak } from './utils.js';

let objectDetector;
let lastColor        = "UNKNOWN";
let videoTrack       = null;
let lastDetection    = null;
let detectionCounter = 0;

// ── 파라미터 ─────────────────────────────────────────────────
const PERSIST_LIMIT   = 25;   // 미감지 후 유지 프레임
const SMOOTHING       = 0.55; // 스무딩 계수
const IOU_THRESHOLD   = 0.25; // IOU 이 이하면 새 박스로 교체

// 한국 보행자 신호등 종횡비 (width/height)
const ASPECT_MIN      = 0.28;
const ASPECT_MAX      = 0.65;
const MIN_HEIGHT_PX   = 40;   // 너무 작은 원거리 제외 (실제 픽셀 기준)

// 색상 판정 임계값
const SCORE_THRESHOLD = 180;  // 존 누적 점수 최솟값
const RATIO_THRESHOLD = 0.50; // 존 색상 픽셀 비율 최솟값

// DOM
const video         = document.getElementById('webcam');
const canvasElement = document.getElementById('webcam-canvas');
const debugPanel    = document.getElementById('debug-panel');
const roiCanvas     = document.getElementById('roi-canvas');

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
        scoreThreshold: 0.30,
        runningMode: "VIDEO"
    });
}

// ─────────────────────────────────────────────────────────────
// 2. 카메라 시작
// ─────────────────────────────────────────────────────────────
export async function startVision() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: 1280, height: 720 }
        });
        video.srcObject = stream;
        videoTrack = stream.getVideoTracks()[0];

        const capabilities = videoTrack.getCapabilities();
        if (capabilities.zoom) {
            videoTrack.applyConstraints({ advanced: [{ zoom: 2.0 }] });
        }

        video.onloadeddata = () => { video.play(); predictWebcam(); };
    } catch (err) {
        console.error("Camera Error:", err);
        alert("카메라를 시작할 수 없습니다.");
    }
}

// ─────────────────────────────────────────────────────────────
// 3. 매 프레임 루프
// ─────────────────────────────────────────────────────────────
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
// 4. 한국 보행자 신호등 형태 필터 + 안정화
// ─────────────────────────────────────────────────────────────
function processDetections(result) {
    const canvasCtx = canvasElement.getContext("2d");
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // [FIX] getImageData 전 항상 현재 프레임을 canvas에 그려야 최신 픽셀 데이터를 얻을 수 있음
    // 이전 코드에서는 detectionCounter > 0 블록 안에서만 drawImage를 호출했기 때문에,
    // detectionCounter가 막 0이 되는 프레임에서 오래된 픽셀로 색상 분석될 수 있었음
    canvasCtx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

    // 후보 필터: traffic light + 세로 직사각형 종횡비 + 최소 높이
    // [FIX] MediaPipe boundingBox는 정규화 좌표(0~1)이므로 실제 픽셀 높이로 변환
    const candidates = result.detections.filter(d => {
        if (d.categories[0].categoryName !== "traffic light") return false;
        const b        = d.boundingBox;
        const aspect   = b.width / b.height;
        const heightPx = b.height * video.videoHeight; // [FIX] 픽셀 단위로 변환
        return aspect >= ASPECT_MIN && aspect <= ASPECT_MAX && heightPx >= MIN_HEIGHT_PX;
    });

    // 여러 후보 중 가장 큰 것 선택
    // [FIX] reduce 콜백 내부 area 함수의 파라미터명을 'd'로 변경
    //       기존 'b'는 상위 스코프의 변수명과 충돌해 런타임 에러를 유발
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
                // 위치 급변 → 새 신호등으로 교체
                lastDetection = { ...newBox };
            } else {
                // 동일 신호등 → 스무딩
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

        const colorStatus = analyzeKoreanSignal(x, y, w, h, canvasCtx);
        updateUI(colorStatus);
        drawROI(x, y, w, h);
        drawBox(x, y, w, h, colorStatus, canvasCtx);

        if (debugPanel) debugPanel.style.opacity = "1";
    } else {
        if (debugPanel) debugPanel.style.opacity = "0";
        updateUI("UNKNOWN");
        lastDetection = null;
    }
}

// ─────────────────────────────────────────────────────────────
// 5. 색상 분석: 상단(빨강) / 하단(초록) 존 분리
//    한국 보행자 신호등: 검은 함체에 상단 빨간 사람, 하단 초록 사람
// ─────────────────────────────────────────────────────────────
function analyzeKoreanSignal(x, y, w, h, canvasCtx) {
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const sw = Math.min(Math.floor(w), video.videoWidth  - sx);
    const sh = Math.min(Math.floor(h), video.videoHeight - sy);
    if (sw < 8 || sh < 16) return "UNKNOWN";

    const { data } = canvasCtx.getImageData(sx, sy, sw, sh);

    // 상단 존: 0~42% / 하단 존: 58~100% (중앙 16%는 분리선 노이즈 제외)
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
            const br = Math.max(r, g, b); // 밝기

            // 검은 배경 제거: 밝기 80 미만은 배경으로 간주
            if (br < 80) continue;

            if (inTop) {
                topPx++;
                if (isRedPixel(r, g, b)) { redPx++;   redScore   += br; }
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

// ─────────────────────────────────────────────────────────────
// 6. 색상 헬퍼
// ─────────────────────────────────────────────────────────────

/** 한국 신호등 적색: R 압도적으로 높고 G, B 낮음 */
function isRedPixel(r, g, b) {
    return r > 140 && r > g * 1.8 && r > b * 1.8;
}

/** 한국 신호등 녹색: G > R이며 연두~초록 범위 */
function isGreenPixel(r, g, b) {
    return g > 100 && g > r * 1.2 && g > b * 1.1 && r < 180;
}

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
    if (color === lastColor) return;
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

function drawROI(x, y, w, h) {
    if (!roiCanvas) return;
    const ctx = roiCanvas.getContext('2d');
    roiCanvas.width  = w;
    roiCanvas.height = h;
    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);

    // 상/하 존 경계선 시각화 (디버그)
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    [h * 0.42, h * 0.58].forEach(lineY => {
        ctx.beginPath(); ctx.moveTo(0, lineY); ctx.lineTo(w, lineY); ctx.stroke();
    });
    ctx.setLineDash([]);
}

function drawBox(x, y, w, h, color, canvasCtx) {
    const c = { RED: "#ef4444", GREEN: "#22c55e", UNKNOWN: "#3b82f6" };
    canvasCtx.strokeStyle = c[color] || c.UNKNOWN;
    canvasCtx.lineWidth   = 4;
    canvasCtx.strokeRect(x, y, w, h);

    // 종횡비 디버그 표시
    canvasCtx.fillStyle = c[color] || c.UNKNOWN;
    canvasCtx.font      = "bold 14px monospace";
    canvasCtx.fillText(`${color}  r:${(w / h).toFixed(2)}`, x + 4, y + 18);
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
