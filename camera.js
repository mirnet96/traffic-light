/* ════════════════════════════════════
   camera.js — 카메라 · 스캔루프 · 야간 감지 · 색상 추정

   수정 이력:
    - [버그] estimateSignalColor 호출부 인자 불일치 수정
    - [버그] stale 신호 fullscreen·TTS 전달 오동작 수정
    - [변경] 추론 모델 YOLOv8s → YOLOv11s / 입력 해상도 1280 대응
    - [추가] SAHI 2×2 타일 슬라이싱
    - [추가] 가로형 차량 신호등 필터 (_isPedestrianShape)
    - [개선] 종횡비 상한 추가 — H/W > 2.5 이면 3구 차량 신호등으로 제거
    - [추가] box 비율 기반 isPedestrian 자동 추정
    - [개선] estimateSignalColor — 밝기 상위 10% 픽셀만 샘플링
    - [개선] stale 유지 타임스탬프 기반 350ms
    - [개선] _sharpen 버퍼 재사용 (매 프레임 GC 방지)
    - [개선] estimateSignalColor — 초록 배경 간판 오판 방지
    - [개선] 밝기 분산 필터 추가 — 단색 구조물 unknown 처리
    - [개선] 초록 임계값 추가 강화 — 채도 0.45, 명도 0.40, 색상 범위 95~165
    - [개선] _isPedestrianShape — 최소 너비/높이 조건, 종횡비 0.65~2.2
    - [개선] estimateSignalColor unknown 시 fullscreen 갱신 억제
    - [개선] 현장 오감지 대응 (20260425):
             · _isPedestrianShape — 박스 상단 Y1 > 0.10 조건 추가 (방음벽 오감지 방지)
             · 원거리 소형 박스(bh < 0.05) isPedestrian 조건 완화
             · estimateSignalColor — 중앙 60% crop 후 샘플링 (배경 오염 제거)
             · 초록 방음벽 대비: lumVar 임계값 200으로 상향
    - [개선] estimateSignalColor v2 — 구조 인식 기반 색상 판정 (20260429):
             · 2구/3구 세로형 신호등 자동 판별 (H/W ≥ 1.8 → 3구)
             · 2구: 상단=정지(적색/서있는사람), 하단=보행(녹색/걷는사람)
             · 3구: 상단=적색, 중단=녹색, 하단=잔여시간(녹색)
             · 발광 구간 밝기 비교로 켜진 등 위치 특정 (단순 색상 평균 대비 개선)
             · 발광 픽셀 밀도(density) 신뢰도 지표 도입
             · 적색 Hue: <22 또는 >338 (채도·명도 임계 완화)
             · 녹색 Hue: 85~175 (기존 95~165 확장)
             · crop 좌우 여백 20%→15% 완화 (소형 박스 색상 누락 방지)
             · 분산 임계값 200→180 (원거리 소형 박스 대응)
    - [개선] 인식률 저하 4종 수정 (원거리·야간·소형·전반):
             · lumVar 분산 임계값 동적 적용 — 박스 크기에 반비례 (원거리 소형 색상 판별 개선)
             · SAHI 실행 빈도 3→2프레임 중 1회로 증가 (원거리 감지율 향상)
             · PED_MIN_Y1 0.10→0.05 완화 (원거리 신호등 상단 필터 탈락 감소)
             · 2구 밝기 비율 임계 1.20→1.12 완화 (흐린 날·야간 색상 판별 개선)
    - [개선] 인식률 5종 추가 개선:
             · SAHI 타일 2×2(4개) → 3×3(9개) — 원거리 소형 신호등 상대적 입력 크기 향상
             · ROI phase 2종 → 3종 순환 (SAHI 3프레임 중 1회로 속도 보전)
               0: 상단 0~70% + sharpen (기존 55% → 70% 확장)
               1: 중단 30~80% — 카메라 수평/하향 시 신호등 누락 방지 (신규)
               2: 전체 SAHI 3×3
             · SAHI 타일 JPEG 품질 0.75 → 0.85 (원거리 특징 손실 감소)
             · PED_MIN_HEIGHT 0.025 → 0.015 (10차선 이상 원거리 소형 박스 통과)
             · _isPedestrianByRatio 원거리 MAX 완화: bh<0.04 시 3.0→3.5
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
const ROI_JPEG_Q   = [0.88, 0.85, 0.82];  // [개선] SAHI 타일 품질 0.75→0.85 (원거리 특징 보존)
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
/* [개선] SAHI 3×3 타일 — 2×2(4타일) → 3×3(9타일)
   타일이 작아질수록 원거리 소형 신호등이 상대적으로 크게 입력되어
   YOLOv11s 감지율 향상. overlap=0.15 유지로 경계 누락 방지 */
