/* ════════════════════════════════════
   detector.mediapipe.js
   MediaPipe Tasks Vision — EfficientDet-Lite2
════════════════════════════════════ */

const MP_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const MP_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/' +
  'efficientdet_lite2/float32/1/efficientdet_lite2.tflite';

const MP_LABEL_MAP = { 'traffic light': 9, 'person': 0 };
const NEAR_THR = 0.12;
const FAR_MIN  = 0.02;

let mpDetector  = null;
let mpTimestamp = 0;

/* ── 로드 ── */
export async function loadMediaPipe() {
  try {
    const { FilesetResolver, ObjectDetector } = await import(MP_CDN);
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    mpDetector = await ObjectDetector.createFromOptions(vision, {
      baseOptions:        { modelAssetPath: MP_MODEL_URL, delegate: 'GPU' },
      scoreThreshold:     0.25,
      categoryAllowlist:  ['traffic light', 'person'],
      runningMode:        'VIDEO',
    });
    return true;
  } catch (e) {
    console.warn('MediaPipe load failed:', e);
    return false;
  }
}

/* ── 추론 ── */
export async function runMediaPipeDetect(canvas, W, H) {
  if (!mpDetector) return [];
  try {
    const result = mpDetector.detectForVideo(canvas, ++mpTimestamp);
    return parseMpResult(result, W, H);
  } catch (e) {
    console.warn('MediaPipe inference error:', e);
    return [];
  }
}

/* ── 출력 파싱 ── */
function parseMpResult(result, W, H) {
  if (!result?.detections?.length) return [];
  return result.detections.map(det => {
    const cat   = det.categories[0];
    const cls   = MP_LABEL_MAP[cat.categoryName];
    if (cls === undefined) return null;

    const bb    = det.boundingBox;
    const x1    = bb.originX / W,  y1 = bb.originY / H;
    const x2    = (bb.originX + bb.width) / W;
    const y2    = (bb.originY + bb.height) / H;
    const normH = y2 - y1;
    if (normH < FAR_MIN) return null;

    return {
      id:    `mp_${cls}_${Math.round(bb.originX)}`,
      cls,   score: cat.score,
      range: normH >= NEAR_THR ? 'near' : 'far',
      box:   [Math.max(y1,0), Math.max(x1,0), Math.min(y2,1), Math.min(x2,1)],
      src:   'mp',
    };
  }).filter(Boolean);
}
