/** [ULTRA VISION AI] - vision-worker.js
 *  [FIX] 안드로이드 호환성
 *  - tf.setBackend 동기 제거 → initBackend() 비동기 (webgl → cpu 폴백)
 *  [개선 대안3] 보행자 탐지율 향상
 *  - 보행자 줌 cy 위치: 0.38 → 0.58 (화면 하단 커버)
 *  - 보행자 전용 신뢰도 임계값: 0.20 → 0.12 (작은 신호등 탐지)
 *  - 보행자 줌 레벨 2개 추가: PED_LEFT2 / PED_RIGHT2 (초근거리)
 */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD:      0.20,   // 차량용 기본 임계값
    PED_CONF_THRESHOLD:  0.12,   // [대안3] 보행자 전용 임계값 (낮춰서 작은 신호등 탐지)
    TRAFFIC_LIGHT_CLASS: 9,
    NMS_IOU_THRESHOLD:   0.45,
    USE_SHARPENING:      true,
    SR_ENABLED:          true,

    ZOOM_LEVELS: [
        // ── 차량 신호 줌 ──────────────────────────────────────
        { scale: 1.0,  cx: 0.50, cy: 0.35, label: 'WIDE',       sr: false, pedMode: false },
        { scale: 0.5,  cx: 0.50, cy: 0.40, label: 'MID',        sr: true,  pedMode: false },
        { scale: 0.25, cx: 0.50, cy: 0.45, label: 'TELE',       sr: true,  pedMode: false },
        // ── 보행자 신호 줌 ────────────────────────────────────
        // [대안3] cy: 0.38 → 0.58 로 하향 조정 (보행자 신호등 실제 위치 반영)
        { scale: 0.30, cx: 0.10, cy: 0.58, label: 'PED_LEFT',   sr: true,  pedMode: true  },
        { scale: 0.30, cx: 0.90, cy: 0.58, label: 'PED_RIGHT',  sr: true,  pedMode: true  },
        { scale: 0.40, cx: 0.50, cy: 0.72, label: 'PED_NEAR',   sr: false, pedMode: true  },
        // [대안3] 초근거리 보행자 신호등 (코앞 기둥, scale 좁게)
        { scale: 0.20, cx: 0.10, cy: 0.70, label: 'PED_LEFT2',  sr: true,  pedMode: true  },
        { scale: 0.20, cx: 0.90, cy: 0.70, label: 'PED_RIGHT2', sr: true,  pedMode: true  },
    ]
};

let model      = null;
let srModel    = null;
let frameCount = 0;

// ─────────────────────────────────────────────
// [FIX] WebGL → cpu 폴백 백엔드 초기화
// ─────────────────────────────────────────────
async function initBackend() {
    try {
        await tf.setBackend('webgl');
        await tf.ready();
        console.log('[TF] backend: webgl');
    } catch (e) {
        console.warn('[TF] webgl 실패, cpu로 폴백:', e.message);
        try {
            await tf.setBackend('cpu');
            await tf.ready();
            console.log('[TF] backend: cpu');
        } catch (e2) {
            console.error('[TF] backend 초기화 전체 실패:', e2.message);
        }
    }
}

// ─────────────────────────────────────────────
// SRCNN-lite SR 모델 초기화
// ─────────────────────────────────────────────
async function initSuperResolution() {
    try {
        srModel = tf.sequential();
        srModel.add(tf.layers.conv2d({
            filters: 64, kernelSize: 9, activation: 'relu',
            padding: 'same', inputShape: [null, null, 3],
            kernelInitializer: 'glorotUniform'
        }));
        srModel.add(tf.layers.conv2d({
            filters: 32, kernelSize: 1, activation: 'relu',
            padding: 'same', kernelInitializer: 'glorotUniform'
        }));
        srModel.add(tf.layers.conv2d({
            filters: 3, kernelSize: 5, activation: 'sigmoid',
            padding: 'same', kernelInitializer: 'glorotUniform'
        }));
        await tf.tidy(() => srModel.predict(tf.zeros([1, 64, 64, 3])));
        console.log('[SR] SRCNN-lite initialized');
    } catch (err) {
        console.warn('[SR] SRCNN-lite init failed:', err.message);
        srModel = null;
    }
}

