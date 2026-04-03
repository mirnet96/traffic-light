/* ════════════════════════════════════
   detector.yolo.js — YOLOv8n + 상단 타일 원거리 보완
════════════════════════════════════ */

//  const YOLO_MODEL_URL = 'https://cdn.jsdelivr.net/gh/niconielsen32/ultralytics-tfjs/yolov8n_web_model/model.json';

const YOLO_MODEL_URL = '/traffic-light/models/yolov8s/model.json';

const NEAR_THR   = 0.12;
const FAR_MIN    = 0.02;
const SCORE_NEAR = 0.40;
const SCORE_FAR  = 0.25;
const NMS_IOU    = 0.45;
const TILE_EVERY = 3;    // N프레임마다 타일 추론 1회

const CLS_LIGHT  = 9;
const CLS_PERSON = 0;

let yoloModel  = null;
let frameCount = 0;

/* ── 로드 + 워밍업 ── */
export async function loadYolo() {
  if (!window.tf) return false;
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    console.log('[tf] backend:', tf.getBackend());

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
  frameCount++;

  // 1) 전체 프레임 추론
  const full = await inferCanvas(canvas, 0, 0, W, H, W, H);

  // 2) 상단 절반 타일 추론 (TILE_EVERY 프레임마다)
  let tiled = [];
  if (frameCount % TILE_EVERY === 0) {
    const tileH = Math.floor(H / 2);  // 상단 50%
    tiled = await inferCanvas(canvas, 0, 0, W, tileH, W, H);
  }

  // 3) 합산 후 NMS
  return nms([...full, ...tiled]);
}

/* ── 단일 영역 추론 ──
   sx,sy,sw,sh: 원본 canvas에서 잘라낼 영역
   W,H:         원본 전체 해상도 (정규화 기준)
── */
async function inferCanvas(canvas, sx, sy, sw, sh, W, H) {
  const { tensor, scale, padX, padY } =
    preprocessRegion(canvas, sx, sy, sw, sh);

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

  // 좌표를 원본 W/H 기준으로 역변환
  return parseOutput(data, sx, sy, sw, sh, scale, padX, padY, W, H);
}

/* ── Letterbox 전처리 (지정 영역만) ── */
function preprocessRegion(canvas, sx, sy, sw, sh) {
  const T     = 640;
  const scale = Math.min(T / sw, T / sh);
  const newW  = Math.round(sw * scale);
  const newH  = Math.round(sh * scale);
  const padX  = (T - newW) / 2;
  const padY  = (T - newH) / 2;

  const tmp = document.createElement('canvas');
  tmp.width  = T; tmp.height = T;
  const ctx  = tmp.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, T, T);
  // 원본의 sx,sy,sw,sh 영역 → tmp의 letterbox 위치로
  ctx.drawImage(canvas, sx, sy, sw, sh, padX, padY, newW, newH);

  const tensor = tf.tidy(() =>
    tf.expandDims(
      tf.div(tf.cast(tf.browser.fromPixels(tmp), 'float32'), 255.0),
      0
    )
  );
  return { tensor, scale, padX, padY };
}

/* ── 출력 파싱 + 원본 좌표 역변환 ── */
function parseOutput(data, sx, sy, sw, sh, scale, padX, padY, W, H) {
  const N = 8400, res = [];
  for (let i = 0; i < N; i++) {
    const cx = data[0*N+i], cy = data[1*N+i];
    const bw = data[2*N+i], bh = data[3*N+i];

    for (const cls of [CLS_LIGHT, CLS_PERSON]) {
      const score = data[(4+cls)*N+i];

      // 640 공간에서 정규화된 박스 높이로 근/원 판별
      const normH  = bh / 640;
      const isNear = normH >= NEAR_THR;
      if (score < (isNear ? SCORE_NEAR : SCORE_FAR)) continue;

      // 640 letterbox 좌표 → 잘라낸 영역(sw×sh) 내 픽셀 좌표
      const rx1 = ((cx - bw/2) - padX) / scale;
      const ry1 = ((cy - bh/2) - padY) / scale;
      const rx2 = ((cx + bw/2) - padX) / scale;
      const ry2 = ((cy + bh/2) - padY) / scale;

      // 원본 W×H 기준 정규화
      const x1 = (sx + rx1) / W;
      const y1 = (sy + ry1) / H;
      const x2 = (sx + rx2) / W;
      const y2 = (sy + ry2) / H;

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
  return res;  // NMS는 runYoloDetect에서 합산 후 일괄 처리
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
