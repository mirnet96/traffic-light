/**
 * [ULTRA VISION AI] - vision.js v1.1.0
 * ─────────────────────────────────────────────────────────────
 * 실제 현장 촬영 이미지 분석 기반 스캔 전략 전면 재설계
 *
 * [v1.0 → v1.1 핵심 수정]
 * ① 스캔존 완전 반전: 하단 55% → 상단 10~60%
 *    - 저시력자가 얼굴 높이에서 정면을 비출 때
 *    - 건너편 신호등은 항상 화면 상단 절반 안에 맺힘
 *    - 차량/이미지 노이즈(도로, 보행자)는 하단에 집중
 * ② 가로/세로 촬영 자동 감지 → 스캔존 동적 계산
 * ③ 종횡비 필터 완화: 보행자 신호등이 원거리에서 작게 잡혀도 통과
 * ④ 전체 화면 HSV 폴백도 상단 영역만 스캔하도록 수정
 * ⑤ CONF_THRESHOLD 낮춤 (0.28 → 0.22): 원거리 소형 탐지 대응
 * ─────────────────────────────────────────────────────────────
 */
import { speak } from './utils.js';

// ── 모델 / 트랙 ───────────────────────────────────────────────
let model        = null;
let videoTrack   = null;

// ── 추적 상태 ─────────────────────────────────────────────────
let lastDetection    = null;
let detectionCounter = 0;
let lastColor        = 'UNKNOWN';

// ── 신호 확정 카운터 ─────────────────────────────────────────
let colorCounter = { RED: 0, GREEN: 0, UNKNOWN: 0 };
const CONFIRM_THRESHOLD = 4;

// ── 비프음 ────────────────────────────────────────────────────
let beepInterval = null;
let audioCtx     = null;

// ── 탐지 파라미터 ─────────────────────────────────────────────
const PERSIST_LIMIT  = 45;
const SMOOTHING      = 0.15;
const CONF_THRESHOLD = 0.22;   // 원거리 소형 신호등 대응, 낮게 설정
const NMS_IOU        = 0.40;
const TRAFFIC_LIGHT_CLASS = 9; // COCO class 9 = traffic light

// ── 스캔 존: 실제 촬영 패턴 기반 ─────────────────────────────
// 저시력자가 얼굴 높이에서 정면을 비출 때, 건너편 신호등 위치:
//   세로 촬영: 화면 y 10% ~ 60% 사이 (상단 절반)
//   가로 촬영: 화면 y  5% ~ 55% 사이 (상단 절반)
// 도로면, 보행자, 지면 노이즈는 하단 40%에 집중됨
const SCAN_TOP_RATIO    = 0.08;   // 탐색 시작 y (상단 상한 — 하늘/UI 영역 제외)
const SCAN_BOTTOM_RATIO = 0.62;   // 탐색 종료 y (이 아래는 도로면으로 간주)
// 가로 촬영 시 (videoWidth > videoHeight) 다소 좁게
const SCAN_TOP_LAND    = 0.05;
const SCAN_BOTTOM_LAND = 0.55;

// ── 종횡비 필터 (완화: 원거리에서 작게 잡힌 신호등 허용) ──────
// 보행자 신호등 width/height 비율: 0.20~0.90
// (원거리에서는 픽셀이 작아 비율이 뭉개지므로 범위 확대)
const ASPECT_MIN     = 0.20;
const ASPECT_MAX     = 0.90;
const MIN_BOX_HEIGHT = 10;   // 최소 박스 높이 (px), 원거리 대응

// ── HSV 범위 ──────────────────────────────────────────────────
// 빨강: H=0~22° or 338~360°, S>0.40, V>0.25
const RED_H1_MIN = 0,   RED_H1_MAX = 22;
const RED_H2_MIN = 338, RED_H2_MAX = 360;
const RED_S_MIN  = 0.40, RED_V_MIN = 0.25;
// 초록: H=88~165°, S>0.35, V>0.25
const GRN_H_MIN  = 88,  GRN_H_MAX  = 165;
const GRN_S_MIN  = 0.35, GRN_V_MIN = 0.25;

// ── DOM ───────────────────────────────────────────────────────
const video         = document.getElementById('webcam');
const canvasElement = document.getElementById('webcam-canvas');
const roiCanvas     = document.getElementById('roi-canvas');


