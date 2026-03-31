/** [ULTRA VISION AI] - vision-analyzer.js
 *  버그 수정:
 *  - [BUG FIX] _rgbToHSV / rgbToHSV 중복 정의 제거 → 단일 함수 rgbToHSV로 통일
 */

/**
 * YOLO가 탐지한 박스 내부 색상 분석 (RGB → HSV 기반)
 * 상단 35% = 빨간불 영역, 하단 35% = 초록불 영역
 */
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
        // [BUG FIX] _rgbToHSV → rgbToHSV (중복 함수 제거 후 단일 함수 사용)
        const { h: hue, s, v } = rgbToHSV(r, g, b);

        if (v < 0.4 || s < 0.3) continue;

        const py = Math.floor((i / 4) / w);
        const brightness = v * 255;

        if (py < topEnd) {
            rTotal++;
            const isRed = (hue <= 15 || hue >= 345) && s > 0.5;
            if (isRed) { rCount++; rScore += brightness; }
        } else if (py >= botStart) {
            gTotal++;
            const isGreen = (hue >= 85 && hue <= 170) && s > 0.4;
            if (isGreen) { gCount++; gScore += brightness; }
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

/**
 * [HSV Fallback] YOLO 탐지 실패 시 화면 스캔존 전체를 HSV로 직접 스캔
 */
export function detectByHSV(ctx, zone) {
    const canvasW = ctx.canvas.width;
    const scanY   = Math.max(0, zone.yMin);
    const scanH   = Math.min(zone.yMax, ctx.canvas.height) - scanY;
    if (scanH < 4) return { signal: 'UNKNOWN', box: null };

    const { data } = ctx.getImageData(0, scanY, canvasW, scanH);

    const redPixels   = [];
    const greenPixels = [];

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const { h, s, v } = rgbToHSV(r, g, b);

        if (v < 0.45 || s < 0.35) continue;

        const pixIdx = Math.floor(i / 4);
        const px = pixIdx % canvasW;
        const py = Math.floor(pixIdx / canvasW) + scanY;

        if (h <= 18 || h >= 342) {
            redPixels.push({ x: px, y: py });
        } else if (h >= 88 && h <= 165) {
            greenPixels.push({ x: px, y: py });
        }
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
// [BUG FIX] 중복 함수(_rgbToHSV, rgbToHSV) → 단일 함수 rgbToHSV로 통일
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
    return {
        cx: (gx + 0.5) * CELL,
        cy: (gy + 0.5) * CELL,
        count: bestCount
    };
}

function clusterToBBox(cluster, padding) {
    const size = Math.max(padding * 2, 20);
    return {
        x: cluster.cx - size / 2,
        y: cluster.cy - size / 2,
        w: size,
        h: size * 2.5,
        score: 0.5,
        fromHSV: true
    };
}
