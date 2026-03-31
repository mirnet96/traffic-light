/** [ULTRA VISION AI] - vision-worker.js (iOS 안정화 + 줌 스캔 통합) */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

// WebGL 백엔드 설정 및 메모리 최적화
tf.setBackend('webgl');

const CONFIG = {
    CONF_THRESHOLD:       0.20, 
    TRAFFIC_LIGHT_CLASS:  9,    
    NMS_IOU_THRESHOLD:    0.45,
    USE_SHARPENING:       true,
    // 줌 레벨 정의: [배율, 중심X, 중심Y, 라벨]
    ZOOM_LEVELS: [
        { scale: 1.0,  cx: 0.5, cy: 0.35, label: 'WIDE' }, // 1배: 전체 (상단 위주)
        { scale: 0.5,  cx: 0.5, cy: 0.40, label: 'MID'  }, // 2배: 중거리
        { scale: 0.25, cx: 0.5, cy: 0.45, label: 'TELE' }  // 4배: 초원거리 (소실점 타겟)
    ]
};

let model = null;
let frameCount = 0;

async function loadModel() {
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
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
 * Laplacian 샤프닝: 원거리 신호등의 엣지 강조
 */
function applySharpening(tensor) {
    const kernel = tf.tensor4d([0, -1, 0, -1, 5, -1, 0, -1, 0], [3, 3, 1, 1]);
    const sharpened = tf.conv2d(tensor, kernel, 1, 'same');
    kernel.dispose(); 
    return sharpened;
}

/**
 * 줌 영역 좌표 계산
 */
function getZoomRect(imgW, imgH, zoom) {
    const w = imgW * zoom.scale;
    const h = imgH * zoom.scale;
    const x = (imgW * zoom.cx) - (w / 2);
    const y = (imgH * zoom.cy) - (h / 2);
    return { 
        x: Math.max(0, Math.min(imgW - w, x)), 
        y: Math.max(0, Math.min(imgH - h, y)), 
        w: w, 
        h: h 
    };
}

self.onmessage = async (e) => {
    const { type, data } = e.data;
    if (type === 'LOAD') {
        await loadModel();
        return;
    }

    if (type === 'DETECT' && model) {
        frameCount++;
        const bitmap = data.bitmap;

        // iOS 안정성을 위해 2프레임당 1번 분석 (부하 절반 감소)
        if (frameCount % 2 !== 0) {
            bitmap.close();
            self.postMessage({ type: 'SKIP' });
            return;
        }

        // 3가지 줌 모드를 순차적으로 순환
        const currentZoom = CONFIG.ZOOM_LEVELS[(frameCount / 2) % CONFIG.ZOOM_LEVELS.length];
        const zoomRect = getZoomRect(bitmap.width, bitmap.height, currentZoom);

        try {
            const result = tf.tidy(() => {
                let tensor = tf.browser.fromPixels(bitmap)
                    .slice([Math.floor(zoomRect.y), Math.floor(zoomRect.x), 0], [Math.floor(zoomRect.h), Math.floor(zoomRect.w), 3])
                    .resizeBilinear([640, 640])
                    .cast('float32')
                    .div(255.0);

                if (CONFIG.USE_SHARPENING) {
                    tensor = applySharpening(tensor.expandDims(0)).squeeze(0);
                }

                const res = model.execute(tensor.expandDims(0));
                const transposed = res.transpose([0, 2, 1]);
                
                return {
                    scores: transposed.slice([0, 0, 4 + CONFIG.TRAFFIC_LIGHT_CLASS], [-1, -1, 1]).reshape([-1]).arraySync(),
                    boxes: transposed.slice([0, 0, 0], [-1, -1, 4]).reshape([-1, 4]).arraySync()
                };
            });

            const detected = [];
            for (let i = 0; i < result.scores.length; i++) {
                if (result.scores[i] > CONFIG.CONF_THRESHOLD) {
                    const [cx, cy, w, h] = result.boxes[i];
                    // 줌 내부 좌표 -> 원본 좌표로 역산 (Mapping)
                    const localX = (cx - w / 2) * (zoomRect.w / 640);
                    const localY = (cy - h / 2) * (zoomRect.h / 640);
                    const localW = w * (zoomRect.w / 640);
                    const localH = h * (zoomRect.h / 640);

                    detected.push({
                        x: localX + zoomRect.x,
                        y: localY + zoomRect.y,
                        w: localW,
                        h: localH,
                        score: result.scores[i],
                        zoomLabel: currentZoom.label
                    });
                }
            }

            self.postMessage({ 
                type: 'RESULT', 
                boxes: nms(detected),
                currentZoom: currentZoom 
            });

        } catch (err) {
            console.error("Worker Error:", err);
        } finally {
            bitmap.close(); // iOS 핵심: 분석 완료 후 무조건 비트맵 해제
        }
    }
};

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
