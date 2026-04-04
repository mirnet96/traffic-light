/* ════════════════════════════════════
   detector.yolo.js — YOLOv8s 320×320 고정 입력
════════════════════════════════════ */

const YOLO_MODEL_URL = '/traffic-light/models/yolov8s/model.json';

const INPUT_SIZE = 320;   // 모델 입력 고정값 (320×320)
const N_ANCHORS  = 2100;  // 320×320 입력 시 YOLOv8 출력 앵커 수 (8400 / 4)
const NEAR_THR   = 0.12;
const FAR_MIN    = 0.02;
const SCORE_NEAR = 0.45;
const SCORE_FAR  = 0.28;
const NMS_IOU    = 0.45;
const TILE_EVERY = 4;

const CLS_LIGHT  = 9;
const CLS_PERSON = 0;

let yoloModel  = null;
let frameCount = 0;

/* ── 추론용 임시 캔버스 (모듈 상단 1회 생성, 재사용) ── */
const tmpCanvas = document.createElement('canvas');
tmpCanvas.width  = INPUT_SIZE;
tmpCanvas.height = INPUT_SIZE;
const tmpCtx = tmpCanvas.getContext('2d');

/* ── 디버그 콜백 (DOM 직접 접근 금지 — app.js에서 주입) ── */
let _debugFn = null;
export function setDebugLogger(fn) { _debugFn = fn; }
function dbg(msg) { _debugFn && _debugFn(msg); }

/* ── 로드 + 워밍업 ── */
export async function loadYolo() {
  if (!window.tf) return false;
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    dbg(`[tf] backend: ${tf.getBackend()}`);

    yoloModel = await tf.loadGraphModel(YOLO_MODEL_URL);
    dbg('[yolo] model loaded');

    const dummy  = tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3]);
    const warmup = await yoloModel.executeAsync(dummy);
    tf.dispose(dummy);
    const wo = Array.isArray(warmup) ? warmup[0] : warmup;
    dbg(`[yolo] warmup shape: ${JSON.stringify(wo.shape)}`);
    dbg('(탭하면 닫힘)');
    Array.isArray(warmup) ? tf.dispose(warmup) : tf.dispose(warmup);
    return true;
  } catch (e) {
    dbg(`[yolo] load error: ${e.message}`);
    return false;
  }
}

/* ── 추론 진입점 ── */
export async function runYoloDetect(canvas, W, H) {
  if (!yoloModel || !window.tf) return [];
  frameCount++;

  const full = await inferCanvas(canvas, 0, 0, W, H, W, H);

  let tiled = [];
  if (frameCount % TILE_EVERY === 0) {
    const tileH = Math.floor(H / 2);
    tiled = await inferCanvas(canvas, 0, 0, W, tileH, W, H);
  }

  return nms([...full, ...tiled]);
}

/* ── 단일 영역 추론 ── */
async function inferCanvas(canvas, sx, sy, sw, sh, W, H) {
  const { tensor, scale, padX, padY } =
    preprocessRegion(canvas, sx, sy, sw, sh);

  const t0 = performance.now();
  let raw;
  try {
    raw = await yoloModel.executeAsync(tensor);
  } catch (e) {
    dbg(`[yolo] infer error: ${e.message}`);
    tf.dispose(tensor);
    return [];
  }

  const outTensor = Array.isArray(raw) ? raw[0] : raw;
  const data      = await outTensor.data();
  const inferMs   = (performance.now() - t0).toFixed(0);

  if (frameCount <= 3) dbg(`[infer#${frameCount}] time:${inferMs}ms`);

  tf.dispose(tensor);
  Array.isArray(raw) ? tf.dispose(raw) : tf.dispose(raw);

  return parseOutput(data, sx, sy, sw, sh, scale, padX, padY, W, H);
}

/* ── Letterbox 전처리 (tmpCanvas 재사용) ── */
function preprocessRegion(canvas, sx, sy, sw, sh) {
  const T     = INPUT_SIZE;
  const scale = Math.min(T / sw, T / sh);
  const newW  = Math.round(sw * scale);
  const newH  = Math.round(sh * scale);
  const padX  = (T - newW) / 2;
  const padY  = (T - newH) / 2;

  tmpCtx.fillStyle = '#808080';
  tmpCtx.fillRect(0, 0, T, T);
  tmpCtx.drawImage(canvas, sx, sy, sw, sh, padX, padY, newW, newH);

  const tensor = tf.tidy(() =>
    tf.expandDims(
      tf.div(tf.cast(tf.browser.fromPixels(tmpCanvas), 'float32'), 255.0),
      0
    )
  );
  return { tensor, scale, padX, padY };
}

/* ── 출력 파싱 [1,84,N_ANCHORS] ── */
function parseOutput(data, sx, sy, sw, sh, scale, padX, padY, W, H) {
  const N = N_ANCHORS, res = [];
  for (let i = 0; i < N; i++) {
    const cx = data[0*N+i], cy = data[1*N+i];
    const bw = data[2*N+i], bh = data[3*N+i];

    for (const cls of [CLS_LIGHT, CLS_PERSON]) {
      const score  = data[(4+cls)*N+i];
      const normH  = bh / INPUT_SIZE;
      const isNear = normH >= NEAR_THR;
      if (score < (isNear ? SCORE_NEAR : SCORE_FAR)) continue;

      const rx1 = ((cx - bw/2) - padX) / scale;
      const ry1 = ((cy - bh/2) - padY) / scale;
      const rx2 = ((cx + bw/2) - padX) / scale;
      const ry2 = ((cy + bh/2) - padY) / scale;

      const x1 = (sx + rx1) / W, y1 = (sy + ry1) / H;
      const x2 = (sx + rx2) / W, y2 = (sy + ry2) / H;

      if (x2<=0||y2<=0||x1>=1||y1>=1) continue;
      if ((Math.min(y2,1) - Math.max(y1,0)) < FAR_MIN) continue;

      res.push({
        id:    `yolo_${cls}_${i}_${sx}_${sy}`,
        cls,   score,
        range: isNear ? 'near' : 'far',
        box:   [Math.max(y1,0), Math.max(x1,0), Math.min(y2,1), Math.min(x2,1)],
        src:   'yolo',
      });
    }
  }
  return res;
}

/* ── NMS ── */
function nms(dets) {
  if (!dets.length) return [];
  dets.sort((a, b) => b.score - a.score);
  const kept = [], used = new Set();
  for (let i = 0; i < dets.length; i++) {
    if (used.has(i)) continue;
    kept.push(dets[i]);
    for (let j = i+1; j < dets.length; j++) {
      if (!used.has(j) && dets[i].cls === dets[j].cls &&
          calcIou(dets[i].box, dets[j].box) > NMS_IOU)
        used.add(j);
    }
  }
  return kept;
}

function calcIou(a, b) {
  const iy1=Math.max(a[0],b[0]), ix1=Math.max(a[1],b[1]);
  const iy2=Math.min(a[2],b[2]), ix2=Math.min(a[3],b[3]);
  const inter=Math.max(0,iy2-iy1)*Math.max(0,ix2-ix1);
  if (!inter) return 0;
  return inter/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter);
}
