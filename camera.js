/* ════════════════════════════════════
   camera.js — 카메라 · 스캔루프 · 야간 감지 · 색상 추정

   수정 이력:
    - [버그] estimateSignalColor 호출부 인자 불일치 수정
             (box 배열+W+H → x1,y1,x2,y2 좌표 직접 전달)
    - [버그] stale 신호가 updateFullscreen/renderCards 로 전달되어
             TTS 재발화·카운트 오동작하던 문제 수정
             (stale 신호는 drawBoxes 만 통과, fullscreen·TTS 스킵)
════════════════════════════════════ */

import { loadModel, runYolo }          from './detector.js';
import { drawBoxes, renderCards }      from './renderer.js';
import { cfg, readConfig }             from './settings.js';
import { setTtsEnabled, ttsPhase }     from './tts.js';
import { startRecording }              from './recorder.js';
import { setDebugEnabled, showDebug, setPhase,
         setBadge, updateScanBadge, tickFps,
         applyNight, drawPip, showDetEmpty }  from './ui.js';
import { updateFullscreen }            from './fullscreen.js';
import { setRecorderDebug }            from './recorder.js';

/* ── DOM (모듈 로드 시 한 번만 조회) ── */
const video    = document.getElementById('video');
const proc     = document.getElementById('proc');
const overlay  = document.getElementById('overlay');
const scanline = document.getElementById('scanline');

export const procCtx = proc.getContext('2d', { willReadFrequently: true });

/* ── 상태 ── */
let stream     = null;
let scanTimer  = null;
let nightTimer = null;
let roiCanvas  = null;
let _roiPhase  = 0;
let _prevSignals = [];

export let camFacing = 'environment';
export let phase     = 'init';
let lastVW = 0, lastVH = 0;

/* ── ROI 설정 상수 ── */
const ROI_JPEG_Q = [0.88, 0.75, 0.82];

/* ════════════════════════════════════
   카메라
════════════════════════════════════ */
export async function startCamera(facing) {
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
      t  => { document.getElementById('load-msg').textContent = t; showDebug('[model] ' + t); },
      (text, cls) => {
        setBadge(text, cls);
        if (text === '서버')          ttsPhase('connected');
        else if (text === '재연결')   ttsPhase('reconnecting');
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

        if (!roiCanvas) roiCanvas = document.createElement('canvas');
        roiCanvas.width  = W;
        roiCanvas.height = H;
        const rctx = roiCanvas.getContext('2d');

        const rp = _roiPhase % 3;
        _roiPhase++;

        let yOffset = 0;
        let yScale  = 1.0;

        switch (rp) {
          case 0:
            rctx.drawImage(proc, 0, 0, W, Math.round(H * 0.55), 0, 0, W, H);
            yScale  = 0.55;
            yOffset = 0;
            break;
          case 1:
            rctx.drawImage(proc, 0, 0, W, H, 0, 0, W, H);
            yScale  = 1.0;
            yOffset = 0;
            break;
          case 2:
            rctx.drawImage(
              proc,
              0, Math.round(H * 0.20), W, Math.round(H * 0.50),
              0, 0, W, H
            );
            yScale  = 0.50;
            yOffset = 0.20;
            break;
        }

        if (rp === 0) {
          _sharpen(rctx, W, H, 0.4);
        }

        let signals = [];
        try {
          const raw = await runYolo(roiCanvas, W, H, ROI_JPEG_Q[rp]);
          signals = raw.map(s => {
            const [y1, x1, y2, x2] = s.box;
            return {
              ...s,
              box: [
                y1 * yScale + yOffset,
                x1,
                y2 * yScale + yOffset,
                x2,
              ],
            };
          }).filter(s => (s.box[2] - s.box[0]) >= 0.02);
        } catch (e) {
          console.warn('scan error:', e);
          setBadge('스캔 오류', 'text-red-400');
        }

        /* ── [수정] flickering 방지: stale 마킹 분리 ── */
        // stale 신호는 drawBoxes 에만 쓰고 fullscreen·TTS 는 스킵
        const freshSignals = signals.filter(s => !s._stale);
        const displaySignals = signals.length === 0 && _prevSignals.length > 0
          ? _prevSignals.map(s => ({ ...s, _stale: true }))
          : signals;

        _prevSignals = freshSignals;

        tickFps();
        // 배지·카드 카운트는 fresh 기준
        updateScanBadge(freshSignals);
        drawBoxes(overlay.getContext('2d'), displaySignals, W, H);

        // [수정] fullscreen·TTS 는 stale 이 아닌 fresh 신호만 처리
        if (freshSignals.length > 0) {
          const top   = freshSignals[0];
          const [y1, x1, y2, x2] = top.box;
          const color = estimateSignalColor(x1, y1, x2, y2);
          updateFullscreen(top, color);
        }

        renderCards(freshSignals, sig => {
          const [y1, x1, y2, x2] = sig.box;
          const color = estimateSignalColor(x1, y1, x2, y2);
          updateFullscreen(sig, color);
        }, showDetEmpty);

        scanline.style.display = freshSignals.length ? 'none' : 'block';
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
        sum += data[i] * 0.3 + data[i+1] * 0.59 + data[i+2] * 0.11;
        cnt++;
      }
      if (cnt) applyNight(sum / cnt < 60);
    } catch { /* cross-origin guard */ }
  }, 3000);
}

