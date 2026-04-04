import { ttsScanMsg } from './tts.js';

const PIP_SM = { w: 120, h: 80  };
const PIP_LG = { w: 200, h: 130 };

export const SCAN_MSGS = [
  '신호등을 탐색 중입니다...',
  '카메라를 신호등 방향으로 향해 주세요',
  '건너편 신호등을 찾고 있습니다...',
  '멀리 있는 신호등도 감지합니다',
];

let _nightMode    = false;
let _pipLarge     = false;
let _scanMsgIdx   = 0;
let _scanMsgTimer = null;
let _fpsValue     = 0;
let _fpsFrames    = 0;
let _fpsLast      = 0;
let _debugEnabled = false;

const pip       = document.getElementById('pip');
const scanBadge = document.getElementById('badge-scan');
const scanline  = document.getElementById('scanline');
const video     = document.getElementById('video');
const pipCtx    = pip.getContext('2d');

export const getNightMode = () => _nightMode;
export const getFpsValue  = () => _fpsValue;
export function setDebugEnabled(on) { _debugEnabled = on; }

/* ── 디버그 패널 ── */
export function showDebug(msg) {
  if (!_debugEnabled) return;
  let el = document.getElementById('debug-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'debug-overlay';
    Object.assign(el.style, {
      position:'fixed', top:'60px', left:'0', right:'0',
      background:'rgba(0,0,0,0.82)', color:'#0f0',
      fontSize:'11px', fontFamily:'monospace', padding:'8px',
      zIndex:'99999', whiteSpace:'pre-wrap', wordBreak:'break-all',
      maxHeight:'40vh', overflowY:'auto',
    });
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }
  el.textContent += msg + '\n';
}

/* ── Phase ── */
export function setPhase(p) {
  const show = (id, on, dtype='flex') => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? dtype : 'none';
  };
  show('init-screen',    p==='init',    'flex');
  show('loading-screen', p==='loading', 'flex');
  show('error-screen',   p==='error',   'flex');
  show('bottombar',      p==='live',    'block');
  show('btn-flip',       p==='live',    'flex');
  scanline.style.display = p==='live' ? 'block' : 'none';
  pip.style.display      = p==='live' ? 'block' : 'none';

  if (p === 'live') {
    scanBadge.style.display = '';
    scanBadge.textContent   = '탐색 중';
    scanBadge.classList.remove('detected');
    scanBadge.classList.add('scan-pulse');
    applyPipSize();
    startScanMsgCycle();
    _fpsFrames = 0;
    _fpsLast   = performance.now();
  } else {
    scanBadge.style.display = 'none';
    stopScanMsgCycle();
  }
}

/* ── Badge ── */
export function setBadge(text, cls) {
  const b = document.getElementById('badge-ai');
  b.textContent = text;
  b.className = `text-[11px] px-2 py-0.5 rounded-md bg-black/60 ${cls}`;
}

export function updateScanBadge(signals) {
  if (signals.length > 0) {
    scanBadge.textContent = `감지 ${signals.length}건`;
    scanBadge.classList.add('detected');
    scanBadge.classList.remove('scan-pulse');
  } else {
    scanBadge.textContent = `탐색 중 · ${_fpsValue}fps`;
    scanBadge.classList.remove('detected');
    scanBadge.classList.add('scan-pulse');
  }
}

/* ── fps ── */
export function tickFps() {
  _fpsFrames++;
  const now  = performance.now();
  const diff = now - _fpsLast;
  if (diff >= 1000) {
    _fpsValue  = Math.round(_fpsFrames * 1000 / diff);
    _fpsFrames = 0;
    _fpsLast   = now;
    if (!scanBadge.classList.contains('detected'))
      scanBadge.textContent = `탐색 중 · ${_fpsValue}fps`;
  }
}

/* ── 탐색 중 순환 ── */
export function startScanMsgCycle() {
  stopScanMsgCycle();
  _scanMsgIdx = 0;
  _renderScanMsg();
  _scanMsgTimer = setInterval(() => {
    if (document.getElementById('det-empty').style.display === 'none') return;
    _scanMsgIdx = (_scanMsgIdx + 1) % SCAN_MSGS.length;
    _renderScanMsg();
    ttsScanMsg(_scanMsgIdx);
  }, 3500);
}

export function stopScanMsgCycle() {
  clearInterval(_scanMsgTimer);
  _scanMsgTimer = null;
}

function _renderScanMsg() {
  const el = document.getElementById('det-empty');
  el.style.transition = 'opacity 0.4s';
  el.style.opacity    = '0';
  setTimeout(() => {
    el.querySelector('.scan-msg-text').textContent = SCAN_MSGS[_scanMsgIdx];
    el.style.opacity = '1';
  }, 400);
}

export function showDetEmpty() {
  const el = document.getElementById('det-empty');
  el.style.opacity    = '1';
  el.style.transition = '';
  el.style.display    = 'flex';
}

/* ── 야간 모드 ── */
export function applyNight(on) {
  _nightMode = on;
  video.className = `w-full h-full object-cover block ${on ? 'night' : 'day'}`;
  const btn = document.getElementById('btn-night');
  document.getElementById('night-label').textContent = on ? 'ON' : '야간';
  on ? btn.classList.add('on') : btn.classList.remove('on');
  btn.querySelector('.material-symbols-rounded').textContent =
    on ? 'light_mode' : 'dark_mode';
}

/* ── PiP ── */
export function applyPipSize() {
  const sz = _pipLarge ? PIP_LG : PIP_SM;
  pip.width  = sz.w;
  pip.height = sz.h;
}

export function togglePip() {
  _pipLarge = !_pipLarge;
  applyPipSize();
}

export function drawPip(proc, overlay) {
  if (!proc.width || !proc.height) return;
  const sz       = _pipLarge ? PIP_LG : PIP_SM;
  const detected = scanBadge.classList.contains('detected');
  pipCtx.drawImage(proc,    0, 0, sz.w, sz.h);
  pipCtx.drawImage(overlay, 0, 0, sz.w, sz.h);
  pipCtx.strokeStyle = detected ? '#00ee44' : '#3b82f6';
  pipCtx.lineWidth   = 1.5;
  pipCtx.strokeRect(0.75, 0.75, sz.w-1.5, sz.h-1.5);
  pipCtx.fillStyle = 'rgba(0,0,0,0.55)';
  pipCtx.fillRect(sz.w-34, sz.h-14, 34, 14);
  pipCtx.fillStyle = '#94a3b8';
  pipCtx.font      = 'bold 9px system-ui,sans-serif';
  pipCtx.fillText(`${_fpsValue}fps`, sz.w-30, sz.h-4);
  pipCtx.fillStyle = 'rgba(0,0,0,0.55)';
  pipCtx.fillRect(0, 0, 36, 14);
  pipCtx.fillStyle = detected ? '#4ade80' : '#93c5fd';
  pipCtx.fillText(detected ? '감지됨' : '탐색중', 3, 10);
}
