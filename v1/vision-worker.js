/** [ULTRA VISION AI] - vision-worker.js v5
 *  [FIX] tensor dispose를 finally로 보장 (예외 시 메모리 누수 방지)
 *  [FIX] initKernelCache 재호출 시 기존 커널 dispose 후 재생성
 *  [FIX] Sharpening을 scale<=0.5 줌레벨(MID/TELE/PED)에만 적용
 *  [KEEP] SR_ENABLED=false, processCount 순환, zoomRect 정수화, Math.round
 *  [KEEP] 탐지 성공 줌레벨 우선 반복 (lastSuccessZoomIdx)
 */
importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js");

const CONFIG = {
    CONF_THRESHOLD:      0.20,
    PED_CONF_THRESHOLD:  0.12,
    TRAFFIC_LIGHT_CLASS: 9,
    NMS_IOU_THRESHOLD:   0.45,
    SR_ENABLED:          false,

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
let frameCount   = 0;
let processCount = 0;
let lastSuccessZoomIdx = -1;
let successStreak      = 0;

// ─────────────────────────────────────────────
// 커널 캐시
// [FIX] 재초기화 시 기존 커널 dispose
// ─────────────────────────────────────────────
let K_SOBEL_X = null, K_SOBEL_Y = null, K_LAPLACE = null, K_GAUSS = null, K_SHARP = null;

function initKernelCache() {
    // [FIX] 기존 커널 dispose
    [K_SOBEL_X, K_SOBEL_Y, K_LAPLACE, K_GAUSS, K_SHARP].forEach(k => { try { if (k) k.dispose(); } catch(_){} });
    K_SOBEL_X = tf.tensor4d([-1,0,1,-2,0,2,-1,0,1],           [3,3,1,1]);
    K_SOBEL_Y = tf.tensor4d([-1,-2,-1,0,0,0,1,2,1],            [3,3,1,1]);
    K_LAPLACE = tf.tensor4d([0,-1,0,-1,5,-1,0,-1,0],           [3,3,1,1]);
    K_GAUSS   = tf.tensor4d([1,2,1,2,4,2,1,2,1].map(v=>v/16), [3,3,1,1]);
    K_SHARP   = tf.tensor4d([0,-1,0,-1,5,-1,0,-1,0],           [3,3,1,1]);
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
        const mask = edgeMap.tile([1,1,1,3]), w2 = mask.mul(0.6);
        return sharp.mul(w2).add(up.mul(w2.neg().add(1))).clipByValue(0,1);
    });
}

// [FIX] Sharpening — scale<=0.5 (원거리) 줌에만 적용
function applySharpening(tensor) {
    return tf.tidy(() => tf.conv2d(tensor, K_SHARP, 1, 'same'));
}

function getZoomRect(imgW, imgH, zoom) {
    const w = imgW * zoom.scale, h = imgH * zoom.scale;
    const x = (imgW * zoom.cx) - (w/2), y = (imgH * zoom.cy) - (h/2);
    return {
        x: Math.round(Math.max(0, Math.min(imgW-w, x))),
        y: Math.round(Math.max(0, Math.min(imgH-h, y))),
        w: Math.round(w), h: Math.round(h),
    };
}


async function loadModel() {
    await initBackend();
    initKernelCache();
    if (model) { model.dispose(); model = null; }

    // [DEBUG] 모델 파일 존재 여부 먼저 확인
    const MODEL_URL = './models/yolov8n_web_model/model.json';
    try {
        const res = await fetch(MODEL_URL, { method: 'HEAD' });
        if (!res.ok) {
            const msg = `model.json 없음 (HTTP ${res.status}) — 경로: ${MODEL_URL}`;
            console.error('[Worker]', msg);
            self.postMessage({ type: 'ERROR', message: msg });
            return;
        }
        console.log('[Worker] model.json 확인 OK');
    } catch (fetchErr) {
        const msg = `model.json fetch 실패: ${fetchErr.message}`;
        console.error('[Worker]', msg);
        self.postMessage({ type: 'ERROR', message: msg });
        return;
    }

    try {
        console.log('[Worker] 모델 로딩 시작...');
        model = await tf.loadGraphModel(MODEL_URL);
        console.log('[Worker] 모델 로딩 완료, 워밍업 중...');
        await tf.tidy(() => model.execute(tf.zeros([1, 640, 640, 3])));
        console.log('[Worker] 워밍업 완료');
        self.postMessage({ type: 'LOADED' });
    } catch (err) {
        console.error('[Worker] 모델 로딩 실패:', err);
        self.postMessage({ type: 'ERROR', message: `모델로드실패: ${err.message}` });
    }
}

