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

  // 1. 필요한 DOM 요소 참조
  const video = document.getElementById('video');
  const fsCanvas = document.getElementById('fs-canvas');
  const fctx = fsCanvas.getContext('2d');
  const fs = document.getElementById('fs');

  // 2. 캔버스에 이미지 그리기 — 박스 주변부 포함하여 크게
  if (video && video.readyState >= 2) {
    const [y1, x1, y2, x2] = sig.box;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // 박스 중심 및 크기
    const boxW = (x2 - x1) * vw;
    const boxH = (y2 - y1) * vh;
    const cx   = (x1 + x2) / 2 * vw;
    const cy   = (y1 + y2) / 2 * vh;

    // 주변부 포함: 박스의 2.5배 영역 (최소 120px)
    const cropW = Math.max(boxW * 2.5, 120);
    const cropH = Math.max(boxH * 2.5, 120);

    // 화면 경계 클램프
    const sx = Math.max(0, Math.round(cx - cropW / 2));
    const sy = Math.max(0, Math.round(cy - cropH / 2));
    const sw = Math.min(vw - sx, Math.round(cropW));
    const sh = Math.min(vh - sy, Math.round(cropH));

    // 출력 캔버스 크기: 화면 88% 너비, 최대 46vh
    const maxOutW = Math.round(window.innerWidth * 0.88);
    const maxOutH = Math.round(window.innerHeight * 0.46);
    const scale   = Math.min(maxOutW / sw, maxOutH / sh);
    fsCanvas.width  = Math.round(sw * scale);
    fsCanvas.height = Math.round(sh * scale);

    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(video, sx, sy, sw, sh, 0, 0, fsCanvas.width, fsCanvas.height);

    // 감지 박스 테두리 강조 표시 (accent 색상은 아래서 결정되므로 임시 흰색)
    const bx = (x1 * vw - sx) * scale;
    const by = (y1 * vh - sy) * scale;
    const bw = boxW * scale;
    const bh = boxH * scale;
    fctx.strokeStyle = 'rgba(255,255,255,0.8)';
    fctx.lineWidth   = 3;
    fctx.strokeRect(bx, by, bw, bh);

    fsCanvas.style.display = 'block';
  } else {
    fsCanvas.style.display = 'none';
  }

  // 3. UI 스타일 및 테마 설정
  let accent, bg, svgKey, label;
  if (sig.isPedestrian) {
    const isWalk = color === 'green';
    accent = isWalk ? '#00ee44' : '#ff3322';
    bg     = isWalk ? '#001a08' : '#1a0000';
    svgKey = isWalk ? 'walk'    : 'stop';
    label  = '보행신호';
  } else {
    accent = color === 'green' ? '#00ee44' : color === 'red' ? '#ff3322' : '#ffcc00';
    bg     = color === 'green' ? '#001a08' : color === 'red' ? '#1a0000' : '#1a1500';
    svgKey = color === 'red'    ? 'stop'    : 'walk';
    label  = '신호등';
  }

  const colorTag = color === 'green' ? '녹색' : color === 'red' ? '적색' : '색상미확인';
  const range    = sig.range === 'near' ? '근거리' : '원거리';
  const nightMode = typeof getNightMode === 'function' ? getNightMode() : false;

  // 4. 전체화면 표시 적용
  fs.style.background = bg;
  fs.style.filter     = nightMode ? 'brightness(1.6) contrast(1.4) saturate(1.3)' : 'none';
  fs.style.display    = 'flex'; // block 대신 flex로 중앙 정렬
  fs.classList.add('show');
  fsVisible = true;

  // 5. 아이콘 및 텍스트 업데이트
  const sz = 'min(44vw, 44vh)';
  const fsCircle = document.getElementById('fs-circle');
  if (fsCircle) {
      Object.assign(fsCircle.style, {
        width: sz, height: sz, background: accent, marginBottom: '2vh',
        boxShadow: `0 0 40px 14px ${accent}88, 0 0 80px 28px ${accent}44`,
      });
  }

  const fsSvg = document.getElementById('fs-svg');
  if (fsSvg) {
      fsSvg.innerHTML = PERSON_SVG[svgKey];
      fsSvg.style.cssText = 'width:55%;height:55%';
  }

  const fsLabel = document.getElementById('fs-label');
  if (fsLabel) {
      Object.assign(fsLabel.style, {
        fontSize: 'min(12vw,12vh)', color: accent, marginTop: '2vh',
        textShadow: `0 0 30px ${accent}`, letterSpacing: '-.02em',
      });
      fsLabel.textContent = label;
  }

  const fsSub = document.getElementById('fs-sub');
  if (fsSub) {
      Object.assign(fsSub.style, { marginTop: '2vh', fontSize: 'min(4vw,4vh)' });
      fsSub.textContent = `${range} · ${colorTag} · 신뢰도 ${Math.round(sig.score * 100)}% · 탭하면 돌아갑니다`;
  }

  // 6. 진동 피드백
  if (navigator.vibrate)
    navigator.vibrate(color === 'green' ? [200] : [100, 50, 100]);
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
