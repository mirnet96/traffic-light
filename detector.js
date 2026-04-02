import { loadMediaPipe, runMediaPipeDetect } from './detector.mediapipe.js';
import { loadYolo, runYoloDetect }           from './detector.yolo.js';

/* ── 상수 ── */
const MP_THRESHOLD = 0.50;
const CLS_LIGHT    = 9;
const CLS_PERSON   = 0;

/* ── 모델 초기화 ── */
export async function loadModel(onMsg, onBadge) {
  onMsg('MediaPipe 로드 중...');
  const mpOk = await loadMediaPipe();

  onMsg('YOLOv8s 로드 중...');
  const yoloOk = await loadYolo();

  if (mpOk && yoloOk)  onBadge('MP + YOLO', 'text-green-400');
  else if (mpOk)        onBadge('MediaPipe', 'text-green-400');
  else if (yoloOk)      onBadge('YOLOv8s',  'text-yellow-400');
  else                  onBadge('모델 오류', 'text-red-400');
}

/* ── 폴백 체인 추론 ── */
export async function runYolo(canvas, W, H) {
  // 1차: MediaPipe
  const mpDets   = await runMediaPipeDetect(canvas, W, H);
  const confident = mpDets.filter(d => d.cls === CLS_LIGHT && d.score >= MP_THRESHOLD);

  if (confident.length > 0) {
    return classifySignals(confident, mpDets);
  }

  // 2차: YOLOv8s 폴백
  const yoloDets = await runYoloDetect(canvas, W, H);
  return classifySignals(
    yoloDets.filter(d => d.cls === CLS_LIGHT),
    yoloDets
  );
}

/* ── 보행 신호등 판별 ── */
function classifySignals(lights, allDets) {
  const persons = allDets.filter(d => d.cls === CLS_PERSON);
  return lights
    .map(l => ({
      ...l,
      isPedestrian: persons.some(p => iou(l.box, p.box) > 0.1),
      priority:     persons.some(p => iou(l.box, p.box) > 0.1) ? 2 : 1,
    }))
    .sort((a, b) => b.priority - a.priority || b.score - a.score);
}

/* ── IoU ── */
export function iou(a, b) {
  const iy1 = Math.max(a[0], b[0]), ix1 = Math.max(a[1], b[1]);
  const iy2 = Math.min(a[2], b[2]), ix2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, iy2 - iy1) * Math.max(0, ix2 - ix1);
  if (!inter) return 0;
  return inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter);
}
