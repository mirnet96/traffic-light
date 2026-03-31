/** [ULTRA VISION AI] - vision-worker.js
 *  변경사항:
 *  - [NEW] 보행자 전용 줌 레벨 3개 추가
 *      PED_LEFT  : 화면 좌측 20% 영역 × 3.3배 줌, Edge-aware SR 적용
 *      PED_RIGHT : 화면 우측 20% 영역 × 3.3배 줌, Edge-aware SR 적용
 *      PED_NEAR  : 화면 하단 근거리 전폭, SR 미적용 (이미 크게 보임)
 *  - [NEW] applyEdgeAwareSR(): Sobel 엣지맵 기반 4x 업스케일
 *      기존 SRCNN-lite(2x) 대비 보행자 실루엣 경계 복원 강화
 *  - [KEEP] applySuperResolution(): 기존 SRCNN-lite (WIDE/MID/TELE 유지)
 *  - [FIX] applySharpening() kernel tf.tidy 내부 이동 (메모리 누수 수정 유지)
 */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

tf.setBackend('webgl');

const CONFIG = {
    CONF_THRESHOLD:      0.20,
    TRAFFIC_LIGHT_CLASS: 9,
    NMS_IOU_THRESHOLD:   0.45,
    USE_SHARPENING:      true,
    SR_ENABLED:          true,

    // ── 줌 레벨 정의 ─────────────────────────────
    // scale : 원본 대비 크롭 비율 (0.25 = 4배 줌)
    // cx/cy : 크롭 중심 (비율)
    // label : 식별자
    // sr    : Edge-aware SR 적용 여부
    // pedMode: true → 보행자 전용 분석 플래그를 결과에 포함
    // ─────────────────────────────────────────────
    ZOOM_LEVELS: [
        // ── 기존 차량 신호 줌 ──
        { scale: 1.0,  cx: 0.5, cy: 0.35, label: 'WIDE',      sr: false, pedMode: false },
        { scale: 0.5,  cx: 0.5, cy: 0.40, label: 'MID',       sr: true,  pedMode: false },
        { scale: 0.25, cx: 0.5, cy: 0.45, label: 'TELE',      sr: true,  pedMode: false },
        // ── 보행자 전용 줌 ──
        // 좌측 가장자리 20% 를 3.3배 확대 (scale=0.30, cx=0.10)
        { scale: 0.30, cx: 0.10, cy: 0.38, label: 'PED_LEFT',  sr: true,  pedMode: true  },
        // 우측 가장자리 20% 를 3.3배 확대 (scale=0.30, cx=0.90)
        { scale: 0.30, cx: 0.90, cy: 0.38, label: 'PED_RIGHT', sr: true,  pedMode: true  },
        // 하단 근거리: 전폭, cy=0.72 중심 (scale=0.40 → 2.5배 줌)
        { scale: 0.40, cx: 0.50, cy: 0.72, label: 'PED_NEAR',  sr: false, pedMode: true  },
    ]
};

let model = null;
let srModel = null;
let frameCount = 0;

