/** [ULTRA VISION AI] - vision-worker.js (원거리 인식 개선) */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD: 0.08,        // 원거리 작은 신호등 대응 (더 낮춤)
    TRAFFIC_LIGHT_CLASS: 9,       // COCO 기준
    NMS_IOU_THRESHOLD: 0.45,      // 중복 박스 제거
    MAX_BOXES: 5,
    // [원거리 개선] 추론 전 이미지 샤프닝 여부
    USE_SHARPENING: true
};

let model = null;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        // 워밍업
        const dummy = tf.zeros([1, 640, 640, 3]);
        const res = await model.executeAsync(dummy);
        tf.dispose(dummy);
        tf.dispose(res);
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
    }
}

/**
 * [원거리 인식 개선] 
 * 640x640 리사이즈 전 샤프닝 커널 적용
 * 멀리 있는 신호등은 픽셀이 뭉개지므로 edge를 강조해야 YOLO가 감지 가능
 */
function applySharpening(tensor) {
    // Unsharp masking: 원본 - 가우시안 블러 → 디테일 강조
    // 커널: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]] (laplacian sharpening)
    const kernel = tf.tensor4d(
        [-1, -1, -1,
         -1,  9, -1,
         -1, -1, -1],
        [3, 3, 1, 1]
    );

    // 채널별로 샤프닝 적용
    const channels = tf.split(tensor, 3, 2); // [H,W,3] → 3x [H,W,1]
    const sharpened = channels.map(ch => {
        const expanded = ch.expandDims(0); // [1,H,W,1]
        const conv = tf.conv2d(expanded, kernel, 1, 'same');
        const clipped = tf.clipByValue(conv, 0, 1);
        return clipped.squeeze([0]); // [H,W,1]
    });

    const result = tf.concat(sharpened, 2); // [H,W,3]

    // 메모리 정리
    kernel.dispose();
    channels.forEach(c => c.dispose());
    sharpened.forEach(s => s.dispose());

    return result;
}

function processYOLO(output, vW, vH, zone) {
    const data = output;
    const boxes = [];

    for (let i = 0; i < 8400; i++) {
        const score = data[8400 * (4 + CONFIG.TRAFFIC_LIGHT_CLASS) + i];

        if (score > CONFIG.CONF_THRESHOLD) {
            const cx = data[8400 * 0 + i] * (vW / 640);
            const cy = data[8400 * 1 + i] * (vH / 640);
            const bw = data[8400 * 2 + i] * (vW / 640);
            const bh = data[8400 * 3 + i] * (vH / 640);

            const x = cx - bw / 2;
            const y = cy - bh / 2;

            const aspectRatio = bh / bw;
            // 원거리 신호등: 형태 비율 더 유연하게 (0.8 ~ 8.0)
            const isValidShape = aspectRatio >= 0.8 && aspectRatio <= 8.0;
            // 원거리 신호등: 최소 2px 이상 (매우 작게 보일 수 있음)
            const isValidSize = bw > 2 && bh > 5;

            const inZone = y > (zone.yMin - 30) && (y + bh) < (zone.yMax + 30);

            if (inZone && isValidShape && isValidSize) {
                boxes.push({ x, y, w: bw, h: bh, score });
            }
        }
    }

    return nms(boxes).sort((a, b) => b.score - a.score).slice(0, CONFIG.MAX_BOXES);
}

/**
 * Non-Maximum Suppression: 겹치는 박스 제거
 */
function nms(boxes) {
    if (boxes.length === 0) return [];
    boxes.sort((a, b) => b.score - a.score);
    const kept = [];
    const suppressed = new Set();

    for (let i = 0; i < boxes.length; i++) {
        if (suppressed.has(i)) continue;
        kept.push(boxes[i]);
        for (let j = i + 1; j < boxe
s.length; j++) {
            if (iou(boxes[i], boxes[j]) > CONFIG.NMS_IOU_THRESHOLD) {
                suppressed.add(j);
            }
        }
    }
    return kept;
}

function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}

self.onmessage = async (e) => {
    const { type, data } = e.data;

    if (type === 'LOAD') {
        await loadModel();
    } else if (type === 'DETECT') {
        if (!model) return;
        const { bitmap, vW, vH, zone } = data;

        try {
            // 1. 픽셀 → 텐서 변환
            let tensor = tf.browser.fromPixels(bitmap).toFloat().div(255); // [H,W,3] float32

            // 2. [원거리 개선] 샤프닝 적용
            if (CONFIG.USE_SHARPENING) {
                const sharpened = applySharpening(tensor);
                tensor.dispose();
                tensor = sharpened;
            }

            // 3. 640x640 리사이즈 + 배치 차원 추가
            const input = tf.image.resizeBilinear(tensor, [640, 640]).expandDims(0);
            tensor.dispose();

            // 4. 추론
            const res = await model.executeAsync(input);
            input.dispose();

            // 5. 결과 처리
            const outputData = Array.isArray(res) ? res[0].dataSync() : res.dataSync();
            const boxes = processYOLO(outputData, vW, vH, zone);

            self.postMessage({ type: 'RESULT', boxes });

            if (Array.isArray(res)) res.forEach(t => t.dispose());
            else res.dispose();
        } catch (err) {
            console.error("[Detection Error]:", err);
            self.postMessage({ type: 'RESULT', boxes: [] });
        } finally {
            bitmap.close();
        }
    }
};
