/* ════════════════════════════════════
   fullscreen.js — 전체화면 초해상도 렌더
════════════════════════════════════ */

import { ttsSignal }  from './tts.js';
import { getNightMode } from './ui.js';

let _fsVisible   = false;
let _lastColor   = null;

export const isFsVisible  = () => _fsVisible;

/* ── 외부에서 fsVisible 리셋 (닫기 이벤트) ── */
export function closeFullscreen() {
  document.getElementById('fs').classList.remove('show');
  _fsVisible  = false;
  _lastColor  = null;
}

/* ── 갱신 래퍼: 열려 있으면 재렌더, 닫혀 있으면 열기 ── */
export function updateFullscreen(sig, color) {
  const colorChanged = color !== _lastColor;
  if (!_fsVisible) {
    _lastColor = color;
    _openFs(sig, color);
    ttsSignal(sig, color);
    return;
  }
  // 열린 상태 → 이미지만 갱신
  _renderCanvas(sig, color);
  if (colorChanged) {
    _lastColor = color;
    ttsSignal(sig, color);
    if (navigator.vibrate)
      navigator.vibrate(color === 'green' ? [200] : [100, 50, 100]);
  }
}

/* ── 전체화면 열기 ── */
function _openFs(sig, color) {
  const fs = document.getElementById('fs');
  const bg = _bg(color);
  fs.style.background = bg;
  fs.style.filter     = getNightMode()
    ? 'brightness(1.5) contrast(1.3) saturate(1.2)' : 'none';
  fs.style.display    = 'flex';
  fs.classList.add('show');
  _fsVisible = true;
  if (navigator.vibrate)
    navigator.vibrate(color === 'green' ? [200] : [100, 50, 100]);
  _renderCanvas(sig, color);
}

/* ── 캔버스 렌더 (초해상도 파이프라인) ── */
function _renderCanvas(sig, color) {
  const video    = document.getElementById('video');
  const fsCanvas = document.getElementById('fs-canvas');
  if (!video || video.readyState < 2) { fsCanvas.style.display = 'none'; return; }

  const bg = _bg(color);
  const [y1, x1, y2, x2] = sig.box;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  /* 1. 크롭 영역 (박스 중심 + 2.8배 패딩) */
  const boxW = (x2 - x1) * vw;
  const boxH = (y2 - y1) * vh;
  const cx   = (x1 + x2) / 2 * vw;
  const cy   = (y1 + y2) / 2 * vh;
  const rawW = Math.max(boxW * 2.8, 80);
  const rawH = Math.max(boxH * 2.8, 80);
  const sx   = Math.max(0, Math.round(cx - rawW / 2));
  const sy   = Math.max(0, Math.round(cy - rawH / 2));
  const sw   = Math.min(vw - sx, Math.round(rawW));
  const sh   = Math.min(vh - sy, Math.round(rawH));

  /* 2. 4× 업스케일 */
  const SCALE = 4;
  const midW  = sw * SCALE;
  const midH  = sh * SCALE;
  const mid   = document.createElement('canvas');
  mid.width   = midW;
  mid.height  = midH;
  const mctx  = mid.getContext('2d');
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(video, sx, sy, sw, sh, 0, 0, midW, midH);

  /* 3. 라플라시안 언샤프 마스크 (strength=0.55) */
  const imgData  = mctx.getImageData(0, 0, midW, midH);
  const src      = imgData.data;
  const out      = new Uint8ClampedArray(src.length);
  const W4       = midW * 4;
  const strength = 0.55;
  for (let row = 1; row < midH - 1; row++) {
    for (let col = 1; col < midW - 1; col++) {
      const i = row * W4 + col * 4;
      for (let c = 0; c < 3; c++) {
        const lap = src[i+c]*5 - src[i-4+c] - src[i+4+c] - src[i-W4+c] - src[i+W4+c];
        out[i+c]  = Math.min(255, Math.max(0, src[i+c] + lap * strength));
      }
      out[i+3] = 255;
    }
  }
  for (let i = 0; i < src.length; i += 4) {
    if (out[i+3] === 0) { out[i]=src[i]; out[i+1]=src[i+1]; out[i+2]=src[i+2]; out[i+3]=255; }
  }
  mctx.putImageData(new ImageData(out, midW, midH), 0, 0);

  /* 4. 화면 전체 contain 렌더 */
  const outW = window.innerWidth;
  const outH = window.innerHeight;
  fsCanvas.width  = outW;
  fsCanvas.height = outH;
  const fctx  = fsCanvas.getContext('2d');
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  const scale = Math.min(outW / midW, outH / midH);
  const dw    = Math.round(midW * scale);
  const dh    = Math.round(midH * scale);
  const dx    = Math.round((outW - dw) / 2);
  const dy    = Math.round((outH - dh) / 2);
  fctx.fillStyle = bg;
  fctx.fillRect(0, 0, outW, outH);
  fctx.drawImage(mid, 0, 0, midW, midH, dx, dy, dw, dh);

  /* 5. 감지 박스 테두리 */
  const accent = _accent(color);
  const bx = dx + (x1 * vw - sx) / sw * dw;
  const by = dy + (y1 * vh - sy) / sh * dh;
  const bw = (x2 - x1) * vw / sw * dw;
  const bh = (y2 - y1) * vh / sh * dh;
  fctx.strokeStyle = accent;
  fctx.lineWidth   = 3;
  fctx.shadowColor = accent;
  fctx.shadowBlur  = 10;
  fctx.strokeRect(bx, by, bw, bh);
  fctx.shadowBlur  = 0;

  /* 6. 신뢰도 텍스트 (우하단) */
  const conf = `${Math.round(sig.score * 100)}%`;
  fctx.font      = 'bold 14px system-ui,sans-serif';
  fctx.fillStyle = 'rgba(0,0,0,0.55)';
  fctx.fillRect(outW - 60, outH - 28, 56, 22);
  fctx.fillStyle = accent;
  fctx.fillText(conf, outW - 52, outH - 12);

  fsCanvas.style.display = 'block';
}

/* ── 헬퍼 ── */
const _bg     = c => c === 'green' ? '#001a08' : c === 'red' ? '#1a0000' : '#0a0a0a';
const _accent = c => c === 'green' ? '#00ee44' : c === 'red' ? '#ff3322' : '#ffcc00';