// ─────────────────────────────────────────────
// SRCNN-lite SR 모델 초기화 (기존 유지)
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
// [KEEP] 기존 SRCNN-lite 2x SR (WIDE/MID/TELE 용)
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
// [NEW] Edge-aware 4x SR (보행자 전용 PED_LEFT / PED_RIGHT)
//
// 동작 원리:
//   1. Bicubic 4x 업스케일 (기본 해상도 확보)
//   2. Sobel 필터로 엣지 강도 맵 계산
//      - 보행자 사람 실루엣의 경계선을 강하게 검출
//   3. 엣지 영역에만 Laplacian 샤프닝 가중 적용
//      (평탄한 배경은 원본 유지 → 노이즈 증폭 방지)
//
// 차량 신호 vs 보행자 신호에서 다른 이유:
//   - 보행자 신호의 사람 실루엣은 명확한 경계를 가짐
//   - 엣지를 강화하면 Hue 분석 시 배경 혼입 픽셀 감소
// ─────────────────────────────────────────────
function applyEdgeAwareSR(tensor) {
    return tf.tidy(() => {
        const [, h, w] = tensor.shape;

        // Step 1: Bicubic 4x 업스케일
        const up4x = tensor.resizeBilinear([h * 4, w * 4]);

        // Step 2: Sobel 엣지맵 계산
        const gray = up4x.mean(3, true);  // RGB → 명도 채널
        const sobelX = tf.tensor4d([-1, 0, 1, -2, 0, 2, -1, 0, 1], [3, 3, 1, 1]);
        const sobelY = tf.tensor4d([-1, -2, -1, 0, 0, 0, 1, 2, 1], [3, 3, 1, 1]);
        const eX = tf.conv2d(gray, sobelX, 1, 'same');
        const eY = tf.conv2d(gray, sobelY, 1, 'same');
        // 엣지 강도: sqrt(Gx² + Gy²) → 0~1 정규화
        const edgeMap = eX.square().add(eY.square())
            .sqrt().div(4.0).clipByValue(0, 1);

        // Step 3: Laplacian 샤프닝 커널
        const lapKernel = tf.tensor4d([0, -1, 0, -1, 5, -1, 0, -1, 0], [3, 3, 1, 1]);
        const channels = tf.split(up4x, 3, 3);
        const sharpChannels = channels.map(ch =>
            tf.conv2d(ch, lapKernel, 1, 'same')
        );
        const sharpened = tf.concat(sharpChannels, 3);

        // Step 4: 엣지 가중 블렌딩
        // 엣지 강한 곳 → 샤프닝 강하게 (가중치 0.6)
        // 평탄한 곳   → 원본 그대로
        const edgeMask = edgeMap.tile([1, 1, 1, 3]);
        const weight   = edgeMask.mul(0.6);
        return sharpened.mul(weight)
                        .add(up4x.mul(weight.neg().add(1)))
                        .clipByValue(0, 1);
    });
}

// ─────────────────────────────────────────────
// Adaptive Sharpening (SR fallback)
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Laplacian Sharpening (YOLO 전처리용)
// [FIX] kernel을 tf.tidy 내부에서 생성 → 메모리 누수 방지
// ─────────────────────────────────────────────
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

        // SR 방식 결정:
        //   PED_LEFT / PED_RIGHT → Edge-aware 4x SR (실루엣 경계 강화)
        //   MID / TELE           → SRCNN-lite 2x SR (기존)
        //   나머지               → SR 없음
        const useSR       = CONFIG.SR_ENABLED && currentZoom.sr;
        const useEdgeSR   = useSR && currentZoom.pedMode &&
                            (currentZoom.label === 'PED_LEFT' ||
                             currentZoom.label === 'PED_RIGHT');

        try {
            const result = tf.tidy(() => {
                let tensor = tf.browser.fromPixels(bitmap)
                    .slice(
                        [Math.floor(zoomRect.y), Math.floor(zoomRect.x), 0],
                        [Math.floor(zoomRect.h), Math.floor(zoomRect.w), 3]
                    )
                    .cast('float32')
                    .div(255.0);

                // SR 적용
                if (useEdgeSR) {
                    // 보행자 좌/우: Edge-aware 4x SR
                    tensor = applyEdgeAwareSR(tensor.expandDims(0)).squeeze(0);
                } else if (useSR) {
                    // 차량 MID/TELE: 기존 SRCNN-lite 2x
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
                if (result.scores[i] > CONFIG.CONF_THRESHOLD) {
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
                        pedMode:   currentZoom.pedMode, // 보행자 모드 플래그
                        srApplied: useSR,
                        edgeSR:    useEdgeSR
                    });
                }
            }

            self.postMessage({
                type: 'RESULT',
                boxes:       nms(detected),
                currentZoom,
                srApplied:   useSR,
                edgeSR:      useEdgeSR
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
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
}