function _buildSahiTiles(srcCanvas, W, H) {
  const cols  = 3, rows = 3;
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
   ┌────────────────────────────────────────┐
   │  신호등 종류별 종횡비(H/W) 기준:         │
   │  · 보행 신호등(2구 세로): 0.65 ~ 2.2    │
   │  · 차량 신호등(3구 세로): 2.2 이상       │
   │  → H/W > 2.2 이면 차량등으로 제거       │
   │  · 가로형(H/W < 0.65): 제거             │
   │  · Y1 < 0.10 (화면 최상단 10%): 제거    │
   │    → 방음벽·간판 등 배경 구조물 오감지 방지│
   │  · 최소 높이 2.5%·너비 1.0% 미만: 제거  │
   └────────────────────────────────────────┘
════════════════════════════════════ */
const PED_RATIO_MIN  = 0.65;   // 가로형 상한
const PED_RATIO_MAX  = 2.2;    // 차량 신호등 하한
const PED_MIN_HEIGHT = 0.015;  // [개선] 박스 높이 최소값 0.025→0.015 (원거리 소형 신호등 탈락 방지)
const PED_MIN_WIDTH  = 0.010;  // 박스 너비 최소값 (정규화)
const PED_MIN_Y1     = 0.05;   // 박스 상단 최소 Y 위치 — 화면 최상단 5% 이내 제거
                                //  방음벽·배경 구조물은 Y1이 0~4% 범위에 몰림
                                //  원거리·카메라 하향 시 신호등이 상단 5~10%에 올 수 있어
                                //  기존 0.10에서 0.05로 완화 (원거리 탈락 방지)

function _isPedestrianShape(box) {
  const [y1, x1, y2, x2] = box;
  const bh = y2 - y1;
  const bw = x2 - x1;
  if (y1 < PED_MIN_Y1)  return false;           // [추가] 최상단 배경 구조물 제거
  if (bh < PED_MIN_HEIGHT) return false;        // 너무 작음 (높이)
  if (bw < PED_MIN_WIDTH)  return false;        // 너무 좁음 (기둥 오감지 방지)
  const ratio = bh / bw;
  if (ratio < PED_RATIO_MIN) return false;      // 가로형 → 차량 방향등 등
  if (ratio > PED_RATIO_MAX) return false;      // 지나치게 세로 → 3구 차량 신호등
  return true;
}

/* box 세로/가로 비율로 보행신호 여부 추정
   원거리 소형(bh < 0.04) 박스는 종횡비가 압축되어 불안정하므로
   MAX 조건을 완화(2.2 → 3.5)하여 보행신호등 누락 방지
   [개선] bh 기준 0.05→0.04, MAX 3.0→3.5 (10차선 이상 원거리 대응) */
function _isPedestrianByRatio(box) {
  const [y1, x1, y2, x2] = box;
  const bh    = y2 - y1;
  const ratio = bh / (x2 - x1);
  const maxR  = bh < 0.04 ? 3.5 : PED_RATIO_MAX;   // [개선] 원거리 소형 완화 강화
  return ratio >= PED_RATIO_MIN && ratio <= maxR;
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
        /* [개선] ROI 3종 순환:
             0: 상단 0~70% + sharpen  — 역광 하늘 아래 신호등 집중
             1: 중단 30~80%           — 카메라 수평 방향 신호등 커버
             2: 전체 SAHI 3×3         — 원거리 소형 신호등 (3프레임 중 1회)  */
        const rp = _roiPhase % 3;
        _roiPhase++;

        let yOffset = 0, yScale = 1.0;

        switch (rp) {
          case 0:
            /* 상단 0~70% + 언샤프 마스크 — 역광 하늘 아래 신호등 집중 추론
               (기존 55% → 70%: 더 넓은 상단 영역 커버) */
            roiCanvas.width  = Math.min(W, MAX_SIDE);
            roiCanvas.height = Math.min(Math.round(H * 0.70), MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(
              proc, 0, 0, W, Math.round(H * 0.70),
              0, 0, roiCanvas.width, roiCanvas.height
            );
            yScale = 0.70; yOffset = 0;
            break;
          case 1:
            /* 중단 30~80% — 카메라가 수평이거나 살짝 내려간 경우 신호등 커버 */
            roiCanvas.width  = Math.min(W, MAX_SIDE);
            roiCanvas.height = Math.min(Math.round(H * 0.50), MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(
              proc, 0, Math.round(H * 0.30), W, Math.round(H * 0.50),
              0, 0, roiCanvas.width, roiCanvas.height
            );
            yScale = 0.50; yOffset = 0.30;
            break;
          case 2:
            /* 전체 프레임 SAHI 3×3 — 원거리 소형 신호등 집중 추론 (3프레임 중 1회) */
            roiCanvas.width  = Math.min(W, MAX_SIDE);
            roiCanvas.height = Math.min(H, MAX_SIDE);
            roiCanvas.getContext('2d').drawImage(proc, 0, 0, W, H, 0, 0, roiCanvas.width, roiCanvas.height);
            yScale = 1.0; yOffset = 0;
            break;
        }

        if (rp === 0) {
          _sharpen(roiCanvas.getContext('2d'), roiCanvas.width, roiCanvas.height, 0.4);
        }

        let signals = [];
        try {
          let raw;
          if (rp === 2) {
            /* SAHI 3×3: 3프레임 중 1회 실행 — 원거리 소형 신호등 감지 강화 */
            const tiles   = _buildSahiTiles(proc, W, H);
            const sahiRaw = await runYoloSahi(tiles);
            raw = _sahiNms(sahiRaw).filter(s => _isPedestrianShape(s.box));
            showDebug(`[sahi3x3] tiles:${tiles.length} raw:${sahiRaw.length} → nms:${raw.length}`);
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
          if (color !== 'unknown') {
            /* 색상이 명확한 경우만 전체화면 갱신 */
            _lastFsColor = color;
            _lastFsSig   = top;
            updateFullscreen(top, color);
          } else {
            /* unknown: stale 만료 전이면 이전 신호 유지, 아니면 전체화면 닫지 않고 유지만 */
            showDebug('[color] unknown → fullscreen 갱신 억제');
          }
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
   신호등 색상 추정 (v2 — 구조 인식 기반)

   개선 내역:
    ① 박스 구조 분석 — 2구(보행 전용) / 3구(잔여시간 포함) 자동 판별
       · 비율 H/W ≥ 1.6 → 3구 세로형 신호등으로 판별
       · 2구: 상단 점등=적색, 하단 점등=녹색
       · 3구: 상단 점등=적색, 중단 점등=녹색, 하단=잔여시간(녹색 계열)
    ② 발광 구간 검출 — 구간별 밝기 합산으로 "가장 밝은 구간" 특정
       → 단순 색상 평균 대비 켜진 등 위치를 더 정밀하게 추적
    ③ HSV 임계값 강화
       · 적색: Hue 0~20 + 340~360, 채도 > 0.45, 명도 > 0.40
               야간 흐릿한 적색(낮은 채도)도 검출 위해 임계 소폭 완화
       · 녹색: Hue 85~175 (기존 95~165 확장), 채도 > 0.40, 명도 > 0.35
               보행신호 아이콘(걷는 사람 형태)의 밝은 녹색 보장
    ④ 배경 오염 차단 유지
       · 좌우 15%씩 crop (기존 20% → 15% 완화, 소형 박스 누락 방지)
       · 분산 임계값 180 (기존 200 → 180, 원거리 소형 박스 대응)
    ⑤ 발광 구간 신뢰도 점수 도입
       · 켜진 등의 밝기 집중도(발광픽셀/전체픽셀 비율)로 신뢰도 계산
       · 신뢰도 미달 시 unknown 반환
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

/* 구간 평균 HSV 계산 헬퍼 */
function _zoneHsv(px, lum, thr, bw, rowStart, rowEnd) {
  let r = 0, g = 0, b = 0, cnt = 0, lumSum = 0, lumCnt = 0;
  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = 0; col < bw; col++) {
      const i = row * bw + col;
      lumSum += lum[i];
      lumCnt++;
      if (lum[i] < thr) continue;
      const o = i * 4;
      r += px[o]; g += px[o+1]; b += px[o+2];
      cnt++;
    }
  }
  const avgLum = lumCnt ? lumSum / lumCnt : 0;
  if (!cnt) return { h: 0, s: 0, v: 0, cnt: 0, brightness: avgLum, density: 0 };
  const density = cnt / (lumCnt || 1);  // 발광 픽셀 밀도 (신뢰도 지표)
  const [h, s, v] = _rgbToHsv(r / cnt, g / cnt, b / cnt);
  return { h, s, v, cnt, brightness: avgLum, density };
}

/* 색상 판정 헬퍼 */
function _isRedHsv(h, s, v)   { return (h < 22 || h > 338) && s > 0.40 && v > 0.38; }
function _isGreenHsv(h, s, v) { return (h > 85 && h < 175)  && s > 0.38 && v > 0.32; }

export function estimateSignalColor(x1, y1, x2, y2) {
  const W = proc.width, H = proc.height;

  /* [개선] 좌우 15% crop — 소형 박스 손실 최소화 + 배경 오염 차단 */
  const xMargin = (x2 - x1) * 0.15;
  const cx1 = x1 + xMargin, cx2 = x2 - xMargin;

  const bx = Math.max(0, Math.round(cx1 * W));
  const by = Math.max(0, Math.round(y1 * H));
  const bw = Math.min(W - bx, Math.round((cx2 - cx1) * W));
  const bh = Math.min(H - by, Math.round((y2 - y1) * H));
  if (bw < 3 || bh < 3) return 'unknown';

  try {
    const px    = procCtx.getImageData(bx, by, bw, bh).data;
    const total = bw * bh;

    /* 1. 밝기 배열 계산 */
    const lum = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      lum[i] = px[o] * 0.299 + px[o+1] * 0.587 + px[o+2] * 0.114;
    }

    /* 2. 밝기 분산 검사 — 단색 구조물(방음벽·간판) 제거
          박스 크기가 작을수록(원거리) 자연적으로 분산이 낮으므로 동적 임계 적용:
          · 박스 픽셀 수 ≥ 400 (가까운 신호등): 임계 180 (엄격)
          · 박스 픽셀 수 < 400 (원거리 소형):   임계 60  (완화)
          · 그 사이는 선형 보간 */
    const lumVarThr = total >= 400
      ? 180
      : Math.max(60, 60 + (total / 400) * 120);   // 60~180 선형 보간
    let lumMean = 0;
    for (let i = 0; i < total; i++) lumMean += lum[i];
    lumMean /= total;
    let lumVar = 0;
    for (let i = 0; i < total; i++) lumVar += (lum[i] - lumMean) ** 2;
    lumVar /= total;
    if (lumVar < lumVarThr) return 'unknown';

    /* 3. 상위 10% 밝기 임계값 (점등면 발광 픽셀 선별) */
    const thr = lum.slice().sort()[Math.floor(total * 0.90)];

    /* ────────────────────────────────────────────────────
       4. 박스 구조 판별 (2구 vs 3구 vs 비구조)
          H/W 비율로 세로형 신호등 구조 추정:
          · H/W ≥ 1.8 → 3구 세로형 (잔여시간 포함)
               구간: 상(0~33%) / 중(33~67%) / 하(67~100%)
               판정: 상점등=적, 중점등=녹, 하점등=녹(잔여시간)
          · H/W 0.65~1.8 → 2구 세로형 (기본 보행신호)
               구간: 상(0~50%) / 하(50~100%)
               판정: 상점등=적, 하점등=녹
          · H/W < 0.65 → 가로형 (이미 _isPedestrianShape에서 걸러짐)
       ──────────────────────────────────────────────────── */
    const aspect = bh / bw;

    if (aspect >= 1.8) {
      /* ── 3구 세로형 신호등 ── */
      const r0 = Math.round(bh * 0.33);
      const r1 = Math.round(bh * 0.67);

      const zTop = _zoneHsv(px, lum, thr, bw, 0,  r0);  // 상단 — 적색등
      const zMid = _zoneHsv(px, lum, thr, bw, r0, r1);  // 중단 — 녹색등
      const zBot = _zoneHsv(px, lum, thr, bw, r1, bh);  // 하단 — 잔여시간 숫자

      /* 가장 밝은 구간 특정 (점등된 등 위치 판별) */
      const brightTop = zTop.brightness;
      const brightMid = zMid.brightness;
      const brightBot = zBot.brightness;

      const topLit = brightTop > brightMid * 1.25 && brightTop > brightBot * 1.25;
      const midLit = brightMid > brightTop * 1.10 && brightMid >= brightBot * 0.90;
      const botLit = brightBot > brightTop * 1.10;

      /* 상단 점등 → 적색 판정 */
      if (topLit && _isRedHsv(zTop.h, zTop.s, zTop.v) && zTop.density > 0.04) {
        showDebug(`[color3] top-RED h=${zTop.h.toFixed(0)} s=${zTop.s.toFixed(2)} v=${zTop.v.toFixed(2)} dens=${zTop.density.toFixed(3)}`);
        return 'red';
      }
      /* 중단 또는 하단 점등 → 녹색 판정 */
      if ((midLit && _isGreenHsv(zMid.h, zMid.s, zMid.v) && zMid.density > 0.04) ||
          (botLit && _isGreenHsv(zBot.h, zBot.s, zBot.v) && zBot.density > 0.04)) {
        showDebug(`[color3] mid/bot-GREEN midH=${zMid.h.toFixed(0)} botH=${zBot.h.toFixed(0)}`);
        return 'green';
      }

      /* 구간 구분 없이 전체 색상으로 fallback 판정 */
      const allZone = _zoneHsv(px, lum, thr, bw, 0, bh);
      if (_isRedHsv(allZone.h, allZone.s, allZone.v))   return 'red';
      if (_isGreenHsv(allZone.h, allZone.s, allZone.v)) return 'green';
      return 'unknown';

    } else {
      /* ── 2구 세로형 신호등 (보행 기본형) ──
            상단(0~50%): 서 있는 사람 → 적색
            하단(50~100%): 걷는 사람 → 녹색                     */
      const rMid = Math.round(bh * 0.50);

      const zTop = _zoneHsv(px, lum, thr, bw, 0,    rMid); // 상단 — 정지(적색)
      const zBot = _zoneHsv(px, lum, thr, bw, rMid, bh);   // 하단 — 보행(녹색)

      const brightTop = zTop.brightness;
      const brightBot = zBot.brightness;

      /* 발광 구간 판별: 한쪽이 1.12배 이상 밝으면 그쪽이 점등
         (기존 1.20 → 1.12 완화: 흐린 날·야간에서 점등/소등 차이가 작아도 판별 가능) */
      const topLit = brightTop > brightBot * 1.12;
      const botLit = brightBot > brightTop * 1.12;

      showDebug(`[color2] topB=${brightTop.toFixed(1)} botB=${brightBot.toFixed(1)} topH=${zTop.h.toFixed(0)} botH=${zBot.h.toFixed(0)}`);

      /* 상단 점등 우세 → 적색 판정 */
      if (topLit) {
        /* 적색 HSV 충족 시 red, 아니어도 하단 녹색이 아니면 unknown */
        if (_isRedHsv(zTop.h, zTop.s, zTop.v) && zTop.density > 0.03) return 'red';
        /* 색상 불명확하나 상단이 확실히 밝음 → 밝기만으로 적색 추정 (고확신) */
        if (brightTop > brightBot * 1.60 && zTop.density > 0.05) return 'red';
      }

      /* 하단 점등 우세 → 녹색 판정 */
      if (botLit) {
        if (_isGreenHsv(zBot.h, zBot.s, zBot.v) && zBot.density > 0.03) return 'green';
        if (brightBot > brightTop * 1.60 && zBot.density > 0.05) return 'green';
      }

      /* ── 밝기 차이 불명확 시 전체 HSV 색상으로 최종 판정 ── */
      /* 상단 구간 초록 단독 → 배경 간판/방음벽 오판 방지 */
      const isGreenTop = _isGreenHsv(zTop.h, zTop.s, zTop.v);
      const isGreenBot = _isGreenHsv(zBot.h, zBot.s, zBot.v);
      const isRedTop   = _isRedHsv(zTop.h, zTop.s, zTop.v);

      if (isGreenTop && !isGreenBot) return 'unknown';  // 상단만 초록 → 배경
      if (isGreenBot)                return 'green';
      if (isRedTop)                  return 'red';
      return 'unknown';
    }
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
