/** [ULTRA VISION AI] - vision-analyzer.js v4
 *  [FIX] analyzePedestrianROI 최소 크기 완화 w<2, h<4 (원거리 소형 ROI 대응)
 *  [FIX] 야간 RED Hue 상한 10° (가로등 15~30° 오탐 방지) ← 기존 유지
 *  [FIX] findDenseCluster 최소 픽셀 20, 밀도 12 ← 기존 유지
 *  [FIX] 클러스터 종횡비 검증 ← 기존 유지
 *  [NEW] 원거리 소형 ROI 전용 저해상도 임계값 분기 추가
 */

// ─────────────────────────────────────────────
// 차량용 신호등 분석
// ─────────────────────────────────────────────
export function analyzeROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';
    const cvs = ctx.canvas;
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.min(Math.floor(box.w), cvs.width  - x);
    const h = Math.min(Math.floor(box.h), cvs.height - y);
    if (w < 2 || h < 4) return 'UNKNOWN';

    const { data } = ctx.getImageData(x, y, w, h);
    const topEnd = Math.floor(h * 0.38), botStart = Math.floor(h * 0.62);
    let rScore = 0, gScore = 0, rCount = 0, gCount = 0, rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const { h: hue, s, v } = rgbToHSV(data[i], data[i+1], data[i+2]);
        if (v < 0.4 || s < 0.3) continue;
        const py = Math.floor((i / 4) / w), br = v * 255;
        if (py < topEnd) {
            rTotal++;
            if ((hue <= 15 || hue >= 345) && s > 0.5) { rCount++; rScore += br; }
        } else if (py >= botStart) {
            gTotal++;
            if (hue >= 85 && hue <= 170 && s > 0.4) { gCount++; gScore += br; }
        }
    }
    const rR = rTotal > 10 ? rCount / rTotal : 0;
    const gR = gTotal > 10 ? gCount / gTotal : 0;
    const isR = rR > 0.12 && rScore > 60, isG = gR > 0.12 && gScore > 60;
    if (isR && !isG) return 'RED';
    if (isG && !isR) return 'GREEN';
    if (isR && isG)  return rScore > gScore * 1.2 ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}

// ─────────────────────────────────────────────
// 보행자 신호등 전용 분석
// [FIX] 최소 크기 w<2, h<4 (원거리 소형 ROI 허용)
// [NEW] 소형 ROI 전용 임계값 분기
// ─────────────────────────────────────────────
export function analyzePedestrianROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';
    const cvs = ctx.canvas;
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.min(Math.floor(box.w), cvs.width  - x);
    const h = Math.min(Math.floor(box.h), cvs.height - y);
    // [FIX] 완화된 최소 크기 (기존 w<4, h<8 → w<2, h<4)
    if (w < 2 || h < 4) return 'UNKNOWN';

    const { data } = ctx.getImageData(x, y, w, h);
    const midLine    = Math.floor(h * 0.5);
    const isSmall    = w < 16 || h < 24;   // [NEW] 소형 ROI 판별
    const thresholds = _getAdaptiveThresholds(data, isSmall);

    let rScore = 0, gScore = 0, rCount = 0, gCount = 0, rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const { h: hue, s, v } = rgbToHSV(data[i], data[i+1], data[i+2]);
        if (v < thresholds.minV || s < thresholds.minS) continue;
        const py = Math.floor((i / 4) / w), br = v * 255;
        if (py < midLine) {
            rTotal++;
            const redHueMax = thresholds.isNight ? 10 : 12;
            if ((hue <= redHueMax || hue >= 348) && s > 0.45) { rCount++; rScore += br; }
        } else {
            gTotal++;
            if (hue >= 88 && hue <= 165 && s > 0.22) { gCount++; gScore += br; }
        }
    }
    const minPx = isSmall ? 4 : 8;  // [NEW] 소형 ROI는 기준 완화
    const rR = rTotal > minPx ? rCount / rTotal : 0;
    const gR = gTotal > minPx ? gCount / gTotal : 0;
    const isR = rR > thresholds.scoreThreshold && rScore > (isSmall ? 15 : 30);
    const isG = gR > thresholds.scoreThreshold && gScore > (isSmall ? 15 : 30);
    if (isR && !isG) return 'RED';
    if (isG && !isR) return 'GREEN';
    if (isR && isG)  return rScore > gScore ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}

