/* ════════════════════════════════════
   detector.yolo.js — YOLOv8n TF.js
════════════════════════════════════ */

/* YOLOv8n: 6MB, 입력 640×640, 모바일 ~60ms */
const YOLO_MODEL_URL =
  'https://cdn.jsdelivr.net/gh/niconielsen32/ultralytics-tfjs/yolov8n_web_model/model.json';

const NEAR_THR   = 0.12;
const FAR_MIN    = 0.02;
const SCORE_NEAR = 0.40;  // n 모델은 s보다 정밀도 낮으므로 임계값 소폭 하향
const SCORE_FAR  = 0.25;
const NMS_IOU    = 0.45;

const CLS_LIGHT  = 9;
const CLS_PERSON = 0;

let yoloModel = null;

/* ── 로드 + 워밍업 ── */
export async function loadYolo() {
  if (!window.tf) return false;
  try {
    yoloModel = await tf.loadGraphModel(YOLO_MODEL_URL);
    const dummy  = tf.zeros([1, 640, 640, 3]);
    const warmup = await yoloModel.executeAsync(dummy);
    tf.dispose(dummy);
    Array.isArray(warmup) ? tf.dispose(warmup) : tf.dispose(warmup);
    return true;
  } catch (e) {
    console.warn('YOLOv8n load failed:', e);
    return false;
  }
}

/* ── 추론 진입점 ── */
export async function runYoloDetect(canvas, W, H) {
  if (!yoloModel || !window.tf) return [];
  const { tensor, scale, padX, padY } = preprocessFrame(canvas);
  let raw;
  try {
    raw = await yoloModel.executeAsync(tensor);
  } catch (e) {
    console.warn('YOLOv8n inference error:', e);
    tf.dispose(tensor);
    return [];
  }
  const outTensor = Array.isArray(raw) ? raw[0] : raw;
  const data = await outTensor.data();
  tf.dispose(tensor);
  Array.isArray(raw) ? tf.dispose(raw) : tf.dispose(raw);

  return parseYoloOutput(data, W, H, scale, padX, padY);
}

/* ── Letterbox 전처리 ── */
function preprocessFrame(canvas) {
  const T     = 640;
  const W     = canvas.width;
  const H     = canvas.height;
  const scale = Math.min(T / W, T / H);
  const newW  = Math.round(W * scale);
  const newH  = Math.round(H * scale);
  const padX  = (T - newW) / 2;
  const padY  = (T - newH) / 2;

  const tmp = document.createElement('canvas');
  tmp.width  = T; tmp.height = T;
  const ctx  = tmp.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, T, T);
  ctx.drawImage(canvas, 0, 0, W, H, padX, padY, newW, newH);

  const tensor = tf.tidy(() =>
    tf.expandDims(
      tf.div(tf.cast(tf.browser.fromPixels(tmp), 'float32'), 255.0),
      0
    )
  );
  return { tensor, scale, padX, padY };
}

/* ── 출력 파싱 ── */
function parseYoloOutput(data, W, H, scale, padX, padY) {
  const N = 8400, res = [];
  for (let i = 0; i < N; i++) {
    const cx = data[0*N+i], cy = data[1*N+i];
    const bw = data[2*N+i], bh = data[3*N+i];
    for (const cls of [CLS_LIGHT, CLS_PERSON]) {
      const score  = data[(4+cls)*N+i];
      const normH  = bh / 640;
      const isNear = normH >= NEAR_THR;
      if (score < (isNear ? SCORE_NEAR : SCORE_FAR)) continue;

      const x1 = ((cx-bw/2)-padX)/scale/W;
      const y1 = ((cy-bh/2)-padY)/scale/H;
      const x2 = ((cx+bw/2)-padX)/scale/W;
      const y2 = ((cy+bh/2)-padY)/scale/H;
      if (x2<=0||y2<=0||x1>=1||y1>=1) continue;
      if ((Math.min(y2,1)-Math.max(y1,0)) < FAR_MIN) continue;

      res.push({
        id:    `yolo_${cls}_${i}`,
        cls,   score,
        range: isNear ? 'near' : 'far',
        box:   [Math.max(y1,0), Math.max(x1,0), Math.min(y2,1), Math.min(x2,1)],
        src:   'yolo',
      });
    }
  }
  return nms(res);
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