// ═════════════════════════════════════════════════════════════
// 스캔 존 계산 헬퍼 (가로/세로 촬영 자동 감지)
// ═════════════════════════════════════════════════════════════
function getScanZone() {
    const vW = video.videoWidth  || 640;
    const vH = video.videoHeight || 480;
    const isLandscape = vW > vH;
    const topR    = isLandscape ? SCAN_TOP_LAND    : SCAN_TOP_RATIO;
    const bottomR = isLandscape ? SCAN_BOTTOM_LAND : SCAN_BOTTOM_RATIO;
    return {
        yMin: Math.floor(vH * topR),
        yMax: Math.floor(vH * bottomR),
        vW, vH, isLandscape
    };
}


// ═════════════════════════════════════════════════════════════
// 1. YOLOv8n 모델 로드
// ═════════════════════════════════════════════════════════════
export async function initVision() {
    try {
        console.log('[Vision v1.1] YOLOv8n 로딩...');
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        const dummy = tf.zeros([1, 640, 640, 3]);
        await model.executeAsync(dummy);
        tf.dispose(dummy);
        console.log('[Vision v1.1] 모델 로드 완료:', model.inputs[0].shape);
        _showDebugPanel();
    } catch (err) {
        console.error('[Vision v1.1] 모델 없음 → HSV 폴백 전용 모드:', err.message);
    }
}


// ═════════════════════════════════════════════════════════════
// 2. 카메라 시작
// ═════════════════════════════════════════════════════════════
export async function startVision() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width:  { ideal: 1920 },
                height: { ideal: 1080 }
            }
        });
        video.srcObject = stream;
        await new Promise(r => { video.onloadedmetadata = r; });
        await video.play();

        videoTrack = stream.getVideoTracks()[0];
        const caps = videoTrack.getCapabilities?.() || {};
        if (caps.zoom) {
            const z = Math.min(caps.zoom.max, 2.5);
            await videoTrack.applyConstraints({ advanced: [{ zoom: z }] });
            console.log(`[Vision v1.1] 광학줌 ${z}× 적용`);
        }

        _showDebugPanel();
        _drawScanZoneGuide(); // 최초 1회 가이드 오버레이 표시
        runDetection();
    } catch (err) {
        console.error('[Vision v1.1] 카메라 오류:', err);
        alert('카메라를 시작할 수 없습니다: ' + err.message);
    }
}


// ═════════════════════════════════════════════════════════════
// 3. 탐지 루프
// ═════════════════════════════════════════════════════════════
async function runDetection() {
    if (video.readyState >= 2) {
        canvasElement.width  = video.videoWidth;
        canvasElement.height = video.videoHeight;

        if (model) {
            let out;
            const inp = tf.tidy(() =>
                tf.browser.fromPixels(video)
                    .resizeNearestNeighbor([640, 640])
                    .div(255.0)
                    .expandDims(0)
            );
            try {
                out = await model.executeAsync(inp);
                _processYOLO(out);
            } catch (e) {
                console.warn('[Vision] 추론 오류 → HSV 폴백:', e.message);
                _processFallback();
            } finally {
                tf.dispose(inp);
                if (out) tf.dispose(out);
            }
        } else {
            _processFallback();
        }
    }
    window.requestAnimationFrame(runDetection);
}


// ═════════════════════════════════════════════════════════════
// 4. YOLO 파싱 — 상단 스캔존 필터 적용
//    출력 포맷: [1, 84, 8400] (cx, cy, w, h, cls×80)
// ═════════════════════════════════════════════════════════════
function _processYOLO(rawOutput) {
    const ctx = canvasElement.getContext('2d');
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ctx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

    const tensor = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput;
    if (!tensor.shape || tensor.shape.length < 3) {
        _updateTracking(null, ctx); return;
    }

    const numDet = tensor.shape[2]; // 8400
    const data   = tensor.dataSync();
    const { yMin, yMax, vW, vH } = getScanZone();

    const candidates = [];

    for (let i = 0; i < numDet; i++) {
        const tlScore = data[(4 + TRAFFIC_LIGHT_CLASS) * numDet + i];
        if (tlScore < CONF_THRESHOLD) continue;

        // YOLO 640 → 실제 해상도
        const cx = data[0 * numDet + i] * vW / 640;
        const cy = data[1 * numDet + i] * vH / 640;
        const bw = data[2 * numDet + i] * vW / 640;
        const bh = data[3 * numDet + i] * vH / 640;
        const x  = cx - bw / 2;
        const y  = cy - bh / 2;

        // ── 필터 1: 상단 스캔존 안에 있는가 ──────────────────
        // 박스 중심 y가 yMin ~ yMax 사이여야 함
        if (cy < yMin || cy > yMax) continue;

        // ── 필터 2: 세로형 종횡비 ────────────────────────────
        if (bh < MIN_BOX_HEIGHT) continue;
        const aspect = bw / bh;
        if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) continue;

        candidates.push({ x, y, w: bw, h: bh, score: tlScore });
    }

    const kept = _nms(candidates, NMS_IOU);

    // 면적×신뢰도 기준 최적 선택
    let best = null, bestScore = 0;
    for (const d of kept) {
        const s = d.w * d.h * d.score;
        if (s > bestScore) { bestScore = s; best = d; }
    }

    // 스캔존 가이드 라인 표시
    _drawScanZoneOverlay(ctx, yMin, yMax, vW, !!best);
    _updateTracking(best, ctx);
}