// ─────────────────────────────────────────────
// SRCNN-lite 2x SR (WIDE/MID/TELE 용)
// ─────────────────────────────────────────────
function applySuperResolution(tensor) {
    return tf.tidy(() => {
        const [, h, w] = tensor.shape;
        const upscaled = tensor.resizeBilinear([h * 2, w * 2]);
        if (!srModel) return applyAdaptiveSharpening(upscaled);
        const srOutput = srModel.predict(upscaled);
        const residual = srOutput.sub(0.5).mul(0.3);
        return upscaled.add(residual).clipByValue(0, 1);
    });
}

// ─────────────────────────────────────────────
// Edge-aware 4x SR (PED_LEFT / PED_RIGHT 전용)
// ─────────────────────────────────────────────
function applyEdgeAwareSR(tensor) {
    return tf.tidy(() => {
        const [, h, w] = tensor.shape;
        const up4x = tensor.resizeBilinear([h * 4, w * 4]);

        const gray   = up4x.mean(3, true);
        const sobelX = tf.tensor4d([-1, 0, 1, -2, 0, 2, -1, 0, 1], [3, 3, 1, 1]);
        const sobelY = tf.tensor4d([-1, -2, -1, 0, 0, 0, 1, 2, 1], [3, 3, 1, 1]);
        const eX     = tf.conv2d(gray, sobelX, 1, 'same');
        const eY     = tf.conv2d(gray, sobelY, 1, 'same');
        const edgeMap = eX.square().add(eY.square())
            .sqrt().div(4.0).clipByValue(0, 1);

        const lapKernel     = tf.tensor4d([0, -1, 0, -1, 5, -1, 0, -1, 0], [3, 3, 1, 1]);
        const channels      = tf.split(up4x, 3, 3);
        const sharpChannels = channels.map(ch => tf.conv2d(ch, lapKernel, 1, 'same'));
        const sharpened     = tf.concat(sharpChannels, 3);

        const edgeMask = edgeMap.tile([1, 1, 1, 3]);
        const weight   = edgeMask.mul(0.6);
        return sharpened.mul(weight)
                        .add(up4x.mul(weight.neg().add(1)))
                        .clipByValue(0, 1);
    });
}

function applyAdaptiveSharpening(tensor) {
    return tf.tidy(() => {
        const gaussKernel = tf.tensor4d(
            [1, 2, 1, 2, 4, 2, 1, 2, 1].map(v => v / 16), [3, 3, 1, 1]
        );
        const channels = tf.split(tensor, 3, 3);
        const blurred  = channels.map(ch => tf.conv2d(ch, gaussKernel, 1, 'same'));
        const blurredT = tf.concat(blurred, 3);
        return tensor.add(tensor.sub(blurredT).mul(1.5)).clipByValue(0, 1);
    });
}

// [FIX] kernel tf.tidy 내부 생성 → 메모리 누수 방지
function applySharpening(tensor) {
    return tf.tidy(() => {
        const kernel = tf.tensor4d([0, -1, 0, -1, 5, -1, 0, -1, 0], [3, 3, 1, 1]);
        return tf.conv2d(tensor, kernel, 1, 'same');
    });
}

function getZoomRect(imgW, imgH, zoom) {
    const w = imgW * zoom.scale;
    const h = imgH * zoom.scale;
    const x = (imgW * zoom.cx) - (w / 2);
    const y = (imgH * zoom.cy) - (h / 2);
    return {
        x: Math.max(0, Math.min(imgW - w, x)),
        y: Math.max(0, Math.min(imgH - h, y)),
        w, h
    };
}

async function loadModel() {
    await initBackend();  // [FIX] webgl → cpu 폴백

    if (model) { model.dispose(); model = null; }
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        await tf.tidy(() => model.execute(tf.zeros([1, 640, 640, 3])));
        await initSuperResolution();
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
    }
}

