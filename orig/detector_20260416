/* ════════════════════════════════════
   detector.js — 서버 WebSocket 추론 모드

   수정 이력:
    - [개선] pending 중 새 프레임이 들어오면 더 최신 프레임으로 교체
             (기존: 즉시 [] 반환으로 느린 네트워크에서 추론 중단)
             단, 이미 전송된 요청은 취소할 수 없으므로
             응답이 오면 최신 프레임 결과로 처리
════════════════════════════════════ */

const WS_URL     = 'wss://supply.klueware.com/ws';
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
 * 캔버스를 JPEG으로 압축 후 WebSocket 전송
 *
 * [개선] pending 중 새 프레임이 들어오면 이전 pending 을 cancelled 처리하고
 *        최신 프레임을 재전송 — 느린 네트워크에서도 최신 결과를 반환
 */
export async function runYolo(canvas, W, H, quality = JPEG_Q) {
  if (!_ready || !_ws || _ws.readyState !== WebSocket.OPEN) return [];

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  const buf  = await blob.arrayBuffer();

  // [수정] 기존 pending 이 있으면 cancelled 마킹 후 새 요청으로 교체
  if (_pending) {
    _pending.cancelled = true;
    clearTimeout(_pending.timer);
    _pending = null;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending = null;
      dbg('[ws] frame timeout');
      resolve([]);
    }, 5000);
    _pending = { resolve, reject, timer, cancelled: false };
    _ws.send(buf);
  });
}