// ═════════════════════════════════════════════════════════════
// 5. HSV 폴백 — 상단 스캔존만 스캔
// ═════════════════════════════════════════════════════════════
function _processFallback() {
    const ctx = canvasElement.getContext('2d');
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ctx.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);

    const { yMin, yMax, vW, vH } = getScanZone();
    const scanH   = yMax - yMin;
    if (scanH <= 0) return;

    // 상단 스캔존만 getImageData
    const imgData = ctx.getImageData(0, yMin, vW, scanH);
    const result  = _hsvScanRegion(imgData.data, vW, scanH);

    _drawScanZoneOverlay(ctx, yMin, yMax, vW, result !== 'UNKNOWN');
    _applyColorResult(result);

    if (result !== 'UNKNOWN') {
        _drawFallbackLabel(ctx, result, yMin, vW);
    }
}


// ═════════════════════════════════════════════════════════════
// 6. 추적 업데이트 + 렌더링
// ═════════════════════════════════════════════════════════════
function _updateTracking(best, ctx) {
    if (best) {
        if (!lastDetection) {
            lastDetection = { ...best };
        } else {
            lastDetection = {
                x: _lerp(lastDetection.x, best.x, SMOOTHING),
                y: _lerp(lastDetection.y, best.y, SMOOTHING),
                w: _lerp(lastDetection.w, best.w, SMOOTHING),
                h: _lerp(lastDetection.h, best.h, SMOOTHING)
            };
        }
        detectionCounter = PERSIST_LIMIT;
    } else if (detectionCounter > 0) {
        detectionCounter--;
    }

    if (detectionCounter > 0 && lastDetection) {
        const { x, y, w, h } = lastDetection;
        const isTracking = !best;
        const color = isTracking ? 'HIDDEN' : _analyzeBoxHSV(x, y, w, h, ctx);
        _drawROI(x, y, w, h);
        _drawBox(x, y, w, h, color, ctx, isTracking, best?.score);
        _applyColorResult(color);
    } else {
        // YOLO 탐지 없으면 HSV 폴백
        _processFallback();
    }
}


// ═════════════════════════════════════════════════════════════
// 7. HSV 분석
// ═════════════════════════════════════════════════════════════
function _rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const v = max, s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d !== 0) {
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    return { h: h * 360, s, v };
}

function _isRed(h, s, v) {
    if (s < RED_S_MIN || v < RED_V_MIN) return false;
    return (h <= RED_H1_MAX) || (h >= RED_H2_MIN);
}

function _isGreen(h, s, v) {
    if (s < GRN_S_MIN || v < GRN_V_MIN) return false;
    return h >= GRN_H_MIN && h <= GRN_H_MAX;
}

// 박스 ROI: 상단=빨강 사람, 하단=초록 사람 구조
function _analyzeBoxHSV(x, y, w, h, ctx) {
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const sw = Math.min(Math.ceil(w), video.videoWidth  - sx);
    const sh = Math.min(Math.ceil(h), video.videoHeight - sy);
    if (sw < 4 || sh < 8) return 'UNKNOWN';

    const { data } = ctx.getImageData(sx, sy, sw, sh);
    const mid = Math.floor(sh / 2);
    let rC = 0, rT = 0, gC = 0, gT = 0;

    for (let i = 0; i < data.length; i += 4) {
        const row = Math.floor((i / 4) / sw);
        const { h: H, s: S, v: V } = _rgbToHsv(data[i], data[i+1], data[i+2]);
        if (row < mid) { rT++; if (_isRed(H, S, V))   rC++; }
        else           { gT++; if (_isGreen(H, S, V)) gC++; }
    }

    const rR = rT > 0 ? rC / rT : 0;
    const gR = gT > 0 ? gC / gT : 0;
    _setBarValue('red', rR);
    _setBarValue('green', gR);

    const MIN_R = 0.025;
    if (rR > MIN_R && rR > gR * 1.25) return 'RED';
    if (gR > MIN_R && gR > rR * 1.25) return 'GREEN';
    return 'UNKNOWN';
}

