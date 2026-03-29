/** [ULTRA VISION AI] - vision-worker.js */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD: 0.15, // 탐지 문턱값 하향 (원거리 감지 강화)
    TRAFFIC_LIGHT_CLASS: 9
};

let model = null;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        const dummy = tf.zeros([1, 640, 640, 3]);
        await model.executeAsync(dummy);
        dummy.dispose();
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
    }
}

function processYOLO(res, vW, vH, zone) {
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
            // 한국 신호등 세로 비율 및 원거리 대응 범위 확장
            const isValidShape = aspectRatio >= 1.0 && aspectRatio <= 6.0;
            const isValidSize = bw > 5 && bh > 12;

            if (y > zone.yMin && (y + bh) < zone.yMax && isValidShape && isValidSize) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    });
    return boxes.sort((a, b) => b.score - a.score);
}

self.onmessage = async (e) => {
    const { type, data } = e.data;
    if (type === 'LOAD') {
        await loadModel();
    } else if (type === 'DETECT') {
        if (!model) return;
        const { bitmap, vW, vH, zone } = data;

        const tensor = tf.browser.fromPixels(bitmap);
        const input = tensor.resizeBilinear([640, 640]).div(255).expandDims(0);
        const res = await model.executeAsync(input);
        
        const boxes = processYOLO(res, vW, vH, zone);

        tensor.dispose();
        input.dispose();
        tf.dispose(res);
        bitmap.close();

        self.postMessage({ type: 'RESULT', boxes });
    }
};
