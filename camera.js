/* ════════════════════════════════════
   camera.js — 카메라 · 스캔루프 · 야간 감지 · 색상 추정

   수정 이력:
    - [버그] estimateSignalColor 호출부 인자 불일치 수정
    - [버그] stale 신호 fullscreen·TTS 전달 오동작 수정
    - [변경] 추론 모델 YOLOv8s → YOLOv11s / 입력 해상도 1280 대응
    - [추가] SAHI 2×2 타일 슬라이싱
    - [추가] 가로형 차량 신호등 필터 (_isPedestrianShape)
    - [개선] 종횡비 상한 추가 — H/W > 2.5 이면 3구 차량 신호등으로 제거
             보행 신호등(2구) H/W ≈ 1.5~2.5 / 차량등(3구) H/W ≈ 2.5~3.5
    - [추가] box 비율 기반 isPedestrian 자동 추정
    - [개선] estimateSignalColor — 밝기 상위 15% 픽셀만 샘플링
    - [개선] stale 유지 타임스탬프 기반 350ms
    - [개선] _sharpen 버퍼 재사용 (매 프레임 GC 방지)
    - [개선] 전체화면 닫힐 때 _lastFsSig 리셋 → 재감지 TTS 재발화 보장
    - [버그] 병합 오류로 생긴 주석 잔재 제거
    - [개선] estimateSignalColor — 초록 배경 오판 방지
             밝기 상위 10%(15%→10%), 초록 채도 임계값 0.40(0.25→), 색상 범위 95~175(190→)
             상단 초록 단독 감지 시 배경 간판으로 간주 → unknown 처리
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

/* ── DOM ── */
const video    = document.getElementById('video');
const proc     = document.getElementById('proc');
const overlay  = document.getElementById('overlay');
const scanline = document.getElementById('scanline');

export const procCtx = proc.getContext('2d', { willReadFrequently: true });

/* ── 상태 ── */
let stream      = null;
let scanTimer   = null;
let nightTimer  = null;
let roiCanvas   = null;
let _roiPhase   = 0;
let _prevSignals = [];
let _staleUntil  = 0;      // stale 만료 타임스탬프(ms)

export let camFacing = 'environment';
export let phase     = 'init';
let lastVW = 0, lastVH = 0;

/* 마지막 전체화면 신호 (stale 프레임 렌더 유지 + 닫기 후 재발화용) */
let _lastFsSig   = null;
let _lastFsColor = 'unknown';

/* _sharpen 재사용 버퍼 */
let _sharpenBuf = null;

/* ── 상수 ── */
const SCAN_MS      = 120;
const ROI_JPEG_Q   = [0.88, 0.75, 0.82];
const MAX_SIDE     = 1280;
const SAHI_OVERLAP = 0.15;
const SAHI_NMS_IOU = 0.45;
const STALE_MS     = 350;

