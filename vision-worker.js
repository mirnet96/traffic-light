/** [ULTRA VISION AI] - vision-worker.js */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD: 0.15, 
    TRAFFIC_LIGHT_CLASS: 9 // COCO 데이터셋 기준 traffic light
};

let model = null;

async function loadModel() {
    try {
        // 모델 경로는 실제 파일 위치에 맞게 수정이 필요할 수 있습니다.
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

/**
 * YOLOv8 결과 해석 함수
 */
function processYOLO(res, vW, vH, zone) {
    const output = res.dataSync(); 
    const boxes = [];
    
    // YOLOv8 output shape: [1, 84, 8400] -> [class_scores, x, y, w, h]
    // 8400개의 후보 박스를 순회
    for (let i = 0; i < 8400; i++) {
        const score = output[8400 * (4 + CONFIG.TRAFFIC_LIGHT_CLASS) + i];
        
        if (score > CONFIG.CONF_THRESHOLD) {
            // 0~640 좌표를 원본 영상 크기로 변환
            const cx = output[8400 * 0 + i] * (vW / 640);
            const cy = output[8400 * 1 + i] * (vH / 640);
            const bw = output[8400 * 2 + i] * (vW / 640);
            const bh = output[8400 * 3 + i] * (vH / 640);
            
            const x = cx - bw / 2;
            const y = cy - bh / 2;
            
            const aspectRatio = bh / bw;
            // 3단 숫자형 신호등 대응을 위해 범위 확장 (1.2 ~ 6.5)
            const isValidShape = aspectRatio >= 1.2 && aspectRatio <= 6.5; 
            const isValidSize = bw > 5 && bh > 15;

            // 설정된 스캔 존(화면 상단부) 안에 있는지 확인
            if (y > zone.yMin && (y + bh) < zone.yMax && isValidShape && isValidSize) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    }
    
    // 점수 순으로 정렬 후 가장 확실한 것 반환
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

            // 메모리 해제
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
