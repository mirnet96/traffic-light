/* ════════════════════════════════════
   color-classifier.js
   MobileNet V3 Small 기반 신호등 색상 분류기

   역할:
     estimateSignalColor (HSV 픽셀 샘플링) 의 보조 또는 대체 수단.
     박스 크롭 이미지를 96×96 으로 리사이즈 후
     MobileNet V3 Small 특징 벡터 → 경량 선형 헤드 → {red, green, unknown}

   사용 방법:
     import { loadColorClassifier, classifySignalColor } from './color-classifier.js';

     // 앱 시작 시 1회 로드 (실패 시 기존 HSV fallback 자동 사용)
     await loadColorClassifier(showDebug);

     // 스캔 루프 내 색상 추정
     const color = await classifySignalColor(proc, x1, y1, x2, y2)
                   ?? estimateSignalColor(x1, y1, x2, y2);  // fallback

   모델 선택 근거 (MobileNet V3 Small):
     - 입력 224×224 → 여기서는 96×96 으로 다운샘플 (모바일 속도 우선)
     - TF.js WebGL 백엔드 기준 단일 추론 ~8~15ms (iPhone 12 기준)
     - 파라미터 수 2.5M — 신호등 색상 3-class 분류에는 충분히 과잉이지만
       별도 fine-tuning 없이 feature extractor 로 사용 가능
     - YOLOv8s(전용 서버) + MobileNet V3(온디바이스) 이중 파이프라인:
       YOLO 는 위치만, MobileNet 은 색상만 담당 → 역할 분리
     - 한계: 박스가 8px 미만이거나 역광 심한 야간에는 HSV 가 더 안정적.
             따라서 _boxPixelSize < 8 이면 HSV fallback.

   fine-tuning 권장 절차:
     1. 실제 신호등 크롭 이미지 수집 (red/green/unknown 각 500장 이상)
     2. tfjs-node 로 MobileNet V3 feature extractor 위에 Dense(3) 헤드 학습
     3. model.save('indexeddb://traffic-color') 또는 /models/color/ 에 배포
     4. MODEL_URL 을 배포 경로로 변경

   CDN 의존:
     @tensorflow/tfjs — index.html 에서 먼저 로드되어 있어야 함
     (CLAUDE.md CDN 허용 목록: cdn.jsdelivr.net)
════════════════════════════════════ */

/* ── 상수 ── */
const MODEL_URL   = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js';
const INPUT_SIZE  = 96;    // 추론 입력 크기 (원본 224에서 축소 — 모바일 속도 우선)
const MIN_BOX_PX  = 8;     // 이보다 작으면 HSV fallback
const SCORE_THR   = 0.55;  // 분류 신뢰도 임계값 — 미달 시 HSV fallback

/* ── 상태 ── */
let _model      = null;    // tf.GraphModel 또는 mobilenet.MobileNet
let _ready      = false;
let _inferBuf   = null;    // 재사용 캔버스
let _onDebug    = null;

function _dbg(msg) { _onDebug && _onDebug(msg); }

/* ════════════════════════════════════
   로드

   전략:
     1차: /models/color/model.json (fine-tuned 헤드 포함 로컬 모델)
     2차: IndexedDB 캐시 (이전 세션에 저장된 경우)
     3차: MobileNet V3 feature extractor (CDN) + 인메모리 경량 헤드
          → 실제 fine-tuning 없이는 색상 분류 불가이므로
            이 경우 _ready=false 로 두고 HSV fallback 유지.

   운영 환경에서는 1차 로컬 모델 배포가 강력히 권장됨.
════════════════════════════════════ */
export async function loadColorClassifier(onDebug) {
  _onDebug = onDebug ?? null;

  if (!window.tf) {
    _dbg('[color-clf] TF.js 없음 — HSV fallback 사용');
    return false;
  }

  /* 재사용 추론 캔버스 */
  _inferBuf        = document.createElement('canvas');
  _inferBuf.width  = INPUT_SIZE;
  _inferBuf.height = INPUT_SIZE;

  /* 1차: 로컬 fine-tuned 모델 */
  try {
    _model = await tf.loadGraphModel('/models/color/model.json');
    await _warmup();
    _ready = true;
    _dbg('[color-clf] 로컬 모델 로드 완료');
    return true;
  } catch {
    _dbg('[color-clf] 로컬 모델 없음 — IndexedDB 확인');
  }

  /* 2차: IndexedDB 캐시 */
  try {
    _model = await tf.loadGraphModel('indexeddb://traffic-color');
    await _warmup();
    _ready = true;
    _dbg('[color-clf] IndexedDB 캐시 로드 완료');
    return true;
  } catch {
    _dbg('[color-clf] IndexedDB 없음 — HSV fallback 유지');
  }

  /* fine-tuned 모델 없음: 기능 비활성화 */
  _dbg('[color-clf] 사용 가능한 모델 없음. HSV fallback 사용.');
  _dbg('[color-clf] fine-tuning 후 /models/color/ 에 배포하면 자동 활성화');
  return false;
}

