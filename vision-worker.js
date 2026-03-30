/** [ULTRA VISION AI] - vision-worker.js (타일 크롭 + 교번 전략) */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD: 0.08,
    TRAFFIC_LIGHT_CLASS: 9,
    NMS_IOU_THRESHOLD: 0.45,
    MAX_BOXES: 5,
    USE_SHARPENING: true,

    // 화면 상단 몇 %를 타일 크롭으로 재추론할지 (신호등은 보통 상단 40% 안에 위치)
    TILE_CROP_RATIO: 0.40,

    // true  → 짝수 프레임=전체화면, 홀수=타일크롭 (추론 1회, 성능 영향 없음) ★권장
    // false → 매 프레임 전체화면+타일 동시 추론 (인식률 최대, 추론 2배)
    USE_ALTERNATING: true
};

let model = null;
let frameCount = 0;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
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
 * Laplacian 샤프닝: 원거리 신호등의 뭉개진 edge 강조
 */
function applySharpening(tensor) {
    const kernel = tf.tensor4d(
        [-1,-1,-1, -1,9,-1, -1,-1,-1],
        [3, 3, 1, 1]
    );
    const channels = tf.split(tensor, 3, 2);
    const sharpened = channels.map(ch => {
        const exp = ch.expandDims(0);
        const conv = tf.conv2d(exp, kernel, 1, 'same');
        const clipped = tf.clipByValue(conv, 0, 1);
        exp.dispose(); conv.dispose();
        return clipped.squeeze([0]);
    });
    const result = tf.concat(sharpened, 2);
    kernel.dispose();
    channels.forEach(c => c.dispose());
    sharpened.forEach(s => s.dispose());
    return result;
}

/**
 * 텐서 → YOLO 추론 → 박스 파싱
 * tensor: [H, W, 3] float32, 0~1 정규화 완료
 * outW/outH: 좌표 역변환 대상 크기 (원본 픽셀)
 * yOffset: 타일 크롭 시 원본 Y 시작 오프셋 (전체화면=0)
 */
async function runInference(tensor, outW, outH, zone, yOffset) {
    let t = tensor;
    if (CONFIG.USE_SHARPENING) {
        t = applySharpening(tensor);
    }
    const input = tf.image.resizeBilinear(t, [640, 640]).expandDims(0);
    if (CONFIG.USE_SHARPENING) t.dispose();

    const res = await model.executeAsync(input);
    input.dispose();

    const outputData = Array.isArray(res) ? res[0].dataSync() : res.dataSync();
    if (Array.isArray(res)) res.forEach(r => r.dispose()); else res.dispose();

    return processYOLO(outputData, outW, outH, zone, yOffset);
}

/**
 * YOLO raw output 파싱 + 좌표 역변환
 * yOffset: 타일의 원본 Y 시작점 — 이 값을 더해야 원본 좌표계로 복원됨
 */
function processYOLO(output, vW, vH, zone, yOffset) {
    const boxes = [];
    for (let i = 0; i < 8400; i++) {
        const score = output[8400 * (4 + CONFIG.TRAFFIC_LIGHT_CLASS) + i];
        if (score <= CONFIG.CONF_THRESHOLD) continue;

        const cx = output[8400 * 0 + i] * (vW / 640);
        const cy = output[8400 * 1 + i] * (vH / 640);
        const bw = output[8400 * 2 + i] * (vW / 640);
        const bh = output[8400 * 3 + i] * (vH / 640);

        const x = cx - bw / 2;
        const y = (cy - bh / 2) + yOffset; // 원본 좌표계 복원

        const aspectRatio = bh / bw;
        if (aspectRatio < 0.8 || aspectRatio > 8.0) continue;
        if (bw < 2 || bh < 5) continue;

        const inZone = y > (zone.yMin - 30) && (y + bh) < (zone.yMax + 30);
        if (!inZone) continue;

        boxes.push({ x, y, w: bw, h: bh, score });
    }
    return nms(boxes).sort((a, b) => b.score - a.score).slice(0, CONFIG.MAX_BOXES);
}

