/** [ULTRA VISION AI] - vision-analyzer.js */

const HSV_LIMITS = {
    RED: { h1: [0, 22], h2: [338, 360], s: 0.40, v: 0.25 },
    GRN: { h: [88, 165], s: 0.35, v: 0.25 }
};

export function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const v = max, s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return { h: h * 360, s, v };
}

export function analyzeROI(ctx, x, y, w, h) {
    const data = ctx.getImageData(x, y, w, h).data;
    const midY = Math.floor(h / 2);
    let rCount = 0, gCount = 0, rTotal = 0, gTotal = 0;

    for (let i = 0; i < data.length; i += 4) {
        const pixelY = Math.floor((i / 4) / w);
        const { h: hh, s, v } = rgbToHsv(data[i], data[i+1], data[i+2]);
        
        // 상단은 빨강, 하단은 초록 구역 (신호등 표준 구조)
        if (pixelY < midY) {
            rTotal++;
            if (s > HSV_LIMITS.RED.s && v > HSV_LIMITS.RED.v && 
               (hh <= HSV_LIMITS.RED.h1[1] || hh >= HSV_LIMITS.RED.h2[0])) rCount++;
        } else {
            gTotal++;
            if (s > HSV_LIMITS.GRN.s && v > HSV_LIMITS.GRN.v && 
                hh >= HSV_LIMITS.GRN.h[0] && hh <= HSV_LIMITS.GRN.h[1]) gCount++;
        }
    }
    
    const rRatio = rCount / (rTotal || 1);
    const gRatio = gCount / (gTotal || 1);
    
    if (rRatio > 0.12 && rRatio > gRatio) return 'RED';
    if (gRatio > 0.12 && gRatio > rRatio) return 'GREEN';
    return 'UNKNOWN';
}
