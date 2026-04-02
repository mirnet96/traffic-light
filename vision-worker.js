/** [ULTRA VISION AI] - vision-worker.js v4
 *  [FIX] processCount 기반 줌 순환 (짝수 인덱스 스킵 버그 수정) ← 기존 유지
 *  [FIX] EdgeAware SR 커널 모듈 스코프 캐싱 ← 기존 유지
 *  [FIX] await tensor.data() 비동기 전환 ← 기존 유지
 *  [FIX] initBackend() webgl → cpu 폴백 ← 기존 유지
 *  [FIX] TELE 좌표 역매핑 오차: Math.round 적용, zoomRect 정수화
 *  [FIX] SR_ENABLED=false (SRCNN-lite 랜덤가중치 연산낭비 방지)
 *        → 대신 Laplacian Sharpening만 적용
 *  [NEW] YOLO 탐지 성공한 줌레벨 우선 반복 (lastSuccessZoomIdx)
 */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD:      0.20,
    PED_CONF_THRESHOLD:  0.12,
    TRAFFIC_LIGHT_CLASS: 9,
    NMS_IOU_THRESHOLD:   0.45,
    USE_SHARPENING:      true,
    SR_ENABLED:          false,   // [FIX] 랜덤가중치 SRCNN 비활성화

    ZOOM_LEVELS: [
        { scale: 1.0,  cx: 0.50, cy: 0.35, label: 'WIDE',       sr: false, pedMode: false },
        { scale: 0.5,  cx: 0.50, cy: 0.40, label: 'MID',        sr: false, pedMode: false },
        { scale: 0.25, cx: 0.50, cy: 0.45, label: 'TELE',       sr: false, pedMode: false },
        { scale: 0.30, cx: 0.10, cy: 0.58, label: 'PED_LEFT',   sr: false, pedMode: true  },
        { scale: 0.30, cx: 0.90, cy: 0.58, label: 'PED_RIGHT',  sr: false, pedMode: true  },
        { scale: 0.40, cx: 0.50, cy: 0.72, label: 'PED_NEAR',   sr: false, pedMode: true  },
        { scale: 0.20, cx: 0.10, cy: 0.70, label: 'PED_LEFT2',  sr: false, pedMode: true  },
        { scale: 0.20, cx: 0.90, cy: 0.70, label: 'PED_RIGHT2', sr: false, pedMode: true  },
    ]
};

let model        = null;
let srModel      = null;
let frameCount   = 0;
let processCount = 0;
let lastSuccessZoomIdx = -1;   // [NEW] 마지막 탐지 성공 줌 인덱스
let successStreak      = 0;    // [NEW] 연속 성공 횟수

// ─────────────────────────────────────────────
// 커널 캐시 (모듈 스코프, 1회 생성)
// ─────────────────────────────────────────────
let K_SOBEL_X = null, K_SOBEL_Y = null, K_LAPLACE = null, K_GAUSS = null, K_SHARP = null;

function initKernelCache() {
    K_SOBEL_X = tf.tensor4d([-1,0,1,-2,0,2,-1,0,1],      [3,3,1,1]);
    K_SOBEL_Y = tf.tensor4d([-1,-2,-1,0,0,0,1,2,1],       [3,3,1,1]);
    K_LAPLACE = tf.tensor4d([0,-1,0,-1,5,-1,0,-1,0],      [3,3,1,1]);
    K_GAUSS   = tf.tensor4d([1,2,1,2,4,2,1,2,1].map(v=>v/16), [3,3,1,1]);
    K_SHARP   = tf.tensor4d([0,-1,0,-1,5,-1,0,-1,0],      [3,3,1,1]);
    console.log('[Kernels] 캐시 완료');
}

async function initBackend() {
    try { await tf.setBackend('webgl'); await tf.ready(); console.log('[TF] webgl'); }
    catch (e) {
        console.warn('[TF] webgl 실패:', e.message);
        try { await tf.setBackend('cpu'); await tf.ready(); console.log('[TF] cpu'); }
        catch (e2) { console.error('[TF] 전체 실패:', e2.message); }
    }
}

// ─────────────────────────────────────────────
// SR 함수들 (SR_ENABLED=false 시 sharpening만 적용)
// ─────────────────────────────────────────────
function applyEdgeAwareSR(tensor) {
    return tf.tidy(() => {
        const [,h,w] = tensor.shape;
        const up = tensor.resizeBilinear([h*4, w*4]);
        const gray = up.mean(3, true);
        const eX = tf.conv2d(gray, K_SOBEL_X, 1, 'same');
        const eY = tf.conv2d(gray, K_SOBEL_Y, 1, 'same');
        const edgeMap = eX.square().add(eY.square()).sqrt().div(4.0).clipByValue(0,1);
        const chs = tf.split(up, 3, 3);
        const sharp = tf.concat(chs.map(ch => tf.conv2d(ch, K_LAPLACE, 1, 'same')), 3);
        const mask = edgeMap.tile([1,1,1,3]);
        const w2 = mask.mul(0.6);
        return sharp.mul(w2).add(up.mul(w2.neg().add(1))).clipByValue(0,1);
    });
}

function applySharpening(tensor) {
    return tf.tidy(() => tf.conv2d(tensor, K_SHARP, 1, 'same'));
}

// ─────────────────────────────────────────────
// [FIX] zoomRect 정수화 → 좌표 역매핑 오차 최소화
// ─────────────────────────────────────────────
function getZoomRect(imgW, imgH, zoom) {
    const w = imgW * zoom.scale, h = imgH * zoom.scale;
    const x = (imgW * zoom.cx) - (w / 2), y = (imgH * zoom.cy) - (h / 2);
    return {
        x: Math.round(Math.max(0, Math.min(imgW - w, x))),
        y: Math.round(Math.max(0, Math.min(imgH - h, y))),
        w: Math.round(w),
        h: Math.round(h),
    };
}

