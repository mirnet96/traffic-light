/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    // 보행자 시선에서 신호등은 보통 상단에 위치함
    SCAN_ZONE: {
        PORTRAIT:  { top: 0.02, bottom: 0.50 }, // 화면 위쪽 절반만 집중
        LANDSCAPE: { top: 0.02, bottom: 0.45 }
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
