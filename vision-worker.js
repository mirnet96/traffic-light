/** [ULTRA VISION AI] - vision-worker.js
 *  [FIX] 안드로이드 호환성: tf.setBackend 동기 제거 → initBackend() 비동기
 *  [FIX] 줌 레벨 인덱스 오류 수정
 *        frameCount / 2 → Math.floor(processCount) 기반으로 교체
 *        (4프레임 스킵과 줌 순환이 1:1로 맞물리도록)
 *  [PERF] EdgeAware SR 커널(Sobel X/Y, Laplacian)을 모듈 스코프에 캐싱
 *         매 추론마다 tf.tensor4d() 재생성 제거
 *  [PERF] arraySync() 블로킹 → 비동기 data() 방식으로 교체
 *         tf.tidy 외부에서 await tensor.data() 사용
 */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD:      0.20,
    PED_CONF_THRESHOLD:  0.12,
    TRAFFIC_LIGHT_CLASS: 9,
    NMS_IOU_THRESHOLD:   0.45,
    USE_SHARPENING:      true,
    SR_ENABLED:          true,

    ZOOM_LEVELS: [
        { scale: 1.0,  cx: 0.50, cy: 0.35, label: 'WIDE',       sr: false, pedMode: false },
        { scale: 0.5,  cx: 0.50, cy: 0.40, label: 'MID',        sr: true,  pedMode: false },
        { scale: 0.25, cx: 0.50, cy: 0.45, label: 'TELE',       sr: true,  pedMode: false },
        { scale: 0.30, cx: 0.10, cy: 0.58, label: 'PED_LEFT',   sr: true,  pedMode: true  },
        { scale: 0.30, cx: 0.90, cy: 0.58, label: 'PED_RIGHT',  sr: true,  pedMode: true  },
        { scale: 0.40, cx: 0.50, cy: 0.72, label: 'PED_NEAR',   sr: false, pedMode: true  },
        { scale: 0.20, cx: 0.10, cy: 0.70, label: 'PED_LEFT2',  sr: true,  pedMode: true  },
        { scale: 0.20, cx: 0.90, cy: 0.70, label: 'PED_RIGHT2', sr: true,  pedMode: true  },
    ]
};

let model        = null;
let srModel      = null;
let frameCount   = 0;
let processCount = 0;  // [FIX] 실제 처리된 프레임 수 (skip 제외)

// ─────────────────────────────────────────────
// [PERF] EdgeAware SR 커널 캐시 (모듈 스코프, 최초 1회 생성)
// tf.ready() 이후 initKernelCache()에서 초기화
// ─────────────────────────────────────────────
let K_SOBEL_X  = null;
let K_SOBEL_Y  = null;
let K_LAPLACE  = null;
let K_GAUSS    = null;
let K_SHARP    = null;

function initKernelCache() {
    K_SOBEL_X = tf.tensor4d([-1, 0, 1, -2, 0, 2, -1, 0, 1], [3, 3, 1, 1]);
    K_SOBEL_Y = tf.tensor4d([-1,-2,-1,  0, 0, 0,  1, 2, 1], [3, 3, 1, 1]);
    K_LAPLACE = tf.tensor4d([ 0,-1, 0, -1, 5,-1,  0,-1, 0], [3, 3, 1, 1]);
    K_GAUSS   = tf.tensor4d([1,2,1,2,4,2,1,2,1].map(v => v / 16), [3, 3, 1, 1]);
    K_SHARP   = tf.tensor4d([ 0,-1, 0, -1, 5,-1,  0,-1, 0], [3, 3, 1, 1]);
    console.log('[Kernels] 캐시 초기화 완료');
}

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
// SRCNN-lite 2x SR
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
// [PERF] Edge-aware 4x SR — 캐시된 커널 사용
// ─────────────────────────────────────────────
function applyEdgeAwareSR(tensor) {
    return tf.tidy(() => {
        const [, h, w] = tensor.shape;
        const up4x = tensor.resizeBilinear([h * 4, w * 4]);

        const gray    = up4x.mean(3, true);
        // [PERF] K_SOBEL_X / K_SOBEL_Y: 모듈 스코프 캐시 사용 (매번 재생성 없음)
        const eX      = tf.conv2d(gray, K_SOBEL_X, 1, 'same');
        const eY      = tf.conv2d(gray, K_SOBEL_Y, 1, 'same');
        const edgeMap = eX.square().add(eY.square())
            .sqrt().div(4.0).clipByValue(0, 1);

        // [PERF] K_LAPLACE: 캐시 사용
        const channels      = tf.split(up4x, 3, 3);
        const sharpChannels = channels.map(ch => tf.conv2d(ch, K_LAPLACE, 1, 'same'));
        const sharpened     = tf.concat(sharpChannels, 3);

        const edgeMask = edgeMap.tile([1, 1, 1, 3]);
        const weight   = edgeMask.mul(0.6);
        return sharpened.mul(weight)
                        .add(up4x.mul(weight.neg().add(1)))
                        .clipByValue(0, 1);
    });
}

