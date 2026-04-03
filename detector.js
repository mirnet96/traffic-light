import { loadYolo, runYoloDetect } from './detector.yolo.js';

/* ── 상수 ── */
const CLS_LIGHT  = 9;
const CLS_PERSON = 0;

/* ── 모델 초기화 ── */
export async function loadModel(onMsg, onBadge) {
  onMsg('YOLOv8n 로드 중...');
  const ok = await loadYolo();
  onBadge(ok ? 'YOLOv8n' : '모델 오류', ok ? 'text-green-400' : 'text-red-400');
}

/* ── 추론 ── */
export async function runYolo(canvas, W, H) {
  const dets = await runYoloDetect(canvas, W, H);
  return classifySignals(
    dets.filter(d => d.cls === CLS_LIGHT),
    dets
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
      src: 'yolo',
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
