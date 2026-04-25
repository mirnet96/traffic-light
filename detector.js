/* ════════════════════════════════════
   detector.js — 서버 WebSocket 추론 모드

   수정 이력:
    - [개선] pending 중 새 프레임이 들어오면 더 최신 프레임으로 교체
             (기존: 즉시 [] 반환으로 느린 네트워크에서 추론 중단)
             단, 이미 전송된 요청은 취소할 수 없으므로
             응답이 오면 최신 프레임 결과로 처리
    - [변경] 추론 모델 YOLOv8s → YOLOv11s
    - [변경] 서버 입력 해상도 1280×1280 대응
    - [추가] SAHI 타일 슬라이싱 지원
             runYoloSahi(tiles[]) — 타일 배열을 순차 전송 후 결과 반환
════════════════════════════════════ */

const WS_URL     = 'wss://supply.klueware.com/yolo/ws';
const JPEG_Q     = 0.75;
const WS_TIMEOUT = 12000;

let _ws      = null;
let _ready   = false;
let _onDebug = null;
let _pending = null;   // { resolve, reject, timer, cancelled }

function dbg(msg) { _onDebug && _onDebug(msg); }

/* ── WebSocket 연결 ── */
function connect(onBadge) {
  dbg('[ws] connecting...');
  _ws = new WebSocket(WS_URL);
  _ws.binaryType = 'arraybuffer';

  _ws.onopen = () => {
    _ready = true;
    dbg('[ws] connected');
    onBadge('서버', 'text-green-400');
  };

  _ws.onmessage = (e) => {
    if (!_pending) return;
    const { resolve, timer, cancelled } = _pending;
    _pending = null;
    clearTimeout(timer);
    if (cancelled) return;   // 교체된 pending — 결과 버림
    try {
      const { signals, error } = JSON.parse(e.data);
      if (error) dbg(`[ws] server error: ${error}`);
      resolve(signals || []);
    } catch {
      resolve([]);
    }
  };

  _ws.onerror = () => {
    dbg('[ws] error');
    _ready = false;
    onBadge('WS오류', 'text-red-400');
    _rejectPending('ws error');
  };

  _ws.onclose = () => {
    _ready = false;
    dbg('[ws] closed — reconnect in 3s');
    onBadge('재연결', 'text-yellow-400');
    _rejectPending('ws closed');
    setTimeout(() => connect(onBadge), 3000);
  };
}

function _rejectPending(reason) {
  if (!_pending) return;
  const { reject, timer } = _pending;
  _pending = null;
  clearTimeout(timer);
  reject(new Error(reason));
}

/* ── 단일 프레임 전송 (내부용) ── */
function _sendFrame(buf) {
  return new Promise((resolve, reject) => {
    if (_pending) {
      _pending.cancelled = true;
      clearTimeout(_pending.timer);
      _pending.resolve([]);
      _pending = null;
    }

    const timer = setTimeout(() => {
      if (_pending && _pending.timer === timer) {
        _pending = null;
        dbg('[ws] frame timeout');
        resolve([]);
      }
    }, 5000);

    _pending = { resolve, reject, timer, cancelled: false };

    try {
      _ws.send(buf);
    } catch (err) {
      dbg(`[ws] send error: ${err.message}`);
      clearTimeout(timer);
      _pending = null;
      resolve([]);
    }
  });
}

/* ── 공개 API ── */
export async function loadModel(onMsg, onBadge, onDebug) {
  _onDebug = onDebug;
  onMsg('서버 연결 중...');
  onBadge('연결 중', 'text-yellow-400');
  dbg(`[ws] target: ${WS_URL}`);
  connect(onBadge);

  const t0 = Date.now();
  while (!_ready && Date.now() - t0 < WS_TIMEOUT) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!_ready) {
    onBadge('오프라인', 'text-red-400');
    dbg('[ws] connection timeout');
  }
}

/**
 * 단일 캔버스 추론 (기존 인터페이스 유지)
 * YOLOv11s, 입력 해상도 1280 대응
 */
export async function runYolo(canvas, W, H, quality = JPEG_Q) {
  if (!_ready || !_ws || _ws.readyState !== WebSocket.OPEN) return [];

  if (_ws.bufferedAmount > 2 * 1024 * 1024) {
    dbg('[ws] skip frame: network buffer full');
    return [];
  }

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) return [];
  const buf = await blob.arrayBuffer();

  return _sendFrame(buf);
}

/**
 * SAHI 타일 슬라이싱 추론
 * tiles: [{ canvas, offsetX, offsetY, scaleX, scaleY, quality }]
 *
 * [개선] JPEG 인코딩을 Promise.all 로 병렬화 → 1fps 문제 해결
 *   JPEG blob 생성(20~40ms × 4타일)을 병렬로 처리하고
 *   전송·응답은 단일 WS pending 제약으로 순차 유지
 *
 * 호출자(camera.js)에서 NMS 수행
 */
export async function runYoloSahi(tiles) {
  if (!_ready || !_ws || _ws.readyState !== WebSocket.OPEN) return [];
  if (_ws.bufferedAmount > 2 * 1024 * 1024) {
    dbg('[ws] skip SAHI: network buffer full');
    return [];
  }

  /* 1단계: JPEG 인코딩 병렬 처리 */
  const buffers = await Promise.all(
    tiles.map(async ({ canvas, quality = JPEG_Q }) => {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
      return blob ? blob.arrayBuffer() : null;
    })
  );

  const allSignals = [];

  /* 2단계: 전송·응답 순차 처리 (단일 WS pending 제약) */
  for (let i = 0; i < tiles.length; i++) {
    const buf = await buffers[i];
    if (!buf) continue;
    const { offsetX, offsetY, scaleX, scaleY } = tiles[i];
    const sigs = await _sendFrame(buf);

    for (const s of sigs) {
      const [y1, x1, y2, x2] = s.box;
      allSignals.push({
        ...s,
        box: [
          y1 * scaleY + offsetY,
          x1 * scaleX + offsetX,
          y2 * scaleY + offsetY,
          x2 * scaleX + offsetX,
        ],
      });
    }
  }

  return allSignals;
}
