/** [ULTRA VISION AI] - vision-analyzer.js
 *  [개선 대안3] 보행자 신호등 HSV 분석 임계값 개선
 *  - analyzePedestrianROI()
 *    · 초록 Hue 범위 확장: 100~155° → 88~165° (연두·청록 포함)
 *    · 채도 기준 완화: s > 0.35 → s > 0.22 (역광·야간 대응)
 *    · scoreThreshold 완화: 0.06 → 0.04
 *  - _getAdaptiveThresholds() 야간/직사광 기준 완화
 *  [KEEP] analyzeROI(), detectByHSV(), rgbToHSV() 기존 유지
 */

// ─────────────────────────────────────────────
// 차량용 신호등 분석 (기존 유지)
// ─────────────────────────────────────────────
export function analyzeROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';

    const canvas = ctx.canvas;
    const x = Math.max(0, Math.floor(box.x));
    const y = Math.max(0, Math.floor(box.y));
    const w = Math.min(Math.floor(box.w), canvas.width  - x);
    const h = Math.min(Math.floor(box.h), canvas.height - y);
    if (w < 2 || h < 4) return 'UNKNOWN';

    const { data } = ctx.getImageData(x, y, w, h);

    const topEnd   = Math.floor(h * 0.38);
    const botStart = Math.floor(h * 0.62);

    let rScore = 0, gScore = 0, rCount = 0, gCount = 0;
    let rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const { h: hue, s, v } = rgbToHSV(r, g, b);
        if (v < 0.4 || s < 0.3) continue;

        const py = Math.floor((i / 4) / w);
        const brightness = v * 255;

        if (py < topEnd) {
            rTotal++;
            if ((hue <= 15 || hue >= 345) && s > 0.5) {
                rCount++; rScore += brightness;
            }
        } else if (py >= botStart) {
            gTotal++;
            if (hue >= 85 && hue <= 170 && s > 0.4) {
                gCount++; gScore += brightness;
            }
        }
    }

    const rRatio  = rTotal > 10 ? rCount / rTotal : 0;
    const gRatio  = gTotal > 10 ? gCount / gTotal : 0;
    const isRed   = rRatio > 0.12 && rScore > 60;
    const isGreen = gRatio > 0.12 && gScore > 60;

    if (isRed  && !isGreen) return 'RED';
    if (isGreen && !isRed)  return 'GREEN';
    if (isRed  && isGreen)  return rScore > gScore * 1.2 ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}


// ─────────────────────────────────────────────
// 보행자 신호등 전용 분석
// [대안3] HSV 임계값 완화로 탐지율 향상
//
// 구조:
//   ┌──────────┐
//   │  [빨강]  │  상단 절반 (h * 0 ~ h * 0.5)
//   ├──────────┤
//   │  [초록]  │  하단 절반 (h * 0.5 ~ h * 1.0)
//   └──────────┘
// ─────────────────────────────────────────────
export function analyzePedestrianROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';

    const canvas = ctx.canvas;
    const x = Math.max(0, Math.floor(box.x));
    const y = Math.max(0, Math.floor(box.y));
    const w = Math.min(Math.floor(box.w), canvas.width  - x);
    const h = Math.min(Math.floor(box.h), canvas.height - y);
    if (w < 4 || h < 8) return 'UNKNOWN';

    const { data } = ctx.getImageData(x, y, w, h);
    const midLine   = Math.floor(h * 0.5);
    const thresholds = _getAdaptiveThresholds(data);

    let rScore = 0, gScore = 0;
    let rCount = 0, gCount = 0;
    let rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const { h: hue, s, v } = rgbToHSV(r, g, b);

        if (v < thresholds.minV || s < thresholds.minS) continue;

        const py         = Math.floor((i / 4) / w);
        const brightness = v * 255;

        if (py < midLine) {
            rTotal++;
            // 빨간 사람 실루엣: Hue 0~12° / 348~360°
            if ((hue <= 12 || hue >= 348) && s > 0.45) {
                rCount++;
                rScore += brightness;
            }
        } else {
            gTotal++;
            // [대안3] 초록 사람 실루엣 Hue 범위 확장: 100~155° → 88~165°
            //         채도 기준 완화: s > 0.35 → s > 0.22
            if (hue >= 88 && hue <= 165 && s > 0.22) {
                gCount++;
                gScore += brightness;
            }
        }
    }

    const rRatio = rTotal > 8 ? rCount / rTotal : 0;
    const gRatio = gTotal > 8 ? gCount / gTotal : 0;

    // [대안3] scoreThreshold 완화: 0.06 → 0.04
    const isRed   = rRatio > thresholds.scoreThreshold && rScore > 30;
    const isGreen = gRatio > thresholds.scoreThreshold && gScore > 30;

    if (isRed  && !isGreen) return 'RED';
    if (isGreen && !isRed)  return 'GREEN';
    if (isRed  && isGreen)  return rScore > gScore ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}


