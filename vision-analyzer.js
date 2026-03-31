/** [ULTRA VISION AI] - vision-analyzer.js
 *  변경사항:
 *  - [NEW] analyzePedestrianROI(): 보행자 신호등 전용 색상 분석
 *      보행자 신호등 구조:
 *        ┌──────────┐
 *        │  [빨강]  │  ← 상단 절반: 빨간 사람 실루엣 (정지)
 *        │          │
 *        ├──────────┤
 *        │  [초록]  │  ← 하단 절반: 초록 사람 실루엣 (보행)
 *        │          │
 *        └──────────┘
 *      - 구분 기준: 정확히 h * 0.5 (차량용 0.38/0.62 와 다름)
 *      - 빨간 Hue 범위: 0~12° / 348~360° (사람 실루엣 선명한 적색)
 *      - 초록 Hue 범위: 100~155° (사람 실루엣 연두빛 포함)
 *      - 동적 임계값: 평균 밝기 기반 조도 자동 적응
 *  - [NEW] getAdaptiveThresholds(): 조도 적응형 임계값 계산
 *  - [KEEP] analyzeROI(): 차량용 신호 분석 (기존 로직 유지)
 *  - [FIX] _rgbToHSV / rgbToHSV 중복 → rgbToHSV 단일 함수로 통일 (이전 수정 유지)
 */

// ─────────────────────────────────────────────
// 차량용 신호등 분석 (기존 로직 유지)
// 상단 38% = 빨강 / 하단 38% = 초록 (3구 기준)
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
// [NEW] 보행자 신호등 전용 분석
//
// 보행자 신호등 구조:
//   ┌──────────┐
//   │  [빨강]  │  상단 절반 (h * 0 ~ h * 0.5)
//   ├──────────┤
//   │  [초록]  │  하단 절반 (h * 0.5 ~ h * 1.0)
//   └──────────┘
//
// 차량용과의 차이점:
//   1. 분할 기준 h*0.5 (차량용: 0.38 / 0.62)
//   2. 켜진 구 전체가 균일하게 빛남 → 픽셀 밀도 높음
//   3. 사람 실루엣 Hue: 빨강 0~12°, 초록 100~155°
//   4. 꺼진 구도 박스 안에 포함되므로 분할 후 해당 절반만 분석
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

    // 보행자 신호등: 상단 절반 = 빨강 구 / 하단 절반 = 초록 구
    const midLine = Math.floor(h * 0.5);

    // 조도 적응형 임계값
    const thresholds = _getAdaptiveThresholds(data);

    let rScore = 0, gScore = 0;
    let rCount = 0, gCount = 0;
    let rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const { h: hue, s, v } = rgbToHSV(r, g, b);

        // 조도 조건에 따라 동적으로 조정된 임계값 적용
        if (v < thresholds.minV || s < thresholds.minS) continue;

        const py = Math.floor((i / 4) / w);
        const brightness = v * 255;

        if (py < midLine) {
            // 상단 절반: 빨간 사람 실루엣 구간
            rTotal++;
            // 보행자 빨강: 선명한 적색 (차량보다 Hue 범위 좁음)
            if ((hue <= 12 || hue >= 348) && s > 0.45) {
                rCount++;
                rScore += brightness;
            }
        } else {
            // 하단 절반: 초록 사람 실루엣 구간
            gTotal++;
            // 보행자 초록: 연두빛 포함 (100~155°)
            // 차량용(85~170°)보다 실루엣 색상에 맞게 범위 조정
            if (hue >= 100 && hue <= 155 && s > 0.35) {
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
    // 둘 다 감지 시 더 강한 신호 선택 (점멸 상황 등)
    if (isRed  && isGreen)  return rScore > gScore ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}


// ─────────────────────────────────────────────
// [NEW] 조도 적응형 임계값 계산
//
// ImageData로부터 평균 밝기를 측정해 환경을 추정:
//   - 야간 (avgV < 0.25)  : 신호가 눈부심 → v/s 기준 낮춤
//   - 직사광 (avgV > 0.70): 채도 낮음    → s 기준 낮추고 v 높임
//   - 일반                : 기본값 사용
// ─────────────────────────────────────────────
function _getAdaptiveThresholds(pixelData) {
    let vSum = 0, count = 0;
    // 1/8 샘플링으로 평균 밝기 빠르게 계산
    for (let i = 0; i < pixelData.length; i += 32) {
        const r = pixelData[i], g = pixelData[i+1], b = pixelData[i+2];
        vSum += Math.max(r, g, b) / 255;
        count++;
    }
    const avgV = count > 0 ? vSum / count : 0.5;

    if (avgV < 0.25) {
        // 야간: 신호등이 주변 대비 매우 밝음
        return { minV: 0.28, minS: 0.18, scoreThreshold: 0.04 };
    } else if (avgV > 0.70) {
        // 직사광선: 전반적으로 밝아 채도 낮아짐
        return { minV: 0.50, minS: 0.16, scoreThreshold: 0.08 };
    } else {
        // 일반 주간
        return { minV: 0.38, minS: 0.26, scoreThreshold: 0.06 };
    }
}


// ─────────────────────────────────────────────
// [HSV Fallback] YOLO 탐지 실패 시 화면 스캔존 HSV 직접 스캔
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

        if (h <= 18 || h >= 342)          redPixels.push({ x: px, y: py });
        else if (h >= 88 && h <= 165)     greenPixels.push({ x: px, y: py });
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
// 공통 유틸: RGB → HSV 변환 (단일 함수)
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