// ─────────────────────────────────────────────
// 조도 적응형 임계값
// [FIX] 야간 isNight 플래그 유지
// [NEW] isSmall 파라미터 추가 → 소형 ROI는 임계값 완화
// ─────────────────────────────────────────────
function _getAdaptiveThresholds(pixelData, isSmall = false) {
    let vSum = 0, count = 0;
    for (let i = 0; i < pixelData.length; i += 32) {
        vSum += Math.max(pixelData[i], pixelData[i+1], pixelData[i+2]) / 255;
        count++;
    }
    const avgV = count > 0 ? vSum / count : 0.5;
    const scale = isSmall ? 0.7 : 1.0;  // [NEW] 소형 ROI: 임계값 30% 완화

    if (avgV < 0.25) return { minV: 0.25 * scale, minS: 0.14 * scale, scoreThreshold: 0.03, isNight: true };
    if (avgV > 0.70) return { minV: 0.48 * scale, minS: 0.12 * scale, scoreThreshold: 0.06, isNight: false };
    return          { minV: 0.35 * scale, minS: 0.20 * scale, scoreThreshold: 0.04, isNight: false };
}

// ─────────────────────────────────────────────
// HSV Fallback
// ─────────────────────────────────────────────
export function detectByHSV(ctx, zone) {
    const cW = ctx.canvas.width;
    const scanY = Math.max(0, zone.yMin);
    const scanH = Math.min(zone.yMax, ctx.canvas.height) - scanY;
    if (scanH < 4) return { signal: 'UNKNOWN', box: null };

    const { data } = ctx.getImageData(0, scanY, cW, scanH);
    const redPx = [], greenPx = [];

    for (let i = 0; i < data.length; i += 4) {
        const { h, s, v } = rgbToHSV(data[i], data[i+1], data[i+2]);
        if (v < 0.45 || s < 0.35) continue;
        const idx = Math.floor(i / 4);
        const px = idx % cW, py = Math.floor(idx / cW) + scanY;
        if (h <= 18 || h >= 342)      redPx.push({ x: px, y: py });
        else if (h >= 88 && h <= 165) greenPx.push({ x: px, y: py });
    }

    const rC = findDenseCluster(redPx,   cW);
    const gC = findDenseCluster(greenPx, cW);
    if (!rC && !gC) return { signal: 'UNKNOWN', box: null };
    if (rC  && !gC) return { signal: 'RED',   box: clusterToBBox(rC, 20) };
    if (gC  && !rC) return { signal: 'GREEN', box: clusterToBBox(gC, 20) };
    return rC.count >= gC.count
        ? { signal: 'RED',   box: clusterToBBox(rC, 20) }
        : { signal: 'GREEN', box: clusterToBBox(gC, 20) };
}

// ─────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────
function rgbToHSV(r, g, b) {
    const rn = r/255, gn = g/255, bn = b/255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
    const v = max, s = max > 0 ? d / max : 0;
    let h = 0;
    if (d > 0) {
        if      (max === rn) h = 60 * (((gn - bn) / d) % 6);
        else if (max === gn) h = 60 * (((bn - rn) / d) + 2);
        else                 h = 60 * (((rn - gn) / d) + 4);
        if (h < 0) h += 360;
    }
    return { h, s, v };
}

function findDenseCluster(pixels, cW) {
    if (pixels.length < 20) return null;
    const CELL = 16, cellMap = new Map();
    for (const { x, y } of pixels) {
        const k = `${Math.floor(x/CELL)},${Math.floor(y/CELL)}`;
        cellMap.set(k, (cellMap.get(k) || 0) + 1);
    }
    let bestKey = null, bestCount = 0;
    for (const [k, c] of cellMap) if (c > bestCount) { bestCount = c; bestKey = k; }
    if (bestCount < 12) return null;

    const [gx, gy] = bestKey.split(',').map(Number);
    const cx = (gx + 0.5) * CELL, cy = (gy + 0.5) * CELL;
    const R = CELL * 3;
    const nearby = pixels.filter(p => Math.abs(p.x - cx) < R && Math.abs(p.y - cy) < R);
    if (nearby.length < 10) return null;

    const xs = nearby.map(p => p.x), ys = nearby.map(p => p.y);
    const bW = Math.max(...xs) - Math.min(...xs), bH = Math.max(...ys) - Math.min(...ys);
    if (bW > bH * 2) return null;  // 종횡비 검증

    return { cx, cy, count: bestCount, bboxW: bW, bboxH: bH };
}

function clusterToBBox(c, pad) {
    const sz = Math.max(pad * 2, 20);
    return { x: c.cx - sz/2, y: c.cy - sz/2, w: sz, h: sz * 2.5, score: 0.5, fromHSV: true };
}
