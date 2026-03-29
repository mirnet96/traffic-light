/** [ULTRA VISION AI] - vision-worker.js */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD: 0.15, // 초기 탐지 문턱값 (낮게 설정하여 원거리 대응)
    TRAFFIC_LIGHT_CLASS: 9
};

let model = null;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        const dummy = tf.zeros([1, 640, 640, 3]);
        await model.executeAsync(dummy);
        tf.dispose(dummy);
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
    }
}

function processYOLO(res, vW, vH, zone) {
    // ... 기존 코드
    const aspectRatio = bh / bw;
    
    // 3단 숫자형 신호등(세로로 매우 긴 형태)을 수용하기 위해 범위 확장
    // 일반 2단은 약 2.0, 3단은 3.0~4.5 수준입니다.
    const isValidShape = aspectRatio >= 1.2 && aspectRatio <= 6.5; 
    const isValidSize = bw > 5 && bh > 15; // 원거리 숫자형 대응을 위해 크기 제한 살짝 완화

    if (y > zone.yMin && (y + bh) < zone.yMax && isValidShape && isValidSize) {
        boxes.push({ x, y, w: bw, h: bh, score });
    }
    // ...
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