async function loadModel() {
    await initBackend();
    initKernelCache();
    if (model) { model.dispose(); model = null; }
    try {
        model = await tf.loadGraphModel('./models/yolov8n_web_model/model.json');
        await tf.tidy(() => model.execute(tf.zeros([1,640,640,3])));
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

        if (frameCount % 4 !== 0) { bitmap.close(); self.postMessage({ type: 'SKIP' }); return; }

        // [NEW] 탐지 성공 줌레벨 우선 반복 (최대 3회 연속)
        let zoomIdx;
        if (lastSuccessZoomIdx >= 0 && successStreak < 3) {
            zoomIdx = lastSuccessZoomIdx;
        } else {
            zoomIdx = processCount % CONFIG.ZOOM_LEVELS.length;
        }
        processCount++;

        const currentZoom = CONFIG.ZOOM_LEVELS[zoomIdx];
        const zoomRect    = getZoomRect(bitmap.width, bitmap.height, currentZoom);

        // [FIX] SR_ENABLED=false → EdgeAware SR도 비활성화
        const useSR     = CONFIG.SR_ENABLED && currentZoom.sr;
        const useEdgeSR = useSR && currentZoom.pedMode &&
            ['PED_LEFT','PED_RIGHT','PED_LEFT2','PED_RIGHT2'].includes(currentZoom.label);

        const confThr = currentZoom.pedMode ? CONFIG.PED_CONF_THRESHOLD : CONFIG.CONF_THRESHOLD;

        try {
            const { scoresTensor, boxesTensor } = tf.tidy(() => {
                let t = tf.browser.fromPixels(bitmap)
                    .slice(
                        [zoomRect.y, zoomRect.x, 0],
                        [zoomRect.h, zoomRect.w, 3]
                    )
                    .cast('float32').div(255.0);

                // [FIX] SR 비활성화 — sharpening만 적용
                if (useEdgeSR) {
                    t = applyEdgeAwareSR(t.expandDims(0)).squeeze(0);
                }

                t = t.resizeBilinear([640, 640]);
                if (CONFIG.USE_SHARPENING) t = applySharpening(t.expandDims(0)).squeeze(0);

                const res  = model.execute(t.expandDims(0));
                const tr   = res.transpose([0,2,1]);
                return {
                    scoresTensor: tr.slice([0,0,4+CONFIG.TRAFFIC_LIGHT_CLASS],[-1,-1,1]).reshape([-1]),
                    boxesTensor:  tr.slice([0,0,0],[-1,-1,4]).reshape([-1,4]),
                };
            });

            const [scoresArr, boxesFlat] = await Promise.all([scoresTensor.data(), boxesTensor.data()]);
            scoresTensor.dispose(); boxesTensor.dispose();

            const detected = [];
            for (let i = 0; i < scoresArr.length; i++) {
                if (scoresArr[i] > confThr) {
                    const b = i * 4;
                    const cx = boxesFlat[b], cy = boxesFlat[b+1], bw = boxesFlat[b+2], bh = boxesFlat[b+3];
                    // [FIX] Math.round로 오차 최소화
                    const lx = Math.round((cx - bw/2) * (zoomRect.w / 640));
                    const ly = Math.round((cy - bh/2) * (zoomRect.h / 640));
                    const lw = Math.round(bw * (zoomRect.w / 640));
                    const lh = Math.round(bh * (zoomRect.h / 640));
                    detected.push({
                        x: lx + zoomRect.x, y: ly + zoomRect.y, w: lw, h: lh,
                        score: scoresArr[i], zoomLabel: currentZoom.label,
                        pedMode: currentZoom.pedMode, srApplied: useSR, edgeSR: useEdgeSR,
                    });
                }
            }

            const boxes = nms(detected);

            // [NEW] 탐지 성공 시 해당 줌레벨 우선 유지
            if (boxes.length > 0) {
                lastSuccessZoomIdx = zoomIdx;
                successStreak++;
            } else {
                if (lastSuccessZoomIdx === zoomIdx) successStreak++;
                else { lastSuccessZoomIdx = -1; successStreak = 0; }
                if (successStreak >= 3) { lastSuccessZoomIdx = -1; successStreak = 0; }
            }

            self.postMessage({ type: 'RESULT', boxes, currentZoom, srApplied: useSR, edgeSR: useEdgeSR });

        } catch (err) {
            console.error('Worker Error:', err);
            self.postMessage({ type: 'ERROR', message: err.message });
        } finally {
            bitmap.close();
        }
    }
};

function nms(boxes) {
    if (!boxes.length) return [];
    boxes.sort((a,b) => b.score - a.score);
    const kept = [], sup = new Set();
    for (let i = 0; i < boxes.length; i++) {
        if (sup.has(i)) continue;
        kept.push(boxes[i]);
        for (let j = i+1; j < boxes.length; j++)
            if (iou(boxes[i], boxes[j]) > CONFIG.NMS_IOU_THRESHOLD) sup.add(j);
    }
    return kept;
}
function iou(a, b) {
    const x1=Math.max(a.x,b.x), y1=Math.max(a.y,b.y);
    const x2=Math.min(a.x+a.w,b.x+b.w), y2=Math.min(a.y+a.h,b.y+b.h);
    const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1);
    const union=a.w*a.h+b.w*b.h-inter;
    return union>0 ? inter/union : 0;
}
