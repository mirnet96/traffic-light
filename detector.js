'use strict';

/* ════════════════════════════════════
   detector.js — YOLOv8n 추론 + 감지 로직
════════════════════════════════════ */

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/niconielsen32/ultralytics-tfjs/yolov8n_web_model/model.json';

const CLS_TRAFFIC_LIGHT = 9;
const CLS_PERSON        = 0;

const NEAR_THR   = 0.12;
const FAR_MIN    = 0.02;
const SCORE_NEAR = 0.45;
const SCORE_FAR  = 0.28;
const NMS_IOU    = 0.45;

let model = null;

/* ── 모델 로드 ── */
async function loadModel(onMsg, onBadge) {
  if (model) return;
  onMsg('YOLOv8n 모델 로드 중...');
  try {
    model = await tf.loadGraphModel(MODEL_URL);
    const dummy = tf.zeros([1, 640, 640, 3]);
    await model.executeAsync(dummy);
    tf.dispose(dummy);
    onBadge('YOLOv8n', 'text-green-400');
  } catch (e) {
    console.warn('YOLOv8n load failed', e);
    onBadge('모델 오류', 'text-red-400');
  }
}

/* ── 전처리: Letterbox → [1, 640, 640, 3] ── */
function preprocessFrame(canvas, W, H) {
  const TARGET = 640;
  const scale  = Math.min(TARGET / W, TARGET / H);
  const newW   = Math.round(W * scale);
  const newH   = Math.round(H * scale);
  const padX   = (TARGET - newW) / 2;
  const padY   = (TARGET - newH) / 2;

  const tmp  = document.createElement('canvas');
  tmp.width  = TARGET;
  tmp.height = TARGET;
  const ctx  = tmp.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, TARGET, TARGET);
  ctx.drawImage(canvas, 0, 0, W, H, padX, padY, newW, newH);

  const tensor = tf.tidy(() =>
    tf.expandDims(tf.div(tf.cast(tf.browser.fromPixels(tmp), 'float32'), 255.0), 0)
  );
  return { tensor, scale, padX, padY };
}

/* ── IoU ── */
function iou(a, b) {
  const iy1 = Math.max(a[0], b[0]), ix1 = Math.max(a[1], b[1]);
  const iy2 = Math.min(a[2], b[2]), ix2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, iy2 - iy1) * Math.max(0, ix2 - ix1);
  if (!inter) return 0;
  return inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter);
}

/* ── Non-Maximum Suppression ── */
function nms(dets) {
  if (!dets.length) return [];
  dets.sort((a, b) => b.score - a.score);
  const kept = [], used = new Set();
  for (let i = 0; i < dets.length; i++) {
    if (used.has(i)) continue;
    kept.push(dets[i]);
    for (let j = i + 1; j < dets.length; j++) {
      if (!used.has(j) && dets[i].cls === dets[j].cls && iou(dets[i].box, dets[j].box) > NMS_IOU)
        used.add(j);
    }
  }
  return kept;
}

/* ── YOLOv8n 출력 파싱 ── */
function parseOutput(data, W, H, scale, padX, padY) {
  const N   = 8400;
  const res = [];

  for (let i = 0; i < N; i++) {
    const cx = data[0 * N + i], cy = data[1 * N + i];
    const bw = data[2 * N + i], bh = data[3 * N + i];

    for (const cls of [CLS_TRAFFIC_LIGHT, CLS_PERSON]) {
      const score  = data[(4 + cls) * N + i];
      const normH  = bh / 640;
      const isNear = normH >= NEAR_THR;
      if (score < (isNear ? SCORE_NEAR : SCORE_FAR)) continue;

      const x1 = ((cx - bw / 2) - padX) / scale / W;
      const y1 = ((cy - bh / 2) - padY) / scale / H;
      const x2 = ((cx + bw / 2) - padX) / scale / W;
      const y2 = ((cy + bh / 2) - padY) / scale / H;

      if (x2 <= 0 || y2 <= 0 || x1 >= 1 || y1 >= 1) continue;
      if ((Math.min(y2,1) - Math.max(y1,0)) < FAR_MIN) continue;

      res.push({
        id: i, cls, score, range: isNear ? 'near' : 'far',
        box: [Math.max(y1,0), Math.max(x1,0), Math.min(y2,1), Math.min(x2,1)],
      });
    }
  }
  return nms(res);
}

/* ── 추론 진입점 ── */
async function runYolo(canvas, W, H) {
  if (!model || !window.tf) return [];
  const { tensor, scale, padX, padY } = preprocessFrame(canvas, W, H);
  let raw;
  try {
    raw = await model.executeAsync(tensor);
  } catch (e) {
    console.warn('YOLO inference error', e);
    tf.dispose(tensor);
    return [];
  }
  const data = await raw.data();
  tf.dispose([tensor, raw]);
  return parseOutput(data, W, H, scale, padX, padY);
}

/* ── 보행 신호등 판별 ── */
function classifySignals(dets) {
  const lights  = dets.filter(d => d.cls === CLS_TRAFFIC_LIGHT);
  const persons = dets.filter(d => d.cls === CLS_PERSON);
  return lights
    .map(l => ({
      ...l,
      isPedestrian: persons.some(p => iou(l.box, p.box) > 0.1),
      priority:     persons.some(p => iou(l.box, p.box) > 0.1) ? 2 : 1,
    }))
    .sort((a, b) => b.priority - a.priority || b.score - a.score);
}
