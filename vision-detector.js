/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    CONF_THRESHOLD: 0.20,
    NMS_IOU: 0.45,
    TRAFFIC_LIGHT_CLASS: 9,
    SCAN_ZONE: {
        PORTRAIT:  { top: 0.10, bottom: 0.55 },
        LANDSCAPE: { top: 0.05, bottom: 0.50 }
    }
};

export function getScanZone(vW, vH, dynamicCoords) {
    const isLandscape = vW > vH;
    // MediaPipe에서 계산된 dynamicCoords가 있으면 우선 사용
    const coords = dynamicCoords || (isLandscape ? CONFIG.SCAN_ZONE.LANDSCAPE : CONFIG.SCAN_ZONE.PORTRAIT);
    
    return {
        yMin: Math.floor(vH * coords.top),
        yMax: Math.floor(vH * coords.bottom),
        vW, vH
    };
}

// 워커에서 사용할 수 있도록 YOLO 프로세싱 함수 유지
export function processYOLO(res, vW, vH, zone) {
    // 실제 로직은 vision-worker.js 내부에 통합되어 있습니다.
}
