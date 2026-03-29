/** [ULTRA VISION AI] - vision-detector.js */

export const CONFIG = {
    CONF_THRESHOLD: 0.20,
    NMS_IOU: 0.45,
    TRAFFIC_LIGHT_CLASS: 9,
    // 보행자가 서 있을 때 신호등은 보통 화면 상단 15~55% 구간
    // 10~65%는 너무 넓어서 차량 신호등도 같이 잡힘
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

            const aspectRatio = bh / bw;

            // 신호등 비율 필터: 세로가 가로보다 1.2~6배 길어야 함
            // 한국 보행자 신호등은 보통 1:2 ~ 1:4 비율
            const isValidShape = aspectRatio >= 1.2 && aspectRatio <= 6.0;

            // 최소 크기 강화: 너무 작은 박스는 오탐 가능성 높음
            const isValidSize = bw > 8 && bh > 20;

            if (y > zone.yMin && (y + bh) < zone.yMax && isValidShape && isValidSize) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    });

    return boxes.sort((a, b) => b.score - a.score);
}
