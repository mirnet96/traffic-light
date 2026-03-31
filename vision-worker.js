/** [ULTRA VISION AI] - vision-worker.js (tf.tidy 메모리 누수 방지 + 타일 크롭 교번 전략) */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD:       0.08,
    TRAFFIC_LIGHT_CLASS:  9,
    NMS_IOU_THRESHOLD:    0.45,
    MAX_BOXES:            5,
    USE_SHARPENING:       true,
    TILE_CROP_RATIO:      0.40,
    USE_ALTERNATING:      true
};

let model = null;
let frameCount = 0;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        // 워밍업 (첫 추론 속도 개선)
        await tf.tidy(() => {
            const dummy = tf.zeros([1, 640, 640, 3]);
            return model.execute(dummy);
        });
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
    }
}

/**
 * Laplacian 샤프닝: 원거리 신호등의 뭉개진 edge 강조
 * ★ tidy 내부에서 호출 가정 — 내부 중간 텐서는 tidy가 정리
 */
function applySharpening(tensor) {
    const kernel = tf.tensor4d(
        [-1,-1,-1, -1,9,-1, -1,-1,-1],
        [3, 3, 1, 1]
    );
    const channels = tf.split(tensor, 3, 2);
    const sharpened = channels.map(ch => {
        const exp  = ch.expandDims(0);
        const conv = tf.conv2d(exp, kernel, 1, 'same');
        return tf.clipByValue(conv, 0, 1).squeeze([0]);
    });
    kernel.dispose();
    return tf.concat(sharpened, 2);
}

/**
 * ★ 텐서 → YOLO 추론 → 박스 파싱
 *   tf.tidy()로 중간 텐서 자동 정리 (메모리 누수 핵심 수정)
 */
async function runInference(tensor, outW, outH, zone, yOffset) {
    // tidy 안에서 input 준비 (중간 텐서 자동 해제)
    const input = tf.tidy(() => {
        const t = CONFIG.USE_SHARPENING ? applySharpening(tensor) : tensor;
        return tf.image.resizeBilinear(t, [640, 640]).expandDims(0);
    });

    // 원본 tensor 해제 (transferable로 받은 것)
    tensor.dispose();

    let outputData;
    try {
        const res = await model.executeAsync(input);
        if (Array.isArray(res)) {
            outputData = res[0].dataSync();
            res.forEach(r => r.dispose());
        } else {
            outputData = res.dataSync();
            res.dispose();
        }
    } finally {
        input.dispose();
    }

    return processYOLO(outputData, outW, outH, zone, yOffset);
}

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
        const y = (cy - bh / 2) + yOffset;

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
 * ★ 교번 전략: 짝수=전체화면, 홀수=상단 타일 고해상도
 *   각 패스에서 tf.tidy로 중간 텐서 완전 정리
 */
async function detectWithAlternating(bitmap, vW, vH, zone) {
    frameCount++;
    const isFullFrame = (frameCount % 2 === 0);

    if (isFullFrame) {
        // 패스 A: 전체 화면
        const tensor = tf.browser.fromPixels(bitmap).toFloat().div(255);
        return await runInference(tensor, vW, vH, zone, 0);
    } else {
        // 패스 B: 상단 TILE_CROP_RATIO 타일
        const cropH = Math.floor(vH * CONFIG.TILE_CROP_RATIO);
        const fullTensor = tf.browser.fromPixels(bitmap).toFloat().div(255);
        const cropTensor = tf.tidy(() => fullTensor.slice([0, 0, 0], [cropH, vW, 3]));
        fullTensor.dispose();

        const tileZone = { yMin: 0, yMax: cropH };
        return await runInference(cropTensor, vW, cropH, tileZone, 0);
    }
}

/**
 * 듀얼 패스: 매 프레임 전체+타일 동시 추론 (USE_ALTERNATING=false 시 사용)
 */
async function detectWithDualPass(bitmap, vW, vH, zone) {
    const cropH = Math.floor(vH * CONFIG.TILE_CROP_RATIO);

    const fullTensor = tf.browser.fromPixels(bitmap).toFloat().div(255);
    const cropTensor = tf.tidy(() => fullTensor.slice([0, 0, 0], [cropH, vW, 3]));

    const [fullBoxes, cropBoxes] = await Promise.all([
        runInference(fullTensor, vW, vH, zone, 0),
        runInference(cropTensor, vW, cropH, { yMin: 0, yMax: cropH }, 0)
    ]);

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
            // ★ bitmap 반드시 해제 (메모리 누수 핵심)
            bitmap.close();
        }
    }
};
