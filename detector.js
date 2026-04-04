/* ════════════════════════════════════
   detector.js — 서버 WebSocket 추론 모드
   detector.yolo.js 의존 없음 (TF.js 불필요)
════════════════════════════════════ */

const WS_URL     = 'wss://supply.klueware.com/ws';
const JPEG_Q     = 0.75;   // 전송 화질
const WS_TIMEOUT = 12000;  // 연결 대기 ms (모바일 네트워크 여유)

let _ws      = null;
let _ready   = false;
let _onDebug = null;
let _pending = null;   // { resolve, reject, timer }

function dbg(msg) { _onDebug && _onDebug(msg); }

/* ── WebSocket 연결 ── */
function connect(onBadge) {
  dbg('[ws] connecting...');
  _ws = new WebSocket(WS_URL);
  _ws.binaryType = 'arraybuffer';

  _ws.onopen = () => {
    _ready = true;
    dbg('[ws] connected');
    onBadge('서버', 'text-green-400');  // 짧게 — topbar 넘침 방지
  };

  _ws.onmessage = (e) => {
    if (!_pending) return;
    const { resolve, timer } = _pending;
    _pending = null;
    clearTimeout(timer);
    try {
      const { signals, error } = JSON.parse(e.data);
      if (error) dbg(`[ws] server error: ${error}`);
      resolve(signals || []);
    } catch (err) {
      resolve([]);
    }
  };

  _ws.onerror = (e) => {
    dbg('[ws] error');
    _ready = false;
    onBadge('WS오류', 'text-red-400');  // 짧게
    _rejectPending('ws error');
  };

  _ws.onclose = () => {
    _ready = false;
    dbg('[ws] closed — reconnect in 3s');
    onBadge('재연결', 'text-yellow-400');  // 짧게
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

  // 최대 WS_TIMEOUT ms 동안 연결 대기
  const t0 = Date.now();
  while (!_ready && Date.now() - t0 < WS_TIMEOUT) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!_ready) {
    onBadge('오프라인', 'text-red-400');
    dbg('[ws] connection timeout');
  }
}

export async function runYolo(canvas, W, H) {
  if (!_ready || !_ws || _ws.readyState !== WebSocket.OPEN) return [];
  if (_pending) return [];   // 이전 프레임 응답 대기 중

  // canvas → JPEG Blob → ArrayBuffer
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_Q));
  const buf  = await blob.arrayBuffer();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending = null;
      dbg('[ws] frame timeout');
      resolve([]);
    }, 5000);
    _pending = { resolve, reject, timer };
    _ws.send(buf);
  });
}
