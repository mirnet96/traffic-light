/** [ULTRA VISION AI] - vision-analyzer.js (HSV fallback 강화) */

/**
 * YOLO가 탐지한 박스 내부 색상 분석 (RGB 기반)
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

    const topEnd   = Math.floor(h * 0.35);
    const botStart = Math.floor(h * 0.65);

    let rScore = 0, gScore = 0, rCount = 0, gCount = 0, rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const br = Math.max(r, g, b);
        const py = Math.floor((i / 4) / w);
        if (br < 50) continue;

        if (py < topEnd) {
            rTotal++;
            if (r > 130 && r > g * 1.5 && r > b * 1.5) { rCount++; rScore += br; }
        } else if (py >= botStart) {
            gTotal++;
            if (g > 110 && g > r * 1.1 && g > b * 1.0) { gCount++; gScore += br; }
        }
    }

    const rRatio = rTotal > 0 ? rCount / rTotal : 0;
    const gRatio = gTotal > 0 ? gCount / gTotal : 0;
    const isRed   = rRatio > 0.15 && rScore > 80;
    const isGreen = gRatio > 0.15 && gScore > 80;

    if (isRed  && !isGreen) return 'RED';
    if (isGreen && !isRed)  return 'GREEN';
    if (isRed  && isGreen)  return rScore > gScore ? 'RED' : 'GREEN';
    return 'UNKNOWN';
}


/**
 * [HSV Fallback] YOLO 탐지 실패 시 화면 스캔존 전체를 HSV로 직접 스캔
 *
 * 원거리 신호등은 빛 번짐으로 RGB 분류가 불안정하지만
 * HSV의 Hue(색상) 채널은 밝기/채도 변화에 강인해 원거리에서도 안정적
 *
 * @param {CanvasRenderingContext2D} ctx 전체 화면 캔버스 컨텍스트
 * @param {{ yMin: number, yMax: number }} zone 스캔할 Y 범위
 * @returns {{ signal: 'RED'|'GREEN'|'UNKNOWN', box: object|null }}
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
        const r = data[i], g = data[i+1], b = data[i+2];

        const { h, s, v } = rgbToHSV(r, g, b);

        // 발광체 조건: 충분히 밝고(v>0.45) 채도 있는(s>0.35) 픽셀만
        if (v < 0.45 || s < 0.35) continue;

        const pixIdx = Math.floor(i / 4);
        const px = pixIdx % canvasW;
        const py = Math.floor(pixIdx / canvasW) + scanY;

        // 빨간색: Hue 0~18° 또는 342~360° (원형 색상환 양끝)
        if (h <= 18 || h >= 342) {
            redPixels.push({ x: px, y: py });
        }
        // 초록색: Hue 88~165°
        else if (h >= 88 && h <= 165) {
            greenPixels.push({ x: px, y: py });
        }
    }

    // 클러스터 분석: 픽셀이 충분히 모여있어야 신호등으로 판단
    const redCluster   = findDenseCluster(redPixels,   canvasW);
    const greenCluster = findDenseCluster(greenPixels, canvasW);

    if (!redCluster && !greenCluster) return { signal: 'UNKNOWN', box: null };

    if (redCluster && !greenCluster) {
        return { signal: 'RED',   box: clusterToBBox(redCluster,   20) };
    }
    if (greenCluster && !redCluster) {
        return { signal: 'GREEN', box: clusterToBBox(greenCluster, 20) };
    }
    // 둘 다 있으면 더 강한 클러스터 선택
    return redCluster.count >= greenCluster.count
        ? { signal: 'RED',   box: clusterToBBox(redCluster,   20) }
        : { signal: 'GREEN', box: clusterToBBox(greenCluster, 20) };
}

/**
 * RGB → HSV 변환
 * h: 0~360, s: 0~1, v: 0~1
 */
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

/**
 * 픽셀 배열에서 밀집 클러스터 탐지 (격자 기반 빠른 버전)
 * 화면을 16×16 격자로 나눠 밀집 셀 찾기 → O(N/256) 수준으로 빠름
 */
function findDenseCluster(pixels, canvasW) {
    if (pixels.length < 8) return null;

    const CELL = 16; // 격자 셀 크기
    const cellMap = new Map();

    for (const { x, y } of pixels) {
        const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
        cellMap.set(key, (cellMap.get(key) || 0) + 1);
    }

    // 가장 밀집된 셀 찾기
    let bestKey = null, bestCount = 0;
    for (const [key, count] of cellMap) {
        if (count > bestCount) { bestCount = count; bestKey = key; }
    }

    // 클러스터 최소 픽셀 수 (너무 적으면 노이즈)
    if (bestCount < 6) return null;

    const [gx, gy] = bestKey.split(',').map(Number);
    const cx = (gx + 0.5) * CELL;
    const cy = (gy + 0.5) * CELL;

    return { cx, cy, count: bestCount };
}

/**
 * 클러스터 중심점 → 신호등 바운딩 박스 추정
 * 원거리 신호등은 작게 보이므로 padding을 넉넉히 줌
 */
function clusterToBBox(cluster, padding) {
    const size = Math.max(padding * 2, 20);
    return {
        x: cluster.cx - size / 2,
        y: cluster.cy - size / 2,
        w: size,
        h: size * 2.5, // 신호등은 세로로 긴 형태
        score: 0.5,    // fallback 신뢰도 (YOLO보다 낮게 설정)
        fromHSV: true  // fallback 출처 표시
    };
}
