'use strict';

/* ── 상수 ── */
const MODEL_URL = 'https://tfhub.dev/tensorflow/tfjs-model/ssd_mobilenet_v2/1/default/1';
const TL_CLASS  = 10;     // COCO: traffic light
const SCAN_MS   = 150;
const MIN_SCORE = 0.35;
const NIGHT_THR = 60;

/* ── DOM 참조 ── */
const video    = document.getElementById('video');
const proc     = document.getElementById('proc');
const overlay  = document.getElementById('overlay');
const scanline = document.getElementById('scanline');

/* ── 상태 ── */
let model     = null;
let stream    = null;
let scanTimer = null;
let nightMode = false;
let camFacing = 'environment';
let phase     = 'init';

/* ════════════════════════════════════
   UI 헬퍼
════════════════════════════════════ */
function setPhase(p) {
  phase = p;

  const show = (id, visible, displayType = 'flex') => {
    const el = document.getElementById(id);
    el.style.display = visible ? displayType : 'none';
  };

  show('init-screen',    p === 'init');
  show('loading-screen', p === 'loading');
  show('error-screen',   p === 'error');
  show('bottombar',      p === 'live', 'block');
  show('btn-flip',       p === 'live', 'flex');

  scanline.style.display = p === 'live' ? 'block' : 'none';
}

function applyNight(on) {
  nightMode = on;
  video.className = on ? 'w-full h-full object-cover block night'
                       : 'w-full h-full object-cover block day';

  const btn = document.getElementById('btn-night');
  btn.className = btn.className.replace(/\bon\b/, '').trim();
  document.getElementById('night-label').textContent = on ? '야간 ON' : '야간 OFF';

  if (on) {
    btn.classList.add('on');
    btn.querySelector('.material-symbols-rounded').textContent = 'light_mode';
  } else {
    btn.classList.remove('on');
    btn.querySelector('.material-symbols-rounded').textContent = 'dark_mode';
  }
}

/* ════════════════════════════════════
   모델 로드
════════════════════════════════════ */
async function loadModel() {
  if (model) return;
  document.getElementById('load-msg').textContent = 'AI 모델 로드 중... (최초 1회)';
  try {
    model = await tf.loadGraphModel(MODEL_URL, { fromTFHub: true });
    setBadge('AI 감지', 'text-green-400');
  } catch (e) {
    console.warn('model load failed — color-only mode', e);
    setBadge('색상 감지', 'text-yellow-400');
  }
}

function setBadge(text, colorClass) {
  const badge = document.getElementById('badge-ai');
  badge.textContent = text;
  badge.className = `text-[11px] px-2 py-0.5 rounded-md bg-black/60 ${colorClass}`;
}

/* ════════════════════════════════════
   카메라
════════════════════════════════════ */
async function startCamera(facing) {
  if (facing) camFacing = facing;
  setPhase('loading');
  document.getElementById('load-msg').textContent = '카메라 시작 중...';

  try {
    if (stream) stream.getTracks().forEach(t => t.stop());

    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: camFacing,
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
    });

    video.srcObject = stream;
    await new Promise(resolve => { video.onloadedmetadata = resolve; });
    video.play();

    setPhase('live');
    loadModel();
    startScan();
    startNightCheck();
  } catch (e) {
    setPhase('error');
    document.getElementById('err-msg').textContent =
      e.name === 'NotAllowedError'
        ? '카메라 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.'
        : '카메라를 사용할 수 없습니다: ' + e.message;
  }
}

/* ════════════════════════════════════
   색상 감지 (ROI 픽셀 평균)
════════════════════════════════════ */
function detectColor(ctx, box, W, H) {
  const [y1, x1, y2, x2] = box;
  const rx = Math.floor(x1 * W);
  const ry = Math.floor(y1 * H);
  const rw = Math.max(1, Math.floor((x2 - x1) * W));
  const rh = Math.max(1, Math.floor((y2 - y1) * H));

  let data;
  try { data = ctx.getImageData(rx, ry, rw, rh).data; } catch { return 'unknown'; }

  let r = 0, g = 0, b = 0, cnt = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]; g += data[i + 1]; b += data[i + 2]; cnt++;
  }
  if (!cnt) return 'unknown';
  r /= cnt; g /= cnt; b /= cnt;

  if (r > 140 && g < 100 && b < 100) return 'red';
  if (g > 120 && r < 130 && b < 100) return 'green';
  if (r > 160 && g > 140 && b < 90)  return 'amber';
  return 'unknown';
}

