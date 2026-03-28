/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    CONF_THRESHOLD: 0.22,
    NMS_IOU: 0.40,
    TRAFFIC_LIGHT_CLASS: 9, // YOLOv8 default traffic light class
    // 저시력 보행자 특성상 화면 상단에 신호등이 위치할 확률이 높음
    SCAN_ZONE: {
        PORTRAIT: { top: 0.08, bottom: 0.62 },
        LANDSCAPE: { top: 0.05, bottom: 0.55 }
    }
};

export async function loadModel() {
    console.log("Loading YOLOv8 Model...");
    const model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
    // Warmup
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
        vW, vH, isLandscape
    };
}

export function processYOLO(res, vW, vH, zone) {
    const trans = res.transpose([0, 2, 1]).squeeze().arraySync();
    let boxes = [];

    trans.forEach(row => {
        const score = row[4 + CONFIG.TRAFFIC_LIGHT_CLASS];
        if (score > CONFIG.CONF_THRESHOLD) {
            const [cx, cy, w, h] = row.slice(0, 4);
            const x1 = (cx - w/2) * (vW/640);
            const y1 = (cy - h/2) * (vH/640);
            const boxW = w * (vW/640);
            const boxH = h * (vH/640);

            // 스캔 존 내에 있는 것만 필터링
            if (y1 > zone.yMin && (y1 + boxH) < zone.yMax) {
                boxes.push({ x: x1, y: y1, w: boxW, h: boxH, score });
            }
        }
    });
    return boxes;
}
