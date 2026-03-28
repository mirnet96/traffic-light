/** [ULTRA VISION AI] - vision-analyzer.js */

export function analyzeROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';
    
    // 이미지 데이터 추출 (좌표 정수화 필수)
    const data = ctx.getImageData(Math.floor(box.x), Math.floor(box.y), Math.floor(box.w), Math.floor(box.h)).data;
    const midY = Math.floor(box.h / 2);
    let rC = 0, gC = 0, rT = 0, gT = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const pixelY = Math.floor((i / 4) / Math.floor(box.w));
        
        // 간소화된 색상 판별 로직
        if (pixelY < midY) { // 상단 (빨강 영역)
            rT++;
            if (r > 150 && r > g * 1.5 && r > b * 1.5) rC++;
        } else { // 하단 (초록 영역)
            gT++;
            if (g > 150 && g > r * 1.2 && b > 120) gC++;
        }
    }

    const rRatio = rC / (rT || 1);
    const gRatio = gC / (gT || 1);

    if (rRatio > 0.15) return 'RED';
    if (gRatio > 0.15) return 'GREEN';
    return 'UNKNOWN';
}