/* ════════════════════════════════════
   폴백: 픽셀 클러스터 탐색
════════════════════════════════════ */
function fallbackDetect(ctx, W, H) {
  const data = ctx.getImageData(0, 0, W, H).data;
  const rp = [], gp = [];

  for (let py = 0; py < H; py += 4) {
    for (let px = 0; px < W; px += 4) {
      const i = (py * W + px) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 180 && g < 80  && b < 80)  rp.push([px, py]);
      if (g > 160 && r < 100 && b < 100) gp.push([px, py]);
    }
  }

  const cluster = (pts, color) => {
    if (pts.length < 8) return null;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const x1 = Math.min(...xs) / W, y1 = Math.min(...ys) / H;
    const x2 = Math.max(...xs) / W, y2 = Math.max(...ys) / H;
    if ((x2 - x1) < 0.01 || (y2 - y1) < 0.01) return null;
    return { id: color, box: [y1, x1, y2, x2], score: 0.6, color };
  };

  return [cluster(rp, 'red'), cluster(gp, 'green')].filter(Boolean);
}

/* ════════════════════════════════════
   오버레이 박스 그리기
════════════════════════════════════ */
function drawBoxes(octx, detections, W, H) {
  octx.clearRect(0, 0, W, H);

  detections.forEach(det => {
    const [y1, x1, y2, x2] = det.box;
    const bx = x1 * W, by = y1 * H;
    const bw = (x2 - x1) * W, bh = (y2 - y1) * H;
    const color =
      det.color === 'red'   ? '#ff2200' :
      det.color === 'green' ? '#00ee44' : '#ffcc00';

    octx.strokeStyle = color;
    octx.lineWidth   = 3;
    octx.strokeRect(bx, by, bw, bh);

    // 모서리 강조
    const cs = 16;
    octx.lineWidth = 5;
    [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]]
      .forEach(([cx, cy], i) => {
        octx.beginPath();
        octx.moveTo(cx + (i % 2 === 0 ? cs : -cs), cy);
        octx.lineTo(cx, cy);
        octx.lineTo(cx, cy + (i < 2 ? cs : -cs));
        octx.stroke();
      });

    // 레이블
    const state = det.color === 'red' ? '정지' : det.color === 'green' ? '보행' : '신호등';
    octx.fillStyle = color;
    octx.font = `bold ${Math.max(12, bw * 0.18)}px system-ui, sans-serif`;
    octx.fillText(`${state} ${Math.round(det.score * 100)}%`, bx + 4, by - 6);
  });
}

