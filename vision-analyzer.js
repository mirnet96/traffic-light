/** [ULTRA VISION AI] - vision-analyzer.js */

export function analyzeROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';

    const x = Math.floor(box.x);
    const y = Math.floor(box.y);
    const w = Math.floor(box.w);
    const h = Math.floor(box.h);

    const canvas = ctx.canvas;
    // 캔버스 경계값 안전 처리
    const safeX = Math.max(0, x);
    const safeY = Math.max(0, y);
    const safeW = Math.min(w, canvas.width - safeX);
    const safeH = Math.min(h, canvas.height - safeY);

    if (safeW < 2 || safeH < 4) return 'UNKNOWN';

    const data = ctx.getImageData(safeX, safeY, safeW, safeH).data;

    // 상단 45% (빨강), 하단 45% (초록) 분석 (중앙 10% 제외)
    const topEnd = Math.floor(safeH * 0.45);
    const botStart = Math.floor(safeH * 0.55);

    let rScore = 0, gScore = 0;
    let rCount = 0, gCount = 0;
    let rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const br = Math.max(r, g, b);
        const pixelIdx = i / 4;
        const py = Math.floor(pixelIdx / safeW);

        // 원거리는 어두울 수 있으므로 밝기 기준을 50으로 낮춤
        if (br < 50) continue;

        if (py < topEnd) {
            rTotal++;
            // 빨간색 판정 (R이 다른 채널보다 확실히 높은지)
            if (r > 130 && r > g * 1.5 && r > b * 1.5) {
                rCount++;
                rScore += br;
            }
        } else if (py >= botStart) {
            gTotal++;
            // 초록색 판정 (G가 우세한지)
            if (g > 110 && g > r * 1.1 && g > b * 1.0) {
                gCount++;
                gScore += br;
            }
        }
    }

    const rRatio = rTotal > 0 ? rCount / rTotal : 0;
    const gRatio = gTotal > 0 ? gCount / gTotal : 0;

    // 판정 문턱값 완화: 픽셀 비율이 20%만 넘어도 색상으로 인정 (원거리 대응)
    const isRed = rRatio > 0.20 && rScore > 100;
    const isGreen = gRatio > 0.20 && gScore > 100;

    if (isRed && !isGreen) return 'RED';
    if (isGreen && !isRed) return 'GREEN';
    if (isRed && isGreen) return rScore > gScore ? 'RED' : 'GREEN';
    
    return 'UNKNOWN';
}
