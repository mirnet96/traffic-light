/* ════════════════════════════════════
   camera.js — 카메라 · 스캔루프 · 야간 감지 · 색상 추정

   수정 이력:
    - [버그] estimateSignalColor 호출부 인자 불일치 수정
             (box 배열+W+H → x1,y1,x2,y2 좌표 직접 전달)
    - [버그] stale 신호가 updateFullscreen/renderCards 로 전달되어
             TTS 재발화·카운트 오동작하던 문제 수정
             (stale 신호는 drawBoxes 만 통과, fullscreen·TTS 스킵)
    - [변경] 추론 모델 YOLOv8s → YOLOv11s
    - [변경] 서버 입력 해상도 1280 대응 — ROI 캔버스 1280 상한 클램핑
    - [추가] SAHI(Slicing Aided Hyper Inference) 적용
             ROI phase 1(전체) 프레임을 2×2 타일로 분할하여 추론 후
             좌표 역변환 + NMS 병합 → 원거리·소형 신호등 감지율 향상
════════════════════════════════════ */

import { loadModel, runYolo, runYoloSahi } from './detector.js';
import { drawBoxes, renderCards }           from './renderer.js';
import { cfg, readConfig }                  from './settings.js';
import { setTtsEnabled, ttsPhase }          from './tts.js';
import { startRecording }                   from './recorder.js';
import { setDebugEnabled, showDebug, setPhase,
         setBadge, updateScanBadge, tickFps,
         applyNight, drawPip, showDetEmpty } from './ui.js';
import { updateFullscreen }                 from './fullscreen.js';
import { setRecorderDebug }                 from './recorder.js';

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
const ROI_JPEG_Q   = [0.88, 0.75, 0.82];
const MAX_SIDE     = 1280;   // YOLOv11s 입력 상한

/* ── SAHI 상수 ── */
const SAHI_OVERLAP = 0.15;   // 타일 간 겹침 비율
const SAHI_NMS_IOU = 0.45;   // SAHI 결과 병합 NMS IOU 임계값

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
   SAHI 타일 생성
   원본 캔버스를 2×2 타일로 분할 (SAHI_OVERLAP 겹침)
   반환: detector.js runYoloSahi 형식 tiles[]
════════════════════════════════════ */
function _buildSahiTiles(srcCanvas, W, H) {
  const cols   = 2, rows = 2;
  const tileW  = Math.round(W / cols * (1 + SAHI_OVERLAP));
  const tileH  = Math.round(H / rows * (1 + SAHI_OVERLAP));
  const stepX  = Math.round(W / cols);
  const stepY  = Math.round(H / rows);

  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx  = col * stepX;
      const sy  = row * stepY;
      const sw  = Math.min(tileW, W - sx);
      const sh  = Math.min(tileH, H - sy);

      // 타일 캔버스 — 1280 상한 클램핑
      const dw  = Math.min(sw, MAX_SIDE);
      const dh  = Math.min(sh, MAX_SIDE);
      const tc  = document.createElement('canvas');
      tc.width  = dw;
      tc.height = dh;
      const tctx = tc.getContext('2d');
      tctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, dw, dh);

      tiles.push({
        canvas:  tc,
        // 역변환: tile 좌표(0~1) → 원본(0~1)
        offsetX: sx / W,
        offsetY: sy / H,
        scaleX:  sw / W,
        scaleY:  sh / H,
        quality: ROI_JPEG_Q[1],
      });
    }
  }
  return tiles;
}

/* ════════════════════════════════════
   SAHI NMS — 타일 병합 후 중복 제거
════════════════════════════════════ */
function _sahiNms(dets) {
  if (!dets.length) return [];
  dets.sort((a, b) => b.score - a.score);
  const kept = [], used = new Set();
  for (let i = 0; i < dets.length; i++) {
    if (used.has(i)) continue;
    kept.push(dets[i]);
    for (let j = i + 1; j < dets.length; j++) {
      if (!used.has(j) && _iou(dets[i].box, dets[j].box) > SAHI_NMS_IOU)
        used.add(j);
    }
  }
  return kept;
}

function _iou(a, b) {
  const iy1 = Math.max(a[0], b[0]), ix1 = Math.max(a[1], b[1]);
  const iy2 = Math.min(a[2], b[2]), ix2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, iy2 - iy1) * Math.max(0, ix2 - ix1);
  if (!inter) return 0;
  return inter / ((a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter);
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
        const rp = _roiPhase % 3;
        _roiPhase++;

        let yOffset = 0;
        let yScale  = 1.0;

        // ROI 캔버스 크기: 1280 상한 클램핑
        let roiW = W, roiH = H;

        switch (rp) {
          case 0:
            roiH = Math.round(H * 0.55);
            roiW = Math.min(W, MAX_SIDE);
            roiCanvas.width  = roiW;
            roiCanvas.height = Math.min(roiH, MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(proc, 0, 0, W, roiH, 0, 0, roiW, Math.min(roiH, MAX_SIDE));
            yScale  = 0.55;
            yOffset = 0;
            break;
          case 1:
            roiW = Math.min(W, MAX_SIDE);
            roiH = Math.min(H, MAX_SIDE);
            roiCanvas.width  = roiW;
            roiCanvas.height = roiH;
            roiCanvas.getContext('2d').drawImage(proc, 0, 0, W, H, 0, 0, roiW, roiH);
            yScale  = 1.0;
            yOffset = 0;
            break;
          case 2: {
            const srcY = Math.round(H * 0.20);
            const srcH = Math.round(H * 0.50);
            roiW = Math.min(W, MAX_SIDE);
            roiH = Math.min(srcH, MAX_SIDE);
            roiCanvas.width  = roiW;
            roiCanvas.height = roiH;
            roiCanvas.getContext('2d').drawImage(proc, 0, srcY, W, srcH, 0, 0, roiW, roiH);
            yScale  = 0.50;
            yOffset = 0.20;
            break;
          }
        }

        if (rp === 0) {
          _sharpen(roiCanvas.getContext('2d'), roiCanvas.width, roiCanvas.height, 0.4);
        }

        let signals = [];
        try {
          let raw;
          if (rp === 1) {
            // phase 1(전체 프레임)에 SAHI 적용
            const tiles = _buildSahiTiles(proc, W, H);
            const sahiRaw = await runYoloSahi(tiles);
            raw = _sahiNms(sahiRaw).filter(s => (s.box[2] - s.box[0]) >= 0.02);
            showDebug(`[sahi] tiles:${tiles.length} raw:${sahiRaw.length} → nms:${raw.length}`);
          } else {
            const rawArr = await runYolo(roiCanvas, roiCanvas.width, roiCanvas.height, ROI_JPEG_Q[rp]);
            raw = rawArr.map(s => {
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
          }
          signals = raw;
        } catch (e) {
          console.warn('scan error:', e);
          setBadge('스캔 오류', 'text-red-400');
        }

        /* ── flickering 방지: stale 마킹 분리 ── */
        const freshSignals = signals.filter(s => !s._stale);
        const displaySignals = signals.length === 0 && _prevSignals.length > 0
          ? _prevSignals.map(s => ({ ...s, _stale: true }))
          : signals;

        _prevSignals = freshSignals;

        tickFps();
        updateScanBadge(freshSignals);
        drawBoxes(overlay.getContext('2d'), displaySignals, W, H);

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
   시그니처: (x1, y1, x2, y2) — 호출부도 동일하게 수정
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
