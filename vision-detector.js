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

export async function loadModel() {
    const model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
    const dummy = tf.zeros([1, 640, 640, 3]);
    await model.executeAsync(dummy);
    tf.dispose(dummy);
    return model;
}

/** * vW, vH: 비디오 해상도
 * dynamicCoords: MediaPipe에서 보낸 {top, bottom} 비율 좌표
 */
export function getScanZone(vW, vH, dynamicCoords) {
    const isLandscape = vW > vH;
    // 동적 좌표가 없으면 기본 설정 사용
    const coords = dynamicCoords || (isLandscape ? CONFIG.SCAN_ZONE.LANDSCAPE : CONFIG.SCAN_ZONE.PORTRAIT);
    
    return {
        yMin: Math.floor(vH * coords.top),
        yMax: Math.floor(vH * coords.bottom),
        vW, vH
    };
}

export function processYOLO(res, vW, vH, zone) {
    const trans = res.transpose([0, 2, 1]).squeeze().arraySync();
    let boxes = [];

    trans.forEach(row => {
        const score = row[4 + CONFIG.TRAFFIC_LIGHT_CLASS];
        if (score > CONFIG.CONF_THRESHOLD) {
            const [cx, cy, w, h] = row.slice(0, 4);
            const x = (cx - w/2) * (vW/640);
            const y = (cy - h/2) * (vH/640);
            const bw = w * (vW/640);
            const bh = h * (vH/640);

            const aspectRatio = bh / bw;
            const isValidShape = aspectRatio >= 1.2 && aspectRatio <= 6.0;
            const isValidSize = bw > 8 && bh > 20;

            if (y > zone.yMin && (y + bh) < zone.yMax && isValidShape && isValidSize) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    });
    return boxes.sort((a, b) => b.score - a.score);
}
