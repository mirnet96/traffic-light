/** [ULTRA VISION AI] - vision-analyzer.js */

export function analyzeROI(ctx, box) {
    if (box.w < 1 || box.h < 1) return 'UNKNOWN';

    const x = Math.floor(box.x);
    const y = Math.floor(box.y);
    const w = Math.floor(box.w);
    const h = Math.floor(box.h);

    // 캔버스 범위 초과 방지
    const canvas = ctx.canvas;
    if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) return 'UNKNOWN';

    const data = ctx.getImageData(x, y, w, h).data;

    // 신호등을 상단 1/3(빨간), 하단 1/3(초록)으로 나눠 분석
    const thirdH = Math.floor(h / 3);
    let rCount = 0, gCount = 0, rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const brightness = (r + g + b) / 3;
        const pixelY = Math.floor((i / 4) / w);

        // 너무 어두운 픽셀(꺼진 등)은 무시
        if (brightness < 40) continue;

        if (pixelY < thirdH) {
            // 상단 1/3: 빨간 분석
            rTotal++;
            // 빨간 조건: R이 높고, G와 B보다 월등히 높을 때
            if (r > 140 && r > g * 1.8 && r > b * 1.5) rCount++;
        } else if (pixelY > thirdH * 2) {
            // 하단 1/3: 초록 분석
            gTotal++;
            // 초록 조건: G가 높고, R보다 높을 때 (파란빛 섞인 초록 대응)
            if (g > 120 && g > r * 1.3 && (g + b) > r * 2) gCount++;
        }
    }

    const rRatio = rCount / (rTotal || 1);
    const gRatio = gCount / (gTotal || 1);

    if (rRatio > 0.12) return 'RED';
    if (gRatio > 0.10) return 'GREEN';
    return 'UNKNOWN';
}
