/* ════════════════════════════════════
   tts.js — TTS 음성 안내 전담
   진행과정 안내 + 신호 감지 안내
════════════════════════════════════ */

let _enabled   = true;
let _cooldown  = false;
let _cdTimer   = null;

/* ── 설정 ── */
export function setTtsEnabled(on) { _enabled = on; }

/* ── 내부 발화 ── */
function _speak(text, cooldownMs = 0) {
  if (!_enabled) return;
  if (!window.speechSynthesis) return;
  if (_cooldown) return;

  speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.lang   = 'ko-KR';
  utt.rate   = 1.05;
  utt.volume = 1.0;
  speechSynthesis.speak(utt);

  if (cooldownMs > 0) {
    _cooldown = true;
    clearTimeout(_cdTimer);
    _cdTimer = setTimeout(() => { _cooldown = false; }, cooldownMs);
  }
}

/* ════════════════════════════════════
   진행 과정 안내 (쿨다운 없음 — 시스템 이벤트)
════════════════════════════════════ */
export function ttsPhase(phase) {
  switch (phase) {
    case 'camera-start':  _speak('카메라를 시작합니다');          break;
    case 'connecting':    _speak('서버에 연결하는 중입니다');       break;
    case 'connected':     _speak('서버 연결 완료. 탐색을 시작합니다'); break;
    case 'offline':       _speak('서버에 연결할 수 없습니다. 재연결을 시도합니다'); break;
    case 'reconnecting':  _speak('서버 재연결 중입니다');           break;
    case 'live':          _speak('신호등을 탐색 중입니다');         break;
    case 'error-perm':    _speak('카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요'); break;
    case 'error-cam':     _speak('카메라를 사용할 수 없습니다');     break;
  }
}

/* ════════════════════════════════════
   탐색 중 순환 텍스트 동기화
════════════════════════════════════ */
const SCAN_TTS = [
  '신호등을 탐색 중입니다',
  '카메라를 신호등 방향으로 향해 주세요',
  '건너편 신호등을 찾고 있습니다',
  '멀리 있는 신호등도 감지합니다',
];

export function ttsScanMsg(idx) {
  // 탐색 중 순환: 쿨다운 없이 텍스트 변경과 동기화
  _speak(SCAN_TTS[idx] ?? SCAN_TTS[0]);
}

/* ════════════════════════════════════
   신호 감지 안내 (4초 쿨다운)
════════════════════════════════════ */
export function ttsSignal(sig, color) {
  let text;
  if (sig.isPedestrian) {
    text = color === 'green'
      ? '보행 신호입니다. 건너도 됩니다.'
      : '정지 신호입니다. 기다려 주세요.';
  } else {
    text = color === 'green' ? '녹색 신호등 감지'
         : color === 'red'   ? '적색 신호등 감지'
         : '신호등 감지됨';
  }
  _speak(text, 4000);
}