// 영역 전체 HSV 스캔 (4픽셀 샘플링)
function _hsvScanRegion(data, w, h) {
    let rC = 0, gC = 0, tot = 0;
    for (let i = 0; i < data.length; i += 16) {
        tot++;
        const { h: H, s: S, v: V } = _rgbToHsv(data[i], data[i+1], data[i+2]);
        if (_isRed(H, S, V))   rC++;
        if (_isGreen(H, S, V)) gC++;
    }
    if (!tot) return 'UNKNOWN';
    const rR = rC / tot, gR = gC / tot;
    _setBarValue('red', rR);
    _setBarValue('green', gR);
    const MIN_R = 0.012;
    if (rR > MIN_R && rR > gR * 1.5) return 'RED';
    if (gR > MIN_R && gR > rR * 1.5) return 'GREEN';
    return 'UNKNOWN';
}


// ═════════════════════════════════════════════════════════════
// 8. 신호 확정 + 다중 피드백
// ═════════════════════════════════════════════════════════════
function _applyColorResult(color) {
    if (color === 'RED')        { colorCounter.RED++;     colorCounter.GREEN = 0;   colorCounter.UNKNOWN = 0; }
    else if (color === 'GREEN') { colorCounter.GREEN++;   colorCounter.RED   = 0;   colorCounter.UNKNOWN = 0; }
    else                        { colorCounter.UNKNOWN++; colorCounter.RED   = 0;   colorCounter.GREEN   = 0; }

    if (colorCounter.RED >= CONFIRM_THRESHOLD && lastColor !== 'RED') {
        lastColor = 'RED';
        speak('빨간불입니다. 멈추세요.');
        _vibrate([200, 100, 200]);
        _updateSignalUI('RED');
        _startBeepLoop();
    } else if (colorCounter.GREEN >= CONFIRM_THRESHOLD && lastColor !== 'GREEN') {
        lastColor = 'GREEN';
        speak('초록불입니다. 건너가세요.');
        _vibrate([80, 50, 80, 50, 80]);
        _updateSignalUI('GREEN');
        _startBeepLoop();
    } else if (colorCounter.UNKNOWN > 15 && lastColor !== 'UNKNOWN') {
        lastColor = 'UNKNOWN';
        _updateSignalUI('UNKNOWN');
        _stopBeepLoop();
    }
}

function _updateSignalUI(color) {
    const overlay = document.getElementById('border-overlay');
    if (color === 'RED') {
        overlay.className = 'active-r';
        _setFullscreenBanner('������', '멈추세요', '#bb0000', '#ffffff');
    } else if (color === 'GREEN') {
        overlay.className = 'active-g';
        _setFullscreenBanner('������', '건너가세요', '#005522', '#ffffff');
    } else {
        overlay.className = '';
        _clearBanner();
    }
}

function _setFullscreenBanner(icon, text, bg, fg) {
    let b = document.getElementById('signal-banner');
    if (!b) {
        b = document.createElement('div');
        b.id = 'signal-banner';
        b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:18px 0 38px;font-family:sans-serif;font-weight:900;transition:background .25s,opacity .25s;pointer-events:none';
        document.body.appendChild(b);
    }
    b.style.background = bg;
    b.style.opacity    = '1';
    b.innerHTML = `<div style="font-size:48px;line-height:1">${icon}</div><div style="font-size:36px;color:${fg};letter-spacing:-1px;margin-top:6px">${text}</div>`;
}

function _clearBanner() {
    const b = document.getElementById('signal-banner');
    if (b) b.style.opacity = '0';
}

function _startBeepLoop() {
    _stopBeepLoop();
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return; }
    }
    const isG = lastColor === 'GREEN';
    beepInterval = setInterval(() => {
        if (lastColor !== 'RED' && lastColor !== 'GREEN') { _stopBeepLoop(); return; }
        _playBeep(isG ? 880 : 440, 0.10);
    }, isG ? 550 : 1100);
}

function _stopBeepLoop() {
    if (beepInterval) { clearInterval(beepInterval); beepInterval = null; }
}

function _playBeep(freq, dur) {
    if (!audioCtx) return;
    try {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.value = freq; o.type = 'sine';
        g.gain.setValueAtTime(0.3, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
        o.start(); o.stop(audioCtx.currentTime + dur);
    } catch(e) {}
}

function _vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }


// ═════════════════════════════════════════════════════════════
// 9. NMS
// ═════════════════════════════════════════════════════════════
function _nms(boxes, thresh) {
    const s = [...boxes].sort((a, b) => b.score - a.score), k = [];
    while (s.length) {
        const b = s.shift(); k.push(b);
        for (let i = s.length - 1; i >= 0; i--)
            if (_iou(b, s[i]) > thresh) s.splice(i, 1);
    }
    return k;
}