// ─────────────────────────────────────────────
// 조도 적응형 임계값 계산
// [대안3] 각 구간 임계값 소폭 완화
// ─────────────────────────────────────────────
function _getAdaptiveThresholds(pixelData) {
    let vSum = 0, count = 0;
    for (let i = 0; i < pixelData.length; i += 32) {
        vSum += Math.max(pixelData[i], pixelData[i+1], pixelData[i+2]) / 255;
        count++;
    }
    const avgV = count > 0 ? vSum / count : 0.5;

    if (avgV < 0.25) {
        // 야간: 신호등이 주변 대비 매우 밝음
        // [대안3] minS: 0.18 → 0.14, scoreThreshold: 0.04 → 0.03
        return { minV: 0.25, minS: 0.14, scoreThreshold: 0.03 };
    } else if (avgV > 0.70) {
        // 직사광선: 채도 낮아짐
        // [대안3] minS: 0.16 → 0.12, scoreThreshold: 0.08 → 0.06
        return { minV: 0.48, minS: 0.12, scoreThreshold: 0.06 };
    } else {
        // 일반 주간
        // [대안3] minS: 0.26 → 0.20, scoreThreshold: 0.06 → 0.04
        return { minV: 0.35, minS: 0.20, scoreThreshold: 0.04 };
    }
}


// ─────────────────────────────────────────────
// HSV Fallback — YOLO 탐지 실패 시 전체 스캔
// ─────────────────────────────────────────────
export function detectByHSV(ctx, zone) {
    const canvasW = ctx.canvas.width;
    const scanY   = Math.max(0, zone.yMin);
    const scanH   = Math.min(zone.yMax, ctx.canvas.height) - scanY;
    if (scanH < 4) return { signal: 'UNKNOWN', box: null };

    const { data } = ctx.getImageData(0, scanY, canvasW, scanH);

    const redPixels   = [];
    const greenPixels = [];

    for (let i = 0; i < data.length; i += 4) {
        const { h, s, v } = rgbToHSV(data[i], data[i+1], data[i+2]);
        if (v < 0.45 || s < 0.35) continue;

        const pixIdx = Math.floor(i / 4);
        const px = pixIdx % canvasW;
        const py = Math.floor(pixIdx / canvasW) + scanY;

        if (h <= 18 || h >= 342)      redPixels.push({ x: px, y: py });
        else if (h >= 88 && h <= 165) greenPixels.push({ x: px, y: py });
    }

    const redCluster   = findDenseCluster(redPixels,   canvasW);
    const greenCluster = findDenseCluster(greenPixels, canvasW);

    if (!redCluster && !greenCluster) return { signal: 'UNKNOWN', box: null };
    if (redCluster  && !greenCluster) return { signal: 'RED',   box: clusterToBBox(redCluster,   20) };
    if (greenCluster && !redCluster)  return { signal: 'GREEN', box: clusterToBBox(greenCluster, 20) };

    return redCluster.count >= greenCluster.count
        ? { signal: 'RED',   box: clusterToBBox(redCluster,   20) }
        : { signal: 'GREEN', box: clusterToBBox(greenCluster, 20) };
}


// ─────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────
function rgbToHSV(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;
    const v = max;
    const s = max > 0 ? delta / max : 0;
    let h = 0;
    if (delta > 0) {
        if      (max === rn) h = 60 * (((gn - bn) / delta) % 6);
        else if (max === gn) h = 60 * (((bn - rn) / delta) + 2);
        else                 h = 60 * (((rn - gn) / delta) + 4);
        if (h < 0) h += 360;
    }
    return { h, s, v };
}

function findDenseCluster(pixels, canvasW) {
    if (pixels.length < 8) return null;
    const CELL = 16;
    const cellMap = new Map();
    for (const { x, y } of pixels) {
        const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
        cellMap.set(key, (cellMap.get(key) || 0) + 1);
    }
    let bestKey = null, bestCount = 0;
    for (const [key, count] of cellMap) {
        if (count > bestCount) { bestCount = count; bestKey = key; }
    }
    if (bestCount < 6) return null;
    const [gx, gy] = bestKey.split(',').map(Number);
    return { cx: (gx + 0.5) * CELL, cy: (gy + 0.5) * CELL, count: bestCount };
}

function clusterToBBox(cluster, padding) {
    const size = Math.max(padding * 2, 20);
    return {
        x: cluster.cx - size / 2, y: cluster.cy - size / 2,
        w: size, h: size * 2.5,
        score: 0.5, fromHSV: true
    };
}