async function _warmup() {
  const dummy = tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3]);
  const out   = await _model.executeAsync(dummy);
  tf.dispose(dummy);
  Array.isArray(out) ? tf.dispose(out) : tf.dispose(out);
}

/* ════════════════════════════════════
   추론
   반환: 'red' | 'green' | 'unknown' | null (null = HSV fallback 권장)
════════════════════════════════════ */
export async function classifySignalColor(procCanvas, x1, y1, x2, y2) {
  if (!_ready || !_model || !window.tf) return null;

  const W = procCanvas.width, H = procCanvas.height;
  const bx = Math.max(0, Math.round(x1 * W));
  const by = Math.max(0, Math.round(y1 * H));
  const bw = Math.min(W - bx, Math.round((x2 - x1) * W));
  const bh = Math.min(H - by, Math.round((y2 - y1) * H));

  if (bw < MIN_BOX_PX || bh < MIN_BOX_PX) return null;  // HSV fallback

  /* 박스 크롭 → INPUT_SIZE 리사이즈 */
  const ctx = _inferBuf.getContext('2d');
  ctx.drawImage(procCanvas, bx, by, bw, bh, 0, 0, INPUT_SIZE, INPUT_SIZE);

  let result = null;
  try {
    const tensor = tf.tidy(() =>
      tf.expandDims(
        tf.div(tf.cast(tf.browser.fromPixels(_inferBuf), 'float32'), 127.5).sub(1.0),
        0
      )
    );  // [-1, 1] 정규화 (MobileNet V3 표준)

    const out     = await _model.executeAsync(tensor);
    const logits  = Array.isArray(out) ? out[0] : out;
    const scores  = await tf.softmax(logits).data();

    tf.dispose(tensor);
    Array.isArray(out) ? tf.dispose(out) : tf.dispose(out);

    /* scores: [red, green, unknown] — fine-tuned 헤드 출력 순서 */
    const labels  = ['red', 'green', 'unknown'];
    const maxIdx  = scores.indexOf(Math.max(...scores));
    const maxScore = scores[maxIdx];

    _dbg(`[color-clf] red=${scores[0].toFixed(2)} green=${scores[1].toFixed(2)} unk=${scores[2].toFixed(2)}`);

    result = maxScore >= SCORE_THR ? labels[maxIdx] : null;
  } catch (e) {
    _dbg(`[color-clf] 추론 오류: ${e.message}`);
    result = null;
  }

  return result;   // null 이면 호출자가 HSV fallback 사용
}

/* ════════════════════════════════════
   fine-tuning 데이터 수집 헬퍼 (개발 전용)

   사용법:
     import { collectSample } from './color-classifier.js';
     // 스캔 루프에서 정답을 알 때 (디버그 모드):
     collectSample(proc, x1, y1, x2, y2, 'red');   // 'red'|'green'|'unknown'

   수집된 샘플은 localStorage 없이 메모리에만 유지됨.
   필요 시 exportSamples() 로 JSON 다운로드.
════════════════════════════════════ */
const _samples = [];   // { dataUrl, label }[]

export function collectSample(procCanvas, x1, y1, x2, y2, label) {
  const W = procCanvas.width, H = procCanvas.height;
  const bx = Math.max(0, Math.round(x1 * W));
  const by = Math.max(0, Math.round(y1 * H));
  const bw = Math.min(W - bx, Math.round((x2 - x1) * W));
  const bh = Math.min(H - by, Math.round((y2 - y1) * H));
  if (bw < MIN_BOX_PX || bh < MIN_BOX_PX) return;

  const tmp = document.createElement('canvas');
  tmp.width  = INPUT_SIZE;
  tmp.height = INPUT_SIZE;
  tmp.getContext('2d').drawImage(procCanvas, bx, by, bw, bh, 0, 0, INPUT_SIZE, INPUT_SIZE);
  _samples.push({ dataUrl: tmp.toDataURL('image/jpeg', 0.85), label });
}

export function exportSamples() {
  if (!_samples.length) return;
  const blob = new Blob([JSON.stringify(_samples)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `color_samples_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