/* ════════════════════════════════════
   카메라
════════════════════════════════════ */
export async function startCamera(facing) {
  readConfig();
  setTtsEnabled(cfg.tts);
  setDebugEnabled(cfg.debug);
  setRecorderDebug(showDebug);

  /* 전체화면 닫힐 때 _lastFsSig 리셋 → 재감지 시 TTS 재발화 보장 */
  document.getElementById('fs').addEventListener('click', () => {
    _lastFsSig   = null;
    _lastFsColor = 'unknown';
  });

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
════════════════════════════════════ */
function _buildSahiTiles(srcCanvas, W, H) {
  const cols  = 2, rows = 2;
  const tileW = Math.round(W / cols * (1 + SAHI_OVERLAP));
  const tileH = Math.round(H / rows * (1 + SAHI_OVERLAP));
  const stepX = Math.round(W / cols);
  const stepY = Math.round(H / rows);

  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = col * stepX;
      const sy = row * stepY;
      const sw = Math.min(tileW, W - sx);
      const sh = Math.min(tileH, H - sy);
      const dw = Math.min(sw, MAX_SIDE);
      const dh = Math.min(sh, MAX_SIDE);
      const tc = document.createElement('canvas');
      tc.width  = dw;
      tc.height = dh;
      tc.getContext('2d').drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, dw, dh);
      tiles.push({
        canvas:  tc,
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
   SAHI NMS
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
   신호등 형태 필터
   ┌──────────────────────────────────────┐
   │  신호등 종류별 종횡비(H/W) 기준:      │
   │  · 보행 신호등(2구 세로): 1.5 ~ 2.5  │
   │  · 차량 신호등(3구 세로): 2.5 ~ 3.5+ │
   │  → H/W > 2.5 이면 차량등으로 제거    │
   │  · 가로형(H/W < 0.56): 제거          │
   │  · 최소 높이 2% 미만: 제거           │
   └──────────────────────────────────────┘
════════════════════════════════════ */
const PED_RATIO_MIN = 0.56;   // 가로형 상한 (H/W < 이 값이면 제거)
const PED_RATIO_MAX = 2.5;    // 차량 신호등 하한 (H/W > 이 값이면 차량등으로 제거)

function _isPedestrianShape(box) {
  const [y1, x1, y2, x2] = box;
  const bh = y2 - y1;
  const bw = x2 - x1;
  if (bh < 0.02) return false;                    // 너무 작음
  const ratio = bh / bw;
  if (ratio < PED_RATIO_MIN) return false;         // 가로형 → 차량 방향등 등
  if (ratio > PED_RATIO_MAX) return false;         // 지나치게 세로 → 3구 차량 신호등
  return true;
}

/* box 세로/가로 비율로 보행신호 여부 추정 */
function _isPedestrianByRatio(box) {
  const [y1, x1, y2, x2] = box;
  const ratio = (y2 - y1) / (x2 - x1);
  return ratio >= PED_RATIO_MIN && ratio <= PED_RATIO_MAX;
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
          _sharpenBuf = null;   // 해상도 변경 시 버퍼 리셋
        }
        procCtx.drawImage(video, 0, 0, W, H);

        if (!roiCanvas) roiCanvas = document.createElement('canvas');
        const rp = _roiPhase % 3;
        _roiPhase++;

        let yOffset = 0, yScale = 1.0;

        switch (rp) {
          case 0:
            roiCanvas.width  = Math.min(W, MAX_SIDE);
            roiCanvas.height = Math.min(Math.round(H * 0.55), MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(
              proc, 0, 0, W, Math.round(H * 0.55),
              0, 0, roiCanvas.width, roiCanvas.height
            );
            yScale = 0.55; yOffset = 0;
            break;
          case 1:
            roiCanvas.width  = Math.min(W, MAX_SIDE);
            roiCanvas.height = Math.min(H, MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(proc, 0, 0, W, H, 0, 0, roiCanvas.width, roiCanvas.height);
            yScale = 1.0; yOffset = 0;
            break;
          case 2: {
            const srcY = Math.round(H * 0.20);
            const srcH = Math.round(H * 0.50);
            roiCanvas.width  = Math.min(W, MAX_SIDE);
            roiCanvas.height = Math.min(srcH, MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(
              proc, 0, srcY, W, srcH,
              0, 0, roiCanvas.width, roiCanvas.height
            );
            yScale = 0.50; yOffset = 0.20;
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
            const tiles   = _buildSahiTiles(proc, W, H);
            const sahiRaw = await runYoloSahi(tiles);
            raw = _sahiNms(sahiRaw).filter(s => _isPedestrianShape(s.box));
            showDebug(`[sahi] tiles:${tiles.length} raw:${sahiRaw.length} → nms:${raw.length}`);
          } else {
            const rawArr = await runYolo(roiCanvas, roiCanvas.width, roiCanvas.height, ROI_JPEG_Q[rp]);
            raw = rawArr.map(s => {
              const [y1, x1, y2, x2] = s.box;
              return { ...s, box: [y1 * yScale + yOffset, x1, y2 * yScale + yOffset, x2] };
            }).filter(s => _isPedestrianShape(s.box));
          }
          signals = raw.map(s => ({
            ...s,
            isPedestrian: s.isPedestrian ?? _isPedestrianByRatio(s.box),
          }));
        } catch (e) {
          console.warn('scan error:', e);
          setBadge('스캔 오류', 'text-red-400');
        }

        /* ── stale: 타임스탬프 기반 350ms 유지 ── */
        const now = performance.now();
        let freshSignals, displaySignals;

        if (signals.length > 0) {
          freshSignals   = signals;
          displaySignals = signals;
          _prevSignals   = signals;
          _staleUntil    = now + STALE_MS;
        } else if (now < _staleUntil && _prevSignals.length > 0) {
          freshSignals   = [];
          displaySignals = _prevSignals.map(s => ({ ...s, _stale: true }));
        } else {
          freshSignals   = [];
          displaySignals = [];
          _prevSignals   = [];
        }

        tickFps();
        updateScanBadge(freshSignals);
        drawBoxes(overlay.getContext('2d'), displaySignals, W, H);

        if (freshSignals.length > 0) {
          const top = freshSignals[0];
          const [y1, x1, y2, x2] = top.box;
          const color = estimateSignalColor(x1, y1, x2, y2);
          showDebug(`[color] ${color} isPed=${top.isPedestrian} score=${top.score.toFixed(2)}`);
          _lastFsColor = color;
          _lastFsSig   = top;
          updateFullscreen(top, color);
        } else if (_lastFsSig && displaySignals.some(s => s._stale)) {
          /* stale: 전체화면 좌표 유지, TTS 재발화 없음 */
          updateFullscreen(_lastFsSig, _lastFsColor);
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

    scanTimer = setTimeout(loop, SCAN_MS);
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
   개선: 밝기 상위 15% 픽셀만 샘플링 → 하우징·반사 노이즈 제거
   시그니처: (x1, y1, x2, y2) 정규화 좌표
════════════════════════════════════ */
function _rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d > 0) {
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
    const px    = procCtx.getImageData(bx, by, bw, bh).data;
    const total = bw * bh;

    /* 1. 밝기 배열 계산 */
    const lum = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      lum[i] = px[o] * 0.299 + px[o+1] * 0.587 + px[o+2] * 0.114;
    }

    /* 2. 상위 10% 밝기 임계값 (강화: 15→10%, 등면 발광 픽셀만 선별) */
    const thr = lum.slice().sort()[Math.floor(total * 0.90)];

    /* 3. 상위 10% 픽셀을 상·중·하 3구간으로 집계
          보행신호등 박스는 등면이 상단에 위치하므로
          상단 40%를 zone 0(빨강 판정), 중단 30%를 zone 1(초록 판정),
          하단 30%를 zone 2(숫자판 초록)로 분리 */
    const sec = [
      { r: 0, g: 0, b: 0, cnt: 0 },
      { r: 0, g: 0, b: 0, cnt: 0 },
      { r: 0, g: 0, b: 0, cnt: 0 },
    ];
    for (let row = 0; row < bh; row++) {
      const zone = row < bh * 0.40 ? 0 : row < bh * 0.70 ? 1 : 2;
      for (let col = 0; col < bw; col++) {
        const i = row * bw + col;
        if (lum[i] < thr) continue;
        const o = i * 4;
        sec[zone].r += px[o];
        sec[zone].g += px[o+1];
        sec[zone].b += px[o+2];
        sec[zone].cnt++;
      }
    }

    /* 4. 구간별 HSV 판정
          초록 임계값을 강화(채도 0.25→0.40, 색상 범위 95~175 → 배경 간판과 분리)
          빨강 임계값도 강화(채도 0.35→0.45) */
    const [h0,s0,v0] = sec[0].cnt ? _rgbToHsv(sec[0].r/sec[0].cnt, sec[0].g/sec[0].cnt, sec[0].b/sec[0].cnt) : [0,0,0];
    const [h1,s1,v1] = sec[1].cnt ? _rgbToHsv(sec[1].r/sec[1].cnt, sec[1].g/sec[1].cnt, sec[1].b/sec[1].cnt) : [0,0,0];
    const [h2,s2,v2] = sec[2].cnt ? _rgbToHsv(sec[2].r/sec[2].cnt, sec[2].g/sec[2].cnt, sec[2].b/sec[2].cnt) : [0,0,0];

    /* 빨강: 채도·명도 임계값 강화 (배경 노이즈 제거) */
    const isRed = (h0 < 20 || h0 > 340) && s0 > 0.45 && v0 > 0.40;

    /* 초록: 색상 범위 좁힘(95~175) + 채도 강화(0.40) + 명도 강화(0.35)
             → 연두색 배경 간판(채도 낮음)과 분리 */
    const isGreenM = (h1 > 95 && h1 < 175) && s1 > 0.40 && v1 > 0.35;
    const isGreenB = (h2 > 95 && h2 < 175) && s2 > 0.35 && v2 > 0.35;

    /* 5. 상단 구간에 강한 초록이 있으면 배경 간판으로 간주 → unknown 처리
          (신호등 등면이 상단에 있을 경우 초록 등이 켜진 것이므로 예외 허용하지 않음)
          단, zone0에 초록이 감지되면서 zone1에도 없으면 배경으로 판정 */
    const isGreenTop = (h0 > 95 && h0 < 175) && s0 > 0.40 && v0 > 0.35;
    if (isGreenTop && !isGreenM && !isGreenB) return 'unknown';

    if (isGreenM || isGreenB) return 'green';
    if (isRed)                return 'red';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ════════════════════════════════════
   라플라시안 언샤프 마스크 (_sharpenBuf 재사용)
════════════════════════════════════ */
function _sharpen(rctx, W, H, str) {
  const id  = rctx.getImageData(0, 0, W, H);
  const src = id.data;
  const len = src.length;
  if (!_sharpenBuf || _sharpenBuf.length !== len) {
    _sharpenBuf = new Uint8ClampedArray(len);
  }
  const out = _sharpenBuf;
  const W4  = W * 4;
  for (let row = 1; row < H - 1; row++) {
    for (let col = 1; col < W - 1; col++) {
      const i = row * W4 + col * 4;
      for (let c = 0; c < 3; c++) {
        const lap = src[i+c]*5 - src[i-4+c] - src[i+4+c] - src[i-W4+c] - src[i+W4+c];
        out[i+c]  = Math.min(255, Math.max(0, src[i+c] + lap * str));
      }
      out[i+3] = 255;
    }
  }
  for (let i = 0; i < len; i += 4) {
    if (out[i+3] === 0) {
      out[i]=src[i]; out[i+1]=src[i+1]; out[i+2]=src[i+2]; out[i+3]=255;
    }
  }
  rctx.putImageData(new ImageData(out, W, H), 0, 0);
}