/**
 * [교번 전략] 성능 비용 1회 추론 = 전체화면과 타일크롭을 프레임마다 번갈아 수행
 *
 * 짝수 프레임: 전체 화면 → 근거리/중거리 신호등 커버
 * 홀수 프레임: 상단 40% 타일 → 원거리 신호등 전용 고해상도 추론
 *              (상단 40%가 640×640으로 확대되어 원거리 픽셀이 2.5배 커짐)
 *
 * lockCounter(30프레임 유지)가 공백을 채워주므로 화면이 끊기지 않음
 */
async function detectWithAlternating(bitmap, vW, vH, zone) {
    frameCount++;
    const isFullFrame = (frameCount % 2 === 0);

    if (isFullFrame) {
        // 패스 A: 전체 화면
        const tensor = tf.browser.fromPixels(bitmap).toFloat().div(255);
        const boxes = await runInference(tensor, vW, vH, zone, 0);
        tensor.dispose();
        return boxes;
    } else {
        // 패스 B: 상단 TILE_CROP_RATIO 타일 고해상도 추론
        const cropH = Math.floor(vH * CONFIG.TILE_CROP_RATIO);
        const fullTensor = tf.browser.fromPixels(bitmap).toFloat().div(255); // [vH, vW, 3]
        const cropTensor = fullTensor.slice([0, 0, 0], [cropH, vW, 3]);     // [cropH, vW, 3]
        fullTensor.dispose();

        // 타일 내 zone: 타일 자체가 화면 상단이므로 yMin=0, yMax=cropH
        const tileZone = { yMin: 0, yMax: cropH };
        // yOffset=0: 타일이 원본 최상단에서 시작하므로 오프셋 없음
        const boxes = await runInference(cropTensor, vW, cropH, tileZone, 0);
        cropTensor.dispose();
        return boxes;
    }
}

/**
 * [듀얼 패스] 매 프레임 전체+타일 동시 추론 (인식률 최대, 성능 2배)
 * USE_ALTERNATING=false 일 때 활성화
 */
async function detectWithDualPass(bitmap, vW, vH, zone) {
    const cropH = Math.floor(vH * CONFIG.TILE_CROP_RATIO);
    const fullTensor = tf.browser.fromPixels(bitmap).toFloat().div(255);
    const cropTensor = fullTensor.slice([0, 0, 0], [cropH, vW, 3]);

    const [fullBoxes, cropBoxes] = await Promise.all([
        runInference(fullTensor, vW, vH, zone, 0),
        runInference(cropTensor, vW, cropH, { yMin: 0, yMax: cropH }, 0)
    ]);

    fullTensor.dispose();
    cropTensor.dispose();

    return nms([...fullBoxes, ...cropBoxes])
        .sort((a, b) => b.score - a.score)
        .slice(0, CONFIG.MAX_BOXES);
}

function nms(boxes) {
    if (boxes.length === 0) return [];
    boxes.sort((a, b) => b.score - a.score);
    const kept = [];
    const suppressed = new Set();
    for (let i = 0; i < boxes.length; i++) {
        if (suppressed.has(i)) continue;
        kept.push(boxes[i]);
        for (let j = i + 1; j < boxes.length; j++) {
            if (iou(boxes[i], boxes[j]) > CONFIG.NMS_IOU_THRESHOLD) suppressed.add(j);
        }
    }
    return kept;
}

function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
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
            const boxes = CONFIG.USE_ALTERNATING
                ? await detectWithAlternating(bitmap, vW, vH, zone)
                : await detectWithDualPass(bitmap, vW, vH, zone);
            self.postMessage({ type: 'RESULT', boxes });
        } catch (err) {
            console.error("[Detection Error]:", err);
            self.postMessage({ type: 'RESULT', boxes: [] });
        } finally {
            bitmap.close();
        }
    }
};
