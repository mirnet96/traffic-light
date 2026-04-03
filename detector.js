import { loadMediaPipe, runMediaPipeDetect } from './detector.mediapipe.js';
import { loadYolo, runYoloDetect }           from './detector.yolo.js';

/* ── 상수 ── */
const MP_THRESHOLD  = 0.50;
const MP_ANY_MIN    = 0.25;  // ★ MP가 뭔가 감지했을 때의 최소 점수
const CLS_LIGHT     = 9;
const CLS_PERSON    = 0;

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

/* ── 폴백 체인 추론 — canvas는 448×448 축소본, W/H는 원본 해상도 ── */
export async function runYolo(canvas, W, H) {
  // 1차: MediaPipe
  const mpDets    = await runMediaPipeDetect(canvas, W, H);
  const mpLights  = mpDets.filter(d => d.cls === CLS_LIGHT);
  const confident = mpLights.filter(d => d.score >= MP_THRESHOLD);

  // ★ 신뢰도 높은 신호등 감지 → 즉시 반환 (YOLO 생략)
  if (confident.length > 0) {
    return classifySignals(confident, mpDets);
  }

  // ★ MP가 신호등을 조금이라도 감지했으면 (0.25~0.50) → YOLO 생략하고 낮은 신뢰도로 반환
  //   신호등이 전혀 없는 장면에서 YOLO를 매번 돌리는 것을 방지
  if (mpLights.length > 0) {
    return classifySignals(mpLights, mpDets);
  }

  // ★ MP가 traffic light를 아예 못 찾았을 때만 YOLO 폴백
  //   단, person만 감지된 경우는 YOLO로 신호등을 재탐색
  const mpHasAny = mpDets.some(d => d.score >= MP_ANY_MIN);
  if (mpHasAny && mpLights.length === 0) {
    // MP가 다른 물체(사람 등)는 잘 보이는 상황 → 신호등이 진짜 없는 것
    // YOLO 생략으로 프레임 절약
    return [];
  }

  // 2차: YOLOv8s 폴백 (MP가 아무것도 못 잡은 경우 — 원거리·야간 등)
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
