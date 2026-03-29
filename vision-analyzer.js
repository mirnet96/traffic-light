/** [ULTRA VISION AI] - vision-analyzer.js */

export function analyzeROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';

    const x = Math.floor(box.x);
    const y = Math.floor(box.y);
    const w = Math.floor(box.w);
    const h = Math.floor(box.h);

    const canvas = ctx.canvas;
    const safeX = Math.max(0, x);
    const safeY = Math.max(0, y);
    const safeW = Math.min(w, canvas.width - safeX);
    const safeH = Math.min(h, canvas.height - safeY);

    if (safeW < 2 || safeH < 4) return 'UNKNOWN';

    const imageData = ctx.getImageData(safeX, safeY, safeW, safeH);
    const data = imageData.data;

    // 상단 45% (적색 존), 하단 45% (녹색 존)
    const topEnd = Math.floor(safeH * 0.45);
    const botStart = Math.floor(safeH * 0.55);

    let rScore = 0, gScore = 0;
    let rCount = 0, gCount = 0;
    let rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const br = Math.max(r, g, b);
        const py = Math.floor((i / 4) / safeW);

        if (br < 50) continue; // 배경 제거 문턱값 완화

        if (py < topEnd) {
            rTotal++;
            if (r > 130 && r > g * 1.5 && r > b * 1.5) {
                rCount++;
                rScore += br;
            }
        } else if (py >= botStart) {
            gTotal++;
            if (g > 110 && g > r * 1.1 && g > b * 1.0) {
                gCount++;
                gScore += br;
            }
        }
    }

    const rRatio = rTotal > 0 ? rCount / rTotal : 0;
    const gRatio = gTotal > 0 ? gCount / gTotal : 0;

    // 원거리 대응을 위해 유효 픽셀 비율 20%로 하향 조정
    const isRed = rRatio > 0.20 && rScore > 100;
    const isGreen = gRatio > 0.20 && gScore > 100;

    if (isRed && !isGreen) return 'RED';
    if (isGreen && !isRed) return 'GREEN';
    if (isRed && isGreen) return rScore > gScore ? 'RED' : 'GREEN';
    
    return 'UNKNOWN';
}