function _iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x+a.w, b.x+b.w), y2 = Math.min(a.y+a.h, b.y+b.h);
    const i = Math.max(0, x2-x1) * Math.max(0, y2-y1);
    return i / (a.w*a.h + b.w*b.h - i + 1e-6);
}


// ═════════════════════════════════════════════════════════════
// 10. 렌더링 유틸리티
// ═════════════════════════════════════════════════════════════
function _lerp(a, b, t) { return a*(1-t)+b*t; }

// 스캔존 오버레이: 탐지 중에는 파란 테두리, 탐지 성공 시 초록 테두리
function _drawScanZoneOverlay(ctx, yMin, yMax, vW, found) {
    ctx.strokeStyle = found ? 'rgba(46,204,113,0.6)' : 'rgba(52,152,219,0.45)';
    ctx.lineWidth   = 2;
    ctx.setLineDash(found ? [] : [8, 6]);
    ctx.strokeRect(0, yMin, vW, yMax - yMin);
    ctx.setLineDash([]);

    // 라벨
    ctx.fillStyle = found ? 'rgba(46,204,113,0.85)' : 'rgba(52,152,219,0.7)';
    ctx.font      = 'bold 11px sans-serif';
    ctx.fillText(found ? 'SIGNAL DETECTED' : 'SCAN ZONE', 6, yMin + 14);
}

// 최초 시작 시 1회 가이드 (2초 후 자동 소거)
function _drawScanZoneGuide() {
    const guide = document.createElement('div');
    guide.style.cssText = 'position:fixed;top:15%;left:50%;transform:translateX(-50%);z-index:500;background:rgba(52,152,219,0.85);color:#fff;padding:10px 20px;border-radius:12px;font-size:14px;font-weight:bold;pointer-events:none;transition:opacity 0.5s';
    guide.textContent = '카메라를 정면으로 들어 건너편을 비추세요';
    document.body.appendChild(guide);
    setTimeout(() => { guide.style.opacity = '0'; setTimeout(() => guide.remove(), 600); }, 3000);
}

function _drawBox(x, y, w, h, color, ctx, isTracking, score) {
    const pal = { RED: '#ff3a3a', GREEN: '#2ecc71', UNKNOWN: '#3498db', HIDDEN: '#888' };
    const c   = pal[color] || pal.UNKNOWN;
    ctx.strokeStyle = c; ctx.lineWidth = isTracking ? 2 : 3;
    if (isTracking) ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    if (!isTracking) {
        const cs = 10; ctx.lineWidth = 4;
        [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx, cy]) => {
            const sx = cx === x ? 1 : -1, sy = cy === y ? 1 : -1;
            ctx.beginPath(); ctx.moveTo(cx+sx*cs, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy+sy*cs); ctx.stroke();
        });
    }

    ctx.fillStyle = c;
    ctx.font = `bold ${isTracking ? 11 : 13}px sans-serif`;
    ctx.fillText(
        isTracking ? 'TRACKING...' : `${color}${score ? '  ' + (score*100).toFixed(0) + '%' : ''}`,
        x + 4, y - 7
    );
}

function _drawROI(x, y, w, h) {
    if (!roiCanvas) return;
    const ctx = roiCanvas.getContext('2d');
    const rw = Math.floor(w), rh = Math.floor(h);
    roiCanvas.width = rw; roiCanvas.height = rh;
    ctx.drawImage(video, Math.floor(x), Math.floor(y), rw, rh, 0, 0, rw, rh);
}

function _drawFallbackLabel(ctx, color, yMin, vW) {
    ctx.globalAlpha = 0.15;
    ctx.fillStyle   = color === 'RED' ? '#ff2222' : '#00cc44';
    ctx.fillRect(0, yMin, vW, 40);
    ctx.globalAlpha = 1;
    ctx.fillStyle   = color === 'RED' ? '#ff4444' : '#33dd66';
    ctx.font        = 'bold 12px sans-serif';
    ctx.fillText(`HSV SCAN: ${color}`, 8, yMin + 26);
}

function _setBarValue(key, ratio) {
    const pct = Math.min(100, Math.round(ratio * 100)) + '%';
    const bar = document.getElementById(`${key}-bar`);
    const val = document.getElementById(`${key}-val`);
    if (bar) bar.style.width = pct;
    if (val) val.innerText   = pct;
}

function _showDebugPanel() {
    const p = document.getElementById('debug-panel');
    if (p) p.style.opacity = '1';
}
