/* ════════════════════════════════════
   app.js — 진입점 · 카메라 · 스캔루프 · 전체화면
════════════════════════════════════ */

import { loadModel, runYolo }                         from './detector.js';
import { drawBoxes, renderCards }                     from './renderer.js';
import { cfg, readConfig }                            from './settings.js';
import { setTtsEnabled, ttsPhase, ttsSignal }         from './tts.js';
import { startRecording, stopRecording,
         setRecorderDebug }                           from './recorder.js';
import { setDebugEnabled, showDebug, setPhase,
         setBadge, updateScanBadge, tickFps,
         applyNight, getNightMode,
         drawPip, togglePip,
         showDetEmpty, startScanMsgCycle }            from './ui.js';

/* ── DOM ── */
const video   = document.getElementById('video');
const proc    = document.getElementById('proc');
const overlay = document.getElementById('overlay');
const scanline = document.getElementById('scanline');

/* ── 상태 ── */
let stream    = null;
let scanTimer = null;
let nightTimer = null;
let camFacing = 'environment';
let phase     = 'init';
let lastVW    = 0, lastVH = 0;
let fsVisible = false;

const procCtx = proc.getContext('2d', { willReadFrequently: true });



function initSettings() {
  const settings = [
    { row: 'row-tts', input: 'cfg-tts', track: 'cfg-tts-track', thumb: 'cfg-tts-thumb' },
    { row: 'row-debug', input: 'cfg-debug', track: 'cfg-debug-track', thumb: 'cfg-debug-thumb' },
    { row: 'row-rec', input: 'cfg-rec', track: 'cfg-rec-track', thumb: 'cfg-rec-thumb' }
  ];

  settings.forEach(item => {
    const rowEl = document.getElementById(item.row);
    const inputEl = document.getElementById(item.input);
    const trackEl = document.getElementById(item.track);
    const thumbEl = document.getElementById(item.thumb);

    rowEl.addEventListener('click', () => {
      inputEl.checked = !inputEl.checked;

      // UI 업데이트 (클래스 토글 방식 권장)
      if (inputEl.checked) {
        trackEl.style.background = '#2563eb';
        thumbEl.style.transform = 'translateX(18px)';
      } else {
        trackEl.style.background = '#3a3a3a';
        thumbEl.style.transform = 'translateX(0)';
      }

      readConfig(); // 설정값 반영
    });
  });
}


/* ════════════════════════════════════
   카메라
════════════════════════════════════ */
async function startCamera(facing) {
  readConfig();
  setTtsEnabled(cfg.tts);
  setDebugEnabled(cfg.debug);
  setRecorderDebug(showDebug);

  if (facing) camFacing = facing;
  phase = 'loading';
  setPhase('loading');
  ttsPhase('camera-start');

  try {
    showDebug('[cam] startCamera');
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    showDebug('[cam] getUserMedia OK');
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    video.play();
    showDebug('[cam] video playing');

    ttsPhase('connecting');
    await loadModel(
      t => { document.getElementById('load-msg').textContent = t; showDebug('[model] ' + t); },
      (text, cls) => {
        setBadge(text, cls);
        // 서버 연결 상태 TTS
        if (text === '서버')        ttsPhase('connected');
        else if (text === '재연결') ttsPhase('reconnecting');
        else if (text === '오프라인') ttsPhase('offline');
      },
      showDebug
    );

    showDebug('[cam] model loaded → setPhase live');
    phase = 'live';
    setPhase('live');
    ttsPhase('live');
    startScan();
    startNightCheck();
    if (cfg.rec) startRecording(stream);
  } catch (e) {
    showDebug(`[cam] ERROR: ${e.name} ${e.message}`);
    phase = 'error';
    setPhase('error');
    if (e.name === 'NotAllowedError') {
      document.getElementById('err-msg').textContent =
        '카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.';
      ttsPhase('error-perm');
    } else {
      document.getElementById('err-msg').textContent =
        '카메라를 사용할 수 없습니다: ' + e.message;
      ttsPhase('error-cam');
    }
  }
}

