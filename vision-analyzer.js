/** [ULTRA VISION AI] - vision-analyzer.js v5
 *  [FIX] 야간 GREEN Hue 하한 85° → 100° (나트륨 가로등 60~90° 오탐 방지)
 *  [KEEP] analyzePedestrianROI 최소 크기 w<2, h<4, isSmall 분기
 *  [KEEP] 야간 RED Hue 상한 10°, findDenseCluster 강화, 종횡비 검증
 */

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
            // [FIX] GREEN Hue 하한 85° → 100° (나트륨등 60~90° 배제)
            if (hue >= 100 && hue <= 170 && s > 0.4) { gCount++; gScore += br; }
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

export function analyzePedestrianROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';
    const cvs = ctx.canvas;
    const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
    const w = Math.min(Math.floor(box.w), cvs.width  - x);
    const h = Math.min(Math.floor(box.h), cvs.height - y);
    if (w < 2 || h < 4) return 'UNKNOWN';

    const { data } = ctx.getImageData(x, y, w, h);
    const midLine = Math.floor(h * 0.5);
    const isSmall = w < 16 || h < 24;
    const thr = _getAdaptiveThresholds(data, isSmall);

    let rScore = 0, gScore = 0, rCount = 0, gCount = 0, rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const { h: hue, s, v } = rgbToHSV(data[i], data[i+1], data[i+2]);
        if (v < thr.minV || s < thr.minS) continue;
        const py = Math.floor((i / 4) / w), br = v * 255;
        if (py < midLine) {
            rTotal++;
            const redHueMax = thr.isNight ? 10 : 12;
            if ((hue <= redHueMax || hue >= 348) && s > 0.45) { rCount++; rScore += br; }
        } else {
            gTotal++;
            // [FIX] GREEN Hue 하한 88° → 100° 통일
            if (hue >= 100 && hue <= 165 && s > 0.22) { gCount++; gScore += br; }
        }
    }
    const minPx = isSmall ? 4 : 8;
    const rR = rTotal > minPx ? rCount / rTotal : 0;
    const gR = gTotal > minPx ? gCount / gTotal : 0;
    const scoreMin = isSmall ? 15 : 30;
    const isR = rR > thr.scoreThreshold && rScore > scoreMin;
    const isG = gR > thr.scoreThreshold && gScore > scoreMin;
    if (isR && !isG) return 'RED';
    if (isG && !isR) return 'GREEN';
    if (isR && isG)  return rScore > gScore ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}

function _getAdaptiveThresholds(pixelData, isSmall = false) {
    let vSum = 0, count = 0;
    for (let i = 0; i < pixelData.length; i += 32) {
        vSum += Math.max(pixelData[i], pixelData[i+1], pixelData[i+2]) / 255;
        count++;
    }
    const avgV = count > 0 ? vSum / count : 0.5;
    const sc = isSmall ? 0.7 : 1.0;
    if (avgV < 0.25) return { minV: 0.25*sc, minS: 0.14*sc, scoreThreshold: 0.03, isNight: true };
    if (avgV > 0.70) return { minV: 0.48*sc, minS: 0.12*sc, scoreThreshold: 0.06, isNight: false };
    return              { minV: 0.35*sc, minS: 0.20*sc, scoreThreshold: 0.04, isNight: false };
}

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
        if (h <= 18 || h >= 342)       redPx.push({ x: px, y: py });
        // [FIX] GREEN Hue 하한 88° → 100°
        else if (h >= 100 && h <= 165) greenPx.push({ x: px, y: py });
    }

    const rC = findDenseCluster(redPx, cW), gC = findDenseCluster(greenPx, cW);
    if (!rC && !gC) return { signal: 'UNKNOWN', box: null };
    if (rC  && !gC) return { signal: 'RED',   box: clusterToBBox(rC, 20) };
    if (gC  && !rC) return { signal: 'GREEN', box: clusterToBBox(gC, 20) };
    return rC.count >= gC.count
        ? { signal: 'RED',   box: clusterToBBox(rC, 20) }
        : { signal: 'GREEN', box: clusterToBBox(gC, 20) };
}

function rgbToHSV(r, g, b) {
    const rn = r/255, gn = g/255, bn = b/255;
    const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn), d = max - min;
    const v = max, s = max > 0 ? d/max : 0;
    let h = 0;
    if (d > 0) {
        if      (max === rn) h = 60 * (((gn-bn)/d) % 6);
        else if (max === gn) h = 60 * (((bn-rn)/d) + 2);
        else                 h = 60 * (((rn-gn)/d) + 4);
        if (h < 0) h += 360;
    }
    return { h, s, v };
}

function findDenseCluster(pixels, cW) {
    if (pixels.length < 20) return null;
    const CELL = 16, cm = new Map();
    for (const { x, y } of pixels) {
        const k = `${Math.floor(x/CELL)},${Math.floor(y/CELL)}`;
        cm.set(k, (cm.get(k) || 0) + 1);
    }
    let bKey = null, bCnt = 0;
    for (const [k, c] of cm) if (c > bCnt) { bCnt = c; bKey = k; }
    if (bCnt < 12) return null;

    const [gx, gy] = bKey.split(',').map(Number);
    const cx = (gx+0.5)*CELL, cy = (gy+0.5)*CELL, R = CELL*3;
    const near = pixels.filter(p => Math.abs(p.x-cx)<R && Math.abs(p.y-cy)<R);
    if (near.length < 10) return null;

    const xs = near.map(p=>p.x), ys = near.map(p=>p.y);
    const bW = Math.max(...xs)-Math.min(...xs), bH = Math.max(...ys)-Math.min(...ys);
    if (bW > bH * 2) return null;
    return { cx, cy, count: bCnt, bboxW: bW, bboxH: bH };
}

function clusterToBBox(c, pad) {
    const sz = Math.max(pad*2, 20);
    return { x: c.cx-sz/2, y: c.cy-sz/2, w: sz, h: sz*2.5, score: 0.5, fromHSV: true };
}
