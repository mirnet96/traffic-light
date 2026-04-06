/* ════════════════════════════════════
   camera.js — 카메라 · 스캔루프 · 야간 감지 · 색상 추정
   [개선] ROI 3종 순환 · 원거리 언샤프 마스크 · JPEG 품질 주입
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
let roiCanvas  = null;   // ROI 전처리 캔버스 (재사용)
let _roiPhase  = 0;      // ROI 순환 인덱스 (0·1·2)
let _prevSignals = [];   // 직전 감지 결과 (flickering 방지)

export let camFacing = 'environment';
export let phase     = 'init';
let lastVW = 0, lastVH = 0;

/* ── ROI 설정 상수 ── */
// [phase 0] 상단 55% → 전체 크기로 확대 (원거리 집중)
// [phase 1] 전체 프레임 그대로 전송 (근거리 + 하단 포함)
// [phase 2] 수직 20%~70% 스트립 → 확대 (중간 거리 집중)
const ROI_JPEG_Q = [0.88, 0.75, 0.82];  // phase별 JPEG 품질

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
        '카메라 권한이 거부되었습ë다. 브라우저 설정에서 허용해 주세요.';
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

        /* ── ROI 캔버스 준비 ── */
        if (!roiCanvas) roiCanvas = document.createElement('canvas');
        roiCanvas.width  = W;
        roiCanvas.height = H;
        const rctx = roiCanvas.getContext('2d');

        /* ── ROI 3종 순환 ── */
        const rp = _roiPhase % 3;
        _roiPhase++;

        let yOffset = 0;   // 역변환 y 오프셋 (정규화)
        let yScale  = 1.0; // 역변환 y 스케일

        switch (rp) {
          case 0:
            // 상단 55% → 전체 크기 확대 (원거리 신호등 집중)
            rctx.drawImage(proc, 0, 0, W, Math.round(H * 0.55), 0, 0, W, H);
            yScale  = 0.55;
            yOffset = 0;
            break;
          case 1:
            // 전체 프레임 그대로 (근거리 + 다양한 위치 포함)
            rctx.drawImage(proc, 0, 0, W, H, 0, 0, W, H);
            yScale  = 1.0;
            yOffset = 0;
            break;
          case 2:
            // 수직 20%~70% 스트립 → 전체 크기 확대 (중간 거리 집중)
            rctx.drawImage(
              proc,
              0, Math.round(H * 0.20), W, Math.round(H * 0.50),
              0, 0, W, H
            );
            yScale  = 0.50;
            yOffset = 0.20;
            break;
        }

        /* ── 원거리 ROI(phase 0)에 언샤프 마스크 적용 ── */
        if (rp === 0) {
          _sharpen(rctx, W, H, 0.4);
        }

        /* ── 추론 + 좌표 역변환 ── */
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

        /* ── flickering 방지: 빈 결과면 직전 1프레임 유지 ── */
        if (signals.length === 0 && _prevSignals.length > 0) {
          signals = _prevSignals.map(s => ({ ...s, _stale: true }));
        }
        _prevSignals = signals.filter(s => !s._stale);

        tickFps();
        updateScanBadge(signals);
        drawBoxes(overlay.getContext('2d'), signals, W, H);

        if (signals.length > 0) {
          const top   = signals[0];
          const color = estimateSignalColor(top.box, W, H);
          updateFullscreen(top, color);
        }

        renderCards(signals, sig => {
          const color = estimateSignalColor(sig.box, W, H);
          updateFullscreen(sig, color);
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
        sum += data[i] * 0.3 + data[i+1] * 0.59 + data[i+2] * 0.11;
        cnt++;
      }
      if (cnt) applyNight(sum / cnt < 60);
    } catch { /* cross-origin guard */ }
  }, 3000);
}

/* ════════════════════════════════════
   신호등 색상 추정
════════════════════════════════════ */
export function estimateSignalColor(box, W, H) {
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
   라플라시안 언샤프 마스크 (내부 유틸)
   rctx: CanvasRenderingContext2D (roiCanvas)
   W, H: 캔버스 크기
   str : 샤프닝 강도 (0.3 ~ 0.6 권장)
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
  // 경계 픽셀 원본 복사
  for (let i = 0; i < src.length; i += 4) {
    if (out[i+3] === 0) {
      out[i]=src[i]; out[i+1]=src[i+1]; out[i+2]=src[i+2]; out[i+3]=255;
    }
  }
  rctx.putImageData(new ImageData(out, W, H), 0, 0);
}