/* ════════════════════════════════════
   스캔 루프
════════════════════════════════════ */
function startScan() {
  clearTimeout(scanTimer);

  async function loop() {
    if (phase !== 'live') return;

    if (video.readyState >= 2) {
      const W = video.videoWidth, H = video.videoHeight;
      if (W && H) {
        if (W !== lastVW || H !== lastVH) {
          proc.width = overlay.width = W;
          proc.height = overlay.height = H;
          lastVW = W; lastVH = H;
        }
        procCtx.drawImage(video, 0, 0, W, H);

        let signals = [];
        try {
          signals = await runYolo(proc, W, H);
        } catch (e) {
          console.warn('scan error:', e);
          setBadge('스캔 오류', 'text-red-400');
        }

        tickFps();
        updateScanBadge(signals);
        drawBoxes(overlay.getContext('2d'), signals, W, H);

        if (signals.length > 0 && !fsVisible) {
          const top   = signals[0];
          const color = estimateSignalColor(top.box, W, H);
          showFullscreen(top, color);
          ttsSignal(top, color);
        }

        renderCards(signals, sig => {
          const color = estimateSignalColor(sig.box, proc.width, proc.height);
          showFullscreen(sig, color);
          ttsSignal(sig, color);
        }, showDetEmpty);

        scanline.style.display = signals.length ? 'none' : 'block';
        drawPip(proc, overlay);
      }
    }

    scanTimer = setTimeout(loop, 120);
  }

  loop();
}

/* ════════════════════════════════════
   야간 자동 감지
════════════════════════════════════ */
function startNightCheck() {
  clearInterval(nightTimer);
  nightTimer = setInterval(() => {
    if (phase !== 'live' || !proc.width) return;
    try {
      const data = procCtx.getImageData(0, 0, proc.width, proc.height).data;
      let sum = 0, cnt = 0;
      for (let i = 0; i < data.length; i += 16) {
        sum += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
        cnt++;
      }
      if (cnt) applyNight(sum / cnt < 60);
    } catch { /* cross-origin guard */ }
  }, 3000);
}

/* ════════════════════════════════════
   신호등 색상 추정
════════════════════════════════════ */
function estimateSignalColor(box, W, H) {
  const [y1, x1, y2, x2] = box;
  const bx = Math.round(x1*W), by = Math.round(y1*H);
  const bw = Math.round((x2-x1)*W), bh = Math.round((y2-y1)*H);
  if (bw < 4 || bh < 4) return 'unknown';
  try {
    const px = procCtx.getImageData(bx, by, bw, bh).data;
    let r = 0, g = 0, cnt = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i+1]; cnt++; }
    if (!cnt) return 'unknown';
    r /= cnt; g /= cnt;
    if (r > 100 && r > g * 1.5) return 'red';
    if (g > 80  && g > r * 1.2) return 'green';
    return 'unknown';
  } catch { return 'unknown'; }
}

/* ════════════════════════════════════
   전체화면
════════════════════════════════════ */
const PERSON_SVG = {
  walk: `<ellipse cx="50" cy="28" rx="16" ry="18" fill="#003311"/>
    <ellipse cx="28" cy="62" rx="14" ry="20" fill="#003311"/>
    <ellipse cx="72" cy="62" rx="14" ry="20" fill="#003311"/>
    <rect x="36" y="55" width="28" height="28" rx="4" fill="#003311"/>
    <rect x="42" y="80" width="8" height="18" rx="3" fill="#003311"/>
    <rect x="50" y="80" width="8" height="18" rx="3" fill="#003311"/>`,
  stop: `<ellipse cx="50" cy="28" rx="16" ry="18" fill="#330000"/>
    <ellipse cx="28" cy="62" rx="14" ry="20" fill="#330000"/>
    <ellipse cx="72" cy="62" rx="14" ry="20" fill="#330000"/>
    <rect x="36" y="55" width="28" height="28" rx="4" fill="#330000"/>
    <rect x="42" y="80" width="8" height="18" rx="3" fill="#330000"/>
    <rect x="50" y="80" width="8" height="18" rx="3" fill="#330000"/>`,
};


