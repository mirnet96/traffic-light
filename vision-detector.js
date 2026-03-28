/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    CONF_THRESHOLD: 0.18, // 0.22에서 0.18로 낮춤 (멀리 있는 신호등 대응)
    NMS_IOU: 0.45,
    TRAFFIC_LIGHT_CLASS: 9,
    // 저시력 보행자 시야 특성상 상단 10%~65% 영역 집중 스캔
    SCAN_ZONE: {
        PORTRAIT: { top: 0.10, bottom: 0.65 },
        LANDSCAPE: { top: 0.05, bottom: 0.60 }
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

            // 스캔 존 필터링 및 최소 크기 검증
            if (y > zone.yMin && (y + bh) < zone.yMax && bw > 5 && bh > 10) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    });
    return boxes.sort((a, b) => b.score - a.score);
}
