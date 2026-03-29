/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    CONF_THRESHOLD: 0.15, // 0.20 -> 0.15로 낮춰 원거리 감지력 강화
    NMS_IOU: 0.45,
    TRAFFIC_LIGHT_CLASS: 9,
    // 감지 영역을 조금 더 넓게 설정 (화면의 더 많은 부분을 스캔)
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

export function getScanZone(vW, vH, dynamicCoords) {
    const isLandscape = vW > vH;
    // MediaPipe Pose 등 외부에서 계산된 좌표가 있으면 우선 적용, 없으면 기본값
    const zone = dynamicCoords || (isLandscape ? CONFIG.SCAN_ZONE.LANDSCAPE : CONFIG.SCAN_ZONE.PORTRAIT);
    return {
        yMin: Math.floor(vH * zone.top),
        yMax: Math.floor(vH * zone.bottom),
        vW, vH
    };
}

export function processYOLO(res, vW, vH, zone) {
    // 실제 연산은 워커 내부에서 수행되도록 vision-worker.js에 최적화 로직을 넣었습니다.
}