function showFullscreen(sig, color) {
  if (fsVisible) return;

  const video    = document.getElementById('video');
  const fsCanvas = document.getElementById('fs-canvas');
  const fs       = document.getElementById('fs');

  /* ── 배경색 (신호 색상 기반) ── */
  const bg = color === 'green' ? '#001a08' : color === 'red' ? '#1a0000' : '#0a0a0a';
  fs.style.background = bg;
  fs.style.filter     = getNightMode() ? 'brightness(1.5) contrast(1.3) saturate(1.2)' : 'none';
  fs.style.display    = 'flex';
  fs.classList.add('show');
  fsVisible = true;

  /* ── 진동 ── */
  if (navigator.vibrate)
    navigator.vibrate(color === 'green' ? [200] : [100, 50, 100]);

  /* ── 캡처 없으면 종료 ── */
  if (!video || video.readyState < 2) {
    fsCanvas.style.display = 'none';
    return;
  }

  const [y1, x1, y2, x2] = sig.box;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  /* ── 1단계: 소스 크롭 영역 계산 (박스 중심 + 2.8배 패딩) ── */
  const boxW = (x2 - x1) * vw;
  const boxH = (y2 - y1) * vh;
  const cx   = (x1 + x2) / 2 * vw;
  const cy   = (y1 + y2) / 2 * vh;
  const pad  = 2.8;
  const rawW = Math.max(boxW * pad, 80);
  const rawH = Math.max(boxH * pad, 80);
  const sx   = Math.max(0, Math.round(cx - rawW / 2));
  const sy   = Math.max(0, Math.round(cy - rawH / 2));
  const sw   = Math.min(vw - sx, Math.round(rawW));
  const sh   = Math.min(vh - sy, Math.round(rawH));

  /* ── 2단계: 중간 캔버스에 2× 업스케일로 1차 드로우 ── */
  const SCALE = 4; // 초해상도 업스케일 배율
  const midW  = sw * SCALE;
  const midH  = sh * SCALE;
  const mid   = document.createElement('canvas');
  mid.width   = midW;
  mid.height  = midH;
  const mctx  = mid.getContext('2d');
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(video, sx, sy, sw, sh, 0, 0, midW, midH);

  /* ── 3단계: 언샤프 마스크 (샤프닝) ── */
  const imgData = mctx.getImageData(0, 0, midW, midH);
  const src     = imgData.data;
  const out     = new Uint8ClampedArray(src.length);
  const W4      = midW * 4;
  const strength = 0.55; // 샤프닝 강도 (0.3~0.8 권장)

  for (let y = 1; y < midH - 1; y++) {
    for (let x = 1; x < midW - 1; x++) {
      const i = y * W4 + x * 4;
      for (let c = 0; c < 3; c++) {
        // 라플라시안 커널 샤프닝
        const lap =
          src[i + c] * 5
          - src[i - 4 + c]          // left
          - src[i + 4 + c]          // right
          - src[i - W4 + c]         // top
          - src[i + W4 + c];        // bottom
        out[i + c] = Math.min(255, Math.max(0, src[i + c] + lap * strength));
      }
      out[i + 3] = 255;
    }
  }
  // 가장자리 픽셀은 원본 복사
  for (let i = 0; i < src.length; i += 4) {
    if (out[i + 3] === 0) { out[i]=src[i]; out[i+1]=src[i+1]; out[i+2]=src[i+2]; out[i+3]=255; }
  }
  mctx.putImageData(new ImageData(out, midW, midH), 0, 0);

  /* ── 4단계: 출력 캔버스 = 화면 전체 꽉 채우기 ── */
  const outW = window.innerWidth;
  const outH = window.innerHeight;
  fsCanvas.width  = outW;
  fsCanvas.height = outH;

  const fctx = fsCanvas.getContext('2d');
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';

  // 비율 유지하며 화면 꽉 채움 (contain)
  const scale  = Math.min(outW / midW, outH / midH);
  const dw     = Math.round(midW * scale);
  const dh     = Math.round(midH * scale);
  const dx     = Math.round((outW - dw) / 2);
  const dy     = Math.round((outH - dh) / 2);

  fctx.fillStyle = bg;
  fctx.fillRect(0, 0, outW, outH);
  fctx.drawImage(mid, 0, 0, midW, midH, dx, dy, dw, dh);

  /* ── 5단계: 감지 박스 테두리 ── */
  const accent   = color === 'green' ? '#00ee44' : color === 'red' ? '#ff3322' : '#ffcc00';
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

  /* ── 6단계: 신뢰도 텍스트 (우하단 작게) ── */
  const conf = `${Math.round(sig.score * 100)}%`;
  fctx.font      = 'bold 14px system-ui,sans-serif';
  fctx.fillStyle = 'rgba(0,0,0,0.55)';
  fctx.fillRect(outW - 60, outH - 28, 56, 22);
  fctx.fillStyle = accent;
  fctx.fillText(conf, outW - 52, outH - 12);

  fsCanvas.style.display = 'block';
}



/* ════════════════════════════════════
   이벤트
════════════════════════════════════ */
  initSettings();

// 버튼이 DOM에 존재하는지 확인 후 등록
const btnStart = document.getElementById('btn-start');
const btnRetry = document.getElementById('btn-retry');
if (btnStart) btnStart.addEventListener('click', () => startCamera());
else console.error('[app] btn-start 없음');
if (btnRetry) btnRetry.addEventListener('click', () => startCamera());
document.getElementById('btn-night').addEventListener('click', () => applyNight(!getNightMode()));
document.getElementById('btn-flip').addEventListener('click',  () =>
  startCamera(camFacing === 'environment' ? 'user' : 'environment'));
document.getElementById('fs').addEventListener('click', () => {
  document.getElementById('fs').classList.remove('show');
  fsVisible = false;
});
