/** [ULTRA VISION AI] - vision-analyzer.js
 *  [기존] 차량/보행자 ROI 분석, HSV Fallback
 *  [FIX] detectByHSV — findDenseCluster 최소 픽셀 수 8 → 20으로 강화
 *        클러스터 종횡비 검증 추가 (신호등 형태: 세로 >= 가로)
 *  [FIX] _getAdaptiveThresholds — 야간 RED Hue 상한 10°로 축소
 *        가로등·오렌지 조명(15~30°) 오탐 방지
 *  [KEEP] analyzeROI(), analyzePedestrianROI(), rgbToHSV() 기존 유지
 */

// ─────────────────────────────────────────────
// 차량용 신호등 분석
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
    const midLine    = Math.floor(h * 0.5);
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
            // [FIX] 야간 모드에서는 redHueMax를 좁게 적용 (오렌지 배제)
            const redHueMax = thresholds.isNight ? 10 : 12;
            if ((hue <= redHueMax || hue >= 348) && s > 0.45) {
                rCount++;
                rScore += brightness;
            }
        } else {
            gTotal++;
            if (hue >= 88 && hue <= 165 && s > 0.22) {
                gCount++;
                gScore += brightness;
            }
        }
    }

    const rRatio = rTotal > 8 ? rCount / rTotal : 0;
    const gRatio = gTotal > 8 ? gCount / gTotal : 0;

    const isRed   = rRatio > thresholds.scoreThreshold && rScore > 30;
    const isGreen = gRatio > thresholds.scoreThreshold && gScore > 30;

    if (isRed  && !isGreen) return 'RED';
    if (isGreen && !isRed)  return 'GREEN';
    if (isRed  && isGreen)  return rScore > gScore ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}


// ─────────────────────────────────────────────
// 조도 적응형 임계값 계산
// [FIX] isNight 플래그 추가 → analyzePedestrianROI에서 Hue 범위 분기에 활용
// ─────────────────────────────────────────────
function _getAdaptiveThresholds(pixelData) {
    let vSum = 0, count = 0;
    for (let i = 0; i < pixelData.length; i += 32) {
        vSum += Math.max(pixelData[i], pixelData[i+1], pixelData[i+2]) / 255;
        count++;
    }
    const avgV = count > 0 ? vSum / count : 0.5;

    if (avgV < 0.25) {
        return { minV: 0.25, minS: 0.14, scoreThreshold: 0.03, isNight: true };
    } else if (avgV > 0.70) {
        return { minV: 0.48, minS: 0.12, scoreThreshold: 0.06, isNight: false };
    } else {
        return { minV: 0.35, minS: 0.20, scoreThreshold: 0.04, isNight: false };
    }
}


// ─────────────────────────────────────────────
// HSV Fallback — YOLO 탐지 실패 시 전체 스캔
// [FIX] findDenseCluster 최소 픽셀/클러스터 조건 강화
// [FIX] 클러스터 종횡비 검증으로 비신호 오탐 방지
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

// ─────────────────────────────────────────────
// [FIX] findDenseCluster 강화
//   - 최소 픽셀 수: 8 → 20 (비신호 소규모 색상 덩어리 무시)
//   - 최소 셀 밀도: 6 → 12 (단일 셀 당 더 많은 픽셀 요구)
//   - 클러스터 분포 통계(bboxW/H) 반환 → 종횡비 검증에 사용
// ─────────────────────────────────────────────
function findDenseCluster(pixels, canvasW) {
    if (pixels.length < 20) return null;  // [FIX] 8 → 20

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

    if (bestCount < 12) return null;  // [FIX] 6 → 12

    const [gx, gy] = bestKey.split(',').map(Number);
    const cx = (gx + 0.5) * CELL;
    const cy = (gy + 0.5) * CELL;

    // [FIX] 클러스터 인근 픽셀만 모아 실제 분포 계산
    const RADIUS = CELL * 3;
    const nearby = pixels.filter(p =>
        Math.abs(p.x - cx) < RADIUS && Math.abs(p.y - cy) < RADIUS
    );

    if (nearby.length < 10) return null;

    const xs = nearby.map(p => p.x);
    const ys = nearby.map(p => p.y);
    const bboxW = Math.max(...xs) - Math.min(...xs);
    const bboxH = Math.max(...ys) - Math.min(...ys);

    // [FIX] 종횡비 검증: 신호등은 세로가 더 길거나 비슷한 형태
    // 가로가 세로의 2배 이상이면 신호등이 아닐 가능성이 높음 (가로등, 간판 등)
    if (bboxW > bboxH * 2) return null;

    return { cx, cy, count: bestCount, bboxW, bboxH };
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
