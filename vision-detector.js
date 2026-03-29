/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    CONF_THRESHOLD: 0.15, // 원거리 탐지 강화를 위한 낮은 문턱값
    NMS_IOU: 0.45,
    TRAFFIC_LIGHT_CLASS: 9,
    // 보행자 시야 기준 신호등 최적 스캔 영역
    SCAN_ZONE: {
        PORTRAIT:  { top: 0.05, bottom: 0.65 }, 
        LANDSCAPE: { top: 0.02, bottom: 0.60 }
    }
};

export async function loadModel() {
    const model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
    const dummy = tf.zeros([1, 640, 640, 3]);
    await model.executeAsync(dummy);
    tf.dispose(dummy);
    return model;
}

export function getScanZone(vW, vH) {
    const isLandscape = vW > vH;
    const zone = isLandscape ? CONFIG.SCAN_ZONE.LANDSCAPE : CONFIG.SCAN_ZONE.PORTRAIT;
    return {
        yMin: Math.floor(vH * zone.top),
        yMax: Math.floor(vH * zone.bottom),
        vW, vH
    };
}