/* ════════════════════════════════════
   신호등 색상 추정
   [수정] 시그니처: (x1, y1, x2, y2) — 호출부도 동일하게 수정
════════════════════════════════════ */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) {
    h = 0;
  } else {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, v];
}

export function estimateSignalColor(x1, y1, x2, y2) {
  const W = proc.width, H = proc.height;
  const bx = Math.max(0, Math.round(x1 * W));
  const by = Math.max(0, Math.round(y1 * H));
  const bw = Math.min(W - bx, Math.round((x2 - x1) * W));
  const bh = Math.min(H - by, Math.round((y2 - y1) * H));

  if (bw < 4 || bh < 4) return 'unknown';

  try {
    const imgData = procCtx.getImageData(bx, by, bw, bh);
    const px = imgData.data;

    let section = [
      { r: 0, g: 0, b: 0, cnt: 0 },
      { r: 0, g: 0, b: 0, cnt: 0 },
      { r: 0, g: 0, b: 0, cnt: 0 },
    ];

    for (let row = 0; row < bh; row++) {
      const idx = row > bh * 0.66 ? 2 : row > bh * 0.33 ? 1 : 0;
      for (let col = 0; col < bw; col++) {
        const i = (row * bw + col) * 4;
        section[idx].r += px[i];
        section[idx].g += px[i+1];
        section[idx].b += px[i+2];
        section[idx].cnt++;
      }
    }

    const results = section.map(s => {
      if (s.cnt === 0) return [0, 0, 0];
      return rgbToHsv(s.r / s.cnt, s.g / s.cnt, s.b / s.cnt);
    });

    const [h1, s1, v1] = results[0];
    const [h2, s2, v2] = results[1];
    const [h3, s3, v3] = results[2];

    const isRed1   = (h1 < 25 || h1 > 335) && s1 > 0.3 && v1 > 0.3;
    const isGreen2 = (h2 > 100 && h2 < 185) && s2 > 0.25 && v2 > 0.3;
    const isGreen3 = (h3 > 100 && h3 < 185) && s3 > 0.2  && v3 > 0.3;

    if (isGreen2 || isGreen3) return 'green';
    if (isRed1)               return 'red';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ════════════════════════════════════
   라플라시안 언샤프 마스크
════════════════════════════════════ */
function _sharpen(rctx, W, H, str) {
  const id  = rctx.getImageData(0, 0, W, H);
  const src = id.data;
  const out = new Uint8ClampedArray(src.length);
  const W4  = W * 4;
  for (let row = 1; row < H - 1; row++) {
    for (let col = 1; col < W - 1; col++) {
      const i = row * W4 + col * 4;
      for (let c = 0; c < 3; c++) {
        const lap = src[i+c]*5
          - src[i-4+c] - src[i+4+c]
          - src[i-W4+c] - src[i+W4+c];
        out[i+c] = Math.min(255, Math.max(0, src[i+c] + lap * str));
      }
      out[i+3] = 255;
    }
  }
  for (let i = 0; i < src.length; i += 4) {
    if (out[i+3] === 0) {
      out[i]=src[i]; out[i+1]=src[i+1]; out[i+2]=src[i+2]; out[i+3]=255;
    }
  }
  rctx.putImageData(new ImageData(out, W, H), 0, 0);
}
