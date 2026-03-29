/** [ULTRA VISION AI] - vision-worker.js */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    // [수정] 멀리 있는 작은 객체를 잡기 위해 임계값을 0.1로 낮춤
    CONF_THRESHOLD: 0.10, 
    TRAFFIC_LIGHT_CLASS: 9 // COCO 데이터셋 기준 traffic light
};

let model = null;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        const dummy = tf.fill([1, 640, 640, 3], 0);
        const res = await model.executeAsync(dummy);
        tf.dispose(dummy);
        tf.dispose(res);
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
    }
}

function processYOLO(res, vW, vH, zone) {
    const output = res.dataSync(); 
    const boxes = [];
    
    for (let i = 0; i < 8400; i++) {
        const score = output[8400 * (4 + CONFIG.TRAFFIC_LIGHT_CLASS) + i];
        
        if (score > CONFIG.CONF_THRESHOLD) {
            const cx = output[8400 * 0 + i] * (vW / 640);
            const cy = output[8400 * 1 + i] * (vH / 640);
            const bw = output[8400 * 2 + i] * (vW / 640);
            const bh = output[8400 * 3 + i] * (vH / 640);
            
            const x = cx - bw / 2;
            const y = cy - bh / 2;
            
            const aspectRatio = bh / bw;
            // [수정] 원거리에서는 형태가 뭉개질 수 있으므로 비율 범위를 더 넓힘 (1.0 ~ 7.0)
            const isValidShape = aspectRatio >= 1.0 && aspectRatio <= 7.0; 
            // [수정] 아주 작은 신호등도 허용 (너비 3px 이상)
            const isValidSize = bw > 3 && bh > 8;

            // [수정] zone 체크 시 약간의 여유를 둠
            if (y > (zone.yMin - 20) && (y + bh) < (zone.yMax + 20) && isValidShape && isValidSize) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    }
    
    return boxes.sort((a, b) => b.score - a.score);
}

self.onmessage = async (e) => {
    const { type, data } = e.data;
    if (type === 'LOAD') {
        await loadModel();
    } else if (type === 'DETECT') {
        if (!model) return;
        const { bitmap, vW, vH, zone } = data;

        try {
            const tensor = tf.browser.fromPixels(bitmap);
            const input = tf.image.resizeBilinear(tensor, [640, 640]).div(255).expandDims(0);
            
            const res = await model.executeAsync(input);
            const boxes = processYOLO(res, vW, vH, zone);

            self.postMessage({ type: 'RESULT', boxes });

            tensor.dispose();
            input.dispose();
            tf.dispose(res);
        } catch (err) {
            console.error("Detection Error:", err);
        } finally {
            bitmap.close();
        }
    }
};