self.onmessage = async (e) => {
    const { type, data } = e.data;
    if (type === 'LOAD') { await loadModel(); return; }

    if (type === 'DETECT' && model) {
        frameCount++;
        const bitmap = data.bitmap;

        if (frameCount % 4 !== 0) { bitmap.close(); self.postMessage({ type: 'SKIP' }); return; }

        let zoomIdx;
        if (lastSuccessZoomIdx >= 0 && successStreak < 3) zoomIdx = lastSuccessZoomIdx;
        else zoomIdx = processCount % CONFIG.ZOOM_LEVELS.length;
        processCount++;

        const currentZoom = CONFIG.ZOOM_LEVELS[zoomIdx];
        const zoomRect    = getZoomRect(bitmap.width, bitmap.height, currentZoom);
        const useSR       = CONFIG.SR_ENABLED && currentZoom.sr;
        const useEdgeSR   = useSR && currentZoom.pedMode && ['PED_LEFT','PED_RIGHT','PED_LEFT2','PED_RIGHT2'].includes(currentZoom.label);
        const confThr     = currentZoom.pedMode ? CONFIG.PED_CONF_THRESHOLD : CONFIG.CONF_THRESHOLD;

        // [FIX] Sharpening: scale <= 0.5 줌에만 적용 (WIDE 제외)
        const useSharp = currentZoom.scale <= 0.5;

        let scoresTensor = null, boxesTensor = null;
        try {
            ({ scoresTensor, boxesTensor } = tf.tidy(() => {
                let t = tf.browser.fromPixels(bitmap)
                    .slice([zoomRect.y, zoomRect.x, 0], [zoomRect.h, zoomRect.w, 3])
                    .cast('float32').div(255.0);

                if (useEdgeSR) t = applyEdgeAwareSR(t.expandDims(0)).squeeze(0);
                t = t.resizeBilinear([640, 640]);
                if (useSharp) t = applySharpening(t.expandDims(0)).squeeze(0);  // [FIX]

                const res = model.execute(t.expandDims(0));
                const tr  = res.transpose([0,2,1]);
                return {
                    scoresTensor: tr.slice([0,0,4+CONFIG.TRAFFIC_LIGHT_CLASS],[-1,-1,1]).reshape([-1]),
                    boxesTensor:  tr.slice([0,0,0],[-1,-1,4]).reshape([-1,4]),
                };
            }));

            const [scoresArr, boxesFlat] = await Promise.all([scoresTensor.data(), boxesTensor.data()]);

            const detected = [];
            for (let i = 0; i < scoresArr.length; i++) {
                if (scoresArr[i] > confThr) {
                    const b = i*4;
                    const cx = boxesFlat[b], cy = boxesFlat[b+1], bw = boxesFlat[b+2], bh = boxesFlat[b+3];
                    detected.push({
                        x: Math.round((cx-bw/2)*(zoomRect.w/640)) + zoomRect.x,
                        y: Math.round((cy-bh/2)*(zoomRect.h/640)) + zoomRect.y,
                        w: Math.round(bw*(zoomRect.w/640)),
                        h: Math.round(bh*(zoomRect.h/640)),
                        score: scoresArr[i], zoomLabel: currentZoom.label,
                        pedMode: currentZoom.pedMode, srApplied: useSR, edgeSR: useEdgeSR,
                    });
                }
            }

            const boxes = nms(detected);
            if (boxes.length > 0) { lastSuccessZoomIdx = zoomIdx; successStreak++; }
            else {
                if (lastSuccessZoomIdx === zoomIdx) successStreak++;
                else { lastSuccessZoomIdx = -1; successStreak = 0; }
                if (successStreak >= 3) { lastSuccessZoomIdx = -1; successStreak = 0; }
            }

            self.postMessage({ type: 'RESULT', boxes, currentZoom, srApplied: useSR, edgeSR: useEdgeSR });

        } catch (err) {
            console.error('Worker Error:', err);
            self.postMessage({ type: 'ERROR', message: err.message });
        } finally {
            // [FIX] 예외 발생해도 tensor 반드시 해제
            try { if (scoresTensor) scoresTensor.dispose(); } catch(_) {}
            try { if (boxesTensor)  boxesTensor.dispose();  } catch(_) {}
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
