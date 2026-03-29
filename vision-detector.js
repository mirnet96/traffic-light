/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    // [수정] 신호등이 화면 중간 근처에 올 수도 있으므로 범위를 0.65(65%)까지 확장
    SCAN_ZONE: {
        PORTRAIT:  { top: 0.0, bottom: 0.65 }, 
        LANDSCAPE: { top: 0.0, bottom: 0.60 }
    }
};

export function getScanZone(vW, vH) {
    const isLandscape = vW > vH;
    const zone = isLandscape ? CONFIG.SCAN_ZONE.LANDSCAPE : CONFIG.SCAN_ZONE.PORTRAIT;
    return {
        yMin: Math.floor(vH * zone.top),
        yMax: Math.floor(vH * zone.bottom)
    };
}