/* ════════════════════════════════════
   하단 카드 렌더
════════════════════════════════════ */
function renderCards(detections) {
  const list  = document.getElementById('det-list');
  const empty = document.getElementById('det-empty');

  if (!detections.length) {
    empty.style.display = 'flex';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';

  list.innerHTML = detections.map((det, i) => {
    const isR    = det.color === 'red';
    const isG    = det.color === 'green';
    const accent = isR ? '#ff2200' : isG ? '#00ee44' : '#ffcc00';
    const label  = isR ? '정지'    : isG ? '보행'    : '신호등';
    const icon   = isR ? 'do_not_walk' : isG ? 'directions_walk' : 'traffic';
    return `
      <div class="det-card shrink-0 bg-neutral-900 rounded-xl px-4 py-2.5 text-center min-w-[100px] border border-neutral-700 cursor-pointer active:scale-95 transition-transform"
           data-i="${i}" style="border-color:${accent}">
        <span class="material-symbols-rounded block text-3xl leading-none mb-1.5"
              style="color:${accent}">${icon}</span>
        <div class="text-[15px] font-bold" style="color:${accent}">${label}</div>
        <div class="text-[11px] text-neutral-500 mt-0.5">
          ${Math.round(det.score * 100)}% &middot; 탭하여 확대
        </div>
      </div>`;
  }).join('');

  list._dets = detections;
  list.querySelectorAll('.det-card').forEach(el => {
    el.addEventListener('click', () => showFullscreen(list._dets[+el.dataset.i]));
  });
}

/* ════════════════════════════════════
   전체화면 표시
════════════════════════════════════ */
const PERSON_SVG = {
  green: `
    <ellipse cx="50" cy="28" rx="16" ry="18" fill="#003311"/>
    <ellipse cx="28" cy="62" rx="14" ry="20" fill="#003311"/>
    <ellipse cx="72" cy="62" rx="14" ry="20" fill="#003311"/>
    <rect    x="36"  y="55" width="28" height="28" rx="4" fill="#003311"/>
    <rect    x="42"  y="80" width="8"  height="18" rx="3" fill="#003311"/>
    <rect    x="50"  y="80" width="8"  height="18" rx="3" fill="#003311"/>`,
  red: `
    <ellipse cx="50" cy="28" rx="16" ry="18" fill="#330000"/>
    <ellipse cx="28" cy="62" rx="14" ry="20" fill="#330000"/>
    <ellipse cx="72" cy="62" rx="14" ry="20" fill="#330000"/>
    <rect    x="36"  y="55" width="28" height="28" rx="4" fill="#330000"/>
    <rect    x="42"  y="80" width="8"  height="18" rx="3" fill="#330000"/>
    <rect    x="50"  y="80" width="8"  height="18" rx="3" fill="#330000"/>`,
};

function showFullscreen(det) {
  const isR    = det.color === 'red';
  const isG    = det.color === 'green';
  const accent = isR ? '#ff2200' : isG ? '#00ee44' : '#888';
  const bg     = isR ? '#1a0000' : isG ? '#001a08' : '#0a0a0a';
  const label  = isR ? '정지'    : isG ? '보행'    : '감지중';

  const fs = document.getElementById('fs');
  fs.style.background = bg;
  fs.style.filter     = nightMode ? 'brightness(1.6) contrast(1.4) saturate(1.3)' : 'none';
  fs.classList.add('show');

  const sz = 'min(72vw, 72vh)';
  const circle = document.getElementById('fs-circle');
  Object.assign(circle.style, {
    width:      sz,
    height:     sz,
    background: accent,
    boxShadow:  `0 0 60px 20px ${accent}88, 0 0 120px 40px ${accent}44`,
    marginBottom: '6vh',
  });

  document.getElementById('fs-svg').innerHTML =
    isG ? PERSON_SVG.green : isR ? PERSON_SVG.red : '';
  document.getElementById('fs-svg').style.cssText = 'width:55%;height:55%';

  const lbl = document.getElementById('fs-label');
  Object.assign(lbl.style, {
    fontSize:      'min(18vw, 18vh)',
    color:         accent,
    textShadow:    `0 0 30px ${accent}`,
    letterSpacing: '-.02em',
    marginTop:     '4vh',
  });
  lbl.textContent = label;

  const sub = document.getElementById('fs-sub');
  Object.assign(sub.style, {
    marginTop: '3vh',
    fontSize:  'min(4vw, 4vh)',
  });
  sub.textContent = `신뢰도 ${Math.round(det.score * 100)}% \u00B7 화면을 탭하면 돌아갑니다`;

  if (navigator.vibrate) {
    navigator.vibrate(isR ? [100, 50, 100] : isG ? [200] : [50]);
  }
}

/* ════════════════════════════════════
   스캔 루프
════════════════════════════════════ */
function startScan() {
  clearInterval(scanTimer);

  scanTimer = setInterval(async () => {
    if (phase !== 'live')     return;
    if (video.readyState < 2) return;

    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H) return;

    proc.width    = W; proc.height    = H;
    overlay.width = W; overlay.height = H;

    const ctx  = proc.getContext('2d');
    const octx = overlay.getContext('2d');
    ctx.drawImage(video, 0, 0, W, H);

    let dets = [];

    // TF.js SSD 감지
    if (model && window.tf) {
      try {
        const imgT    = tf.browser.fromPixels(proc);
        const inp     = tf.expandDims(imgT, 0);
        const res     = await model.executeAsync(inp);
        const boxes   = await res[0].data();
        const scores  = await res[1].data();
        const classes = await res[2].data();
        tf.dispose([imgT, inp, ...res]);

        for (let i = 0; i < scores.length; i++) {
          if (classes[i] !== TL_CLASS) continue;
          if (scores[i]  <  MIN_SCORE) continue;
          const box = [boxes[i*4], boxes[i*4+1], boxes[i*4+2], boxes[i*4+3]];
          dets.push({ id: i, box, score: scores[i], color: detectColor(ctx, box, W, H) });
        }
      } catch (e) { console.warn('inference error', e); }
    }

    // 폴백
    if (!dets.length) dets = fallbackDetect(ctx, W, H);

    drawBoxes(octx, dets, W, H);
    renderCards(dets);

    scanline.style.display = dets.length ? 'none' : 'block';
  }, SCAN_MS);
}

/* ════════════════════════════════════
   야간 자동 감지
════════════════════════════════════ */
function startNightCheck() {
  setInterval(() => {
    if (phase !== 'live') return;
    if (!proc.width)      return;

    try {
      const ctx  = proc.getContext('2d');
      const data = ctx.getImageData(0, 0, proc.width, proc.height).data;
      let sum = 0, cnt = 0;
      for (let i = 0; i < data.length; i += 16) {
        sum += data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
        cnt++;
      }
      if (cnt) applyNight(sum / cnt < NIGHT_THR);
    } catch { /* cross-origin guard */ }
  }, 3000);
}

/* ════════════════════════════════════
   이벤트 바인딩
════════════════════════════════════ */
document.getElementById('btn-start').addEventListener('click', () => startCamera());
document.getElementById('btn-retry').addEventListener('click', () => startCamera());
document.getElementById('btn-night').addEventListener('click', () => applyNight(!nightMode));
document.getElementById('btn-flip').addEventListener('click',  () => {
  startCamera(camFacing === 'environment' ? 'user' : 'environment');
});
document.getElementById('fs').addEventListener('click', () => {
  const fs = document.getElementById('fs');
  fs.classList.remove('show');
  fs.style.display = 'none';
});