self.onmessage = async (e) => {
    const { type, data } = e.data;
    if (type === 'LOAD') { await loadModel(); return; }

    if (type === 'DETECT' && model) {
        frameCount++;
        const bitmap = data.bitmap;

        if (frameCount % 2 !== 0) {
            bitmap.close();
            self.postMessage({ type: 'SKIP' });
            return;
        }

        const currentZoom = CONFIG.ZOOM_LEVELS[(frameCount / 2) % CONFIG.ZOOM_LEVELS.length];
        const zoomRect    = getZoomRect(bitmap.width, bitmap.height, currentZoom);

        const useSR     = CONFIG.SR_ENABLED && currentZoom.sr;
        const useEdgeSR = useSR && currentZoom.pedMode &&
                          (currentZoom.label === 'PED_LEFT'  ||
                           currentZoom.label === 'PED_RIGHT' ||
                           currentZoom.label === 'PED_LEFT2' ||
                           currentZoom.label === 'PED_RIGHT2');

        // [대안3] 보행자 줌은 낮은 신뢰도 임계값 사용
        const confThreshold = currentZoom.pedMode
            ? CONFIG.PED_CONF_THRESHOLD
            : CONFIG.CONF_THRESHOLD;

        try {
            const result = tf.tidy(() => {
                let tensor = tf.browser.fromPixels(bitmap)
                    .slice(
                        [Math.floor(zoomRect.y), Math.floor(zoomRect.x), 0],
                        [Math.floor(zoomRect.h), Math.floor(zoomRect.w), 3]
                    )
                    .cast('float32')
                    .div(255.0);

                if (useEdgeSR) {
                    tensor = applyEdgeAwareSR(tensor.expandDims(0)).squeeze(0);
                } else if (useSR) {
                    tensor = applySuperResolution(tensor.expandDims(0)).squeeze(0);
                }

                tensor = tensor.resizeBilinear([640, 640]);

                if (CONFIG.USE_SHARPENING) {
                    tensor = applySharpening(tensor.expandDims(0)).squeeze(0);
                }

                const res        = model.execute(tensor.expandDims(0));
                const transposed = res.transpose([0, 2, 1]);

                return {
                    scores: transposed
                        .slice([0, 0, 4 + CONFIG.TRAFFIC_LIGHT_CLASS], [-1, -1, 1])
                        .reshape([-1]).arraySync(),
                    boxes: transposed
                        .slice([0, 0, 0], [-1, -1, 4])
                        .reshape([-1, 4]).arraySync()
                };
            });

            const detected = [];
            for (let i = 0; i < result.scores.length; i++) {
                // [대안3] 보행자/차량 임계값 분기 적용
                if (result.scores[i] > confThreshold) {
                    const [cx, cy, w, h] = result.boxes[i];
                    const localX = (cx - w / 2) * (zoomRect.w / 640);
                    const localY = (cy - h / 2) * (zoomRect.h / 640);
                    const localW = w  * (zoomRect.w / 640);
                    const localH = h  * (zoomRect.h / 640);
                    detected.push({
                        x: localX + zoomRect.x,
                        y: localY + zoomRect.y,
                        w: localW, h: localH,
                        score:     result.scores[i],
                        zoomLabel: currentZoom.label,
                        pedMode:   currentZoom.pedMode,
                        srApplied: useSR,
                        edgeSR:    useEdgeSR
                    });
                }
            }

            self.postMessage({
                type:       'RESULT',
                boxes:      nms(detected),
                currentZoom,
                srApplied:  useSR,
                edgeSR:     useEdgeSR
            });

        } catch (err) {
            console.error("Worker Error:", err);
            self.postMessage({ type: 'ERROR', message: err.message });
        } finally {
            bitmap.close();
        }
    }
};

function nms(boxes) {
    if (boxes.length === 0) return [];
    boxes.sort((a, b) => b.score - a.score);
    const kept = [], suppressed = new Set();
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
    const x1 = Math.max(a.x, b.x),              y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w),  y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}