// ─────────────────────────────────────────────
// [PERF] Adaptive Sharpening — 캐시된 가우시안 커널 사용
// ─────────────────────────────────────────────
function applyAdaptiveSharpening(tensor) {
    return tf.tidy(() => {
        const channels = tf.split(tensor, 3, 3);
        const blurred  = channels.map(ch => tf.conv2d(ch, K_GAUSS, 1, 'same'));
        const blurredT = tf.concat(blurred, 3);
        return tensor.add(tensor.sub(blurredT).mul(1.5)).clipByValue(0, 1);
    });
}

// ─────────────────────────────────────────────
// [PERF] Laplacian Sharpening — 캐시된 커널 사용
// ─────────────────────────────────────────────
function applySharpening(tensor) {
    return tf.tidy(() => {
        return tf.conv2d(tensor, K_SHARP, 1, 'same');
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

// ─────────────────────────────────────────────
// 모델 로드
// ─────────────────────────────────────────────
async function loadModel() {
    await initBackend();
    initKernelCache();  // [PERF] 백엔드 준비 후 커널 캐시 초기화

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

// ─────────────────────────────────────────────
// 메시지 핸들러
// ─────────────────────────────────────────────
self.onmessage = async (e) => {
    const { type, data } = e.data;
    if (type === 'LOAD') { await loadModel(); return; }

    if (type === 'DETECT' && model) {
        frameCount++;
        const bitmap = data.bitmap;

        // 4프레임 중 1프레임 처리
        if (frameCount % 4 !== 0) {
            bitmap.close();
            self.postMessage({ type: 'SKIP' });
            return;
        }

        // [FIX] 실제 처리 카운트를 별도로 관리 → 줌 레벨 순환이 1:1로 맞물림
        // 기존: (frameCount / 2) % len → frameCount=4,8,12... → 인덱스 2,4,6... (짝수만)
        // 수정: processCount++ 후 processCount % len → 0,1,2,3,4... 순차 순환
        const currentZoom = CONFIG.ZOOM_LEVELS[processCount % CONFIG.ZOOM_LEVELS.length];
        processCount++;

        const zoomRect  = getZoomRect(bitmap.width, bitmap.height, currentZoom);
        const useSR     = CONFIG.SR_ENABLED && currentZoom.sr;
        const useEdgeSR = useSR && currentZoom.pedMode &&
                          (currentZoom.label === 'PED_LEFT'  ||
                           currentZoom.label === 'PED_RIGHT' ||
                           currentZoom.label === 'PED_LEFT2' ||
                           currentZoom.label === 'PED_RIGHT2');

        const confThreshold = currentZoom.pedMode
            ? CONFIG.PED_CONF_THRESHOLD
            : CONFIG.CONF_THRESHOLD;

        try {
            // ─────────────────────────────────────────────
            // [PERF] tf.tidy 내부에서 텐서만 처리
            //        arraySync() 제거 → tidy 밖에서 await data() 사용
            // ─────────────────────────────────────────────
            const { scoresTensor, boxesTensor } = tf.tidy(() => {
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
                    scoresTensor: transposed
                        .slice([0, 0, 4 + CONFIG.TRAFFIC_LIGHT_CLASS], [-1, -1, 1])
                        .reshape([-1]),
                    boxesTensor: transposed
                        .slice([0, 0, 0], [-1, -1, 4])
                        .reshape([-1, 4])
                };
            });

            // [PERF] 비동기 data() — GPU → CPU 전송을 블로킹하지 않음
            const [scoresArr, boxesFlat] = await Promise.all([
                scoresTensor.data(),
                boxesTensor.data()
            ]);
            scoresTensor.dispose();
            boxesTensor.dispose();

            const detected = [];
            for (let i = 0; i < scoresArr.length; i++) {
                if (scoresArr[i] > confThreshold) {
                    const base  = i * 4;
                    const cx    = boxesFlat[base];
                    const cy    = boxesFlat[base + 1];
                    const bw    = boxesFlat[base + 2];
                    const bh    = boxesFlat[base + 3];
                    const localX = (cx - bw / 2) * (zoomRect.w / 640);
                    const localY = (cy - bh / 2) * (zoomRect.h / 640);
                    const localW = bw * (zoomRect.w / 640);
                    const localH = bh * (zoomRect.h / 640);
                    detected.push({
                        x: localX + zoomRect.x,
                        y: localY + zoomRect.y,
                        w: localW, h: localH,
                        score:     scoresArr[i],
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

// ─────────────────────────────────────────────
// NMS
// ─────────────────────────────────────────────
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
    const x1 = Math.max(a.x, b.x),             y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}
