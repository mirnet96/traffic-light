'use strict';

/* ── 상수 ── */
const SCAN_MS   = 120;
const NIGHT_THR = 60;

/* ── DOM 참조 ── */
const video    = document.getElementById('video');
const proc     = document.getElementById('proc');
const overlay  = document.getElementById('overlay');
const scanline = document.getElementById('scanline');

/* ── 상태 ── */
let stream    = null;
let scanTimer = null;
let nightMode = false;
let camFacing = 'environment';
let phase     = 'init';

/* ════════════════════════════════════
   UI
════════════════════════════════════ */
function setPhase(p) {
  phase = p;
  const show = (id, on, dtype = 'flex') =>
    document.getElementById(id).style.display = on ? dtype : 'none';
  show('init-screen',    p === 'init');
  show('loading-screen', p === 'loading');
  show('error-screen',   p === 'error');
  show('bottombar',      p === 'live', 'block');
  show('btn-flip',       p === 'live', 'flex');
  scanline.style.display = p === 'live' ? 'block' : 'none';
}

function applyNight(on) {
  nightMode = on;
  video.className = `w-full h-full object-cover block ${on ? 'night' : 'day'}`;
  const btn = document.getElementById('btn-night');
  document.getElementById('night-label').textContent = on ? '야간 ON' : '야간 OFF';
  on ? btn.classList.add('on') : btn.classList.remove('on');
  btn.querySelector('.material-symbols-rounded').textContent =
    on ? 'light_mode' : 'dark_mode';
}

function setBadge(text, cls) {
  const b = document.getElementById('badge-ai');
  b.textContent = text;
  b.className = `text-[11px] px-2 py-0.5 rounded-md bg-black/60 ${cls}`;
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
      video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    video.play();
    setPhase('live');
    await loadModel(t => document.getElementById('load-msg').textContent = t, setBadge);
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
   스캔 루프
════════════════════════════════════ */
function startScan() {
  clearInterval(scanTimer);
  scanTimer = setInterval(async () => {
    if (phase !== 'live' || video.readyState < 2) return;
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return;

    proc.width = W; proc.height = H;
    overlay.width = W; overlay.height = H;
    proc.getContext('2d').drawImage(video, 0, 0, W, H);

    const dets    = await runYolo(proc, W, H);
    const signals = classifySignals(dets);
    drawBoxes(overlay.getContext('2d'), signals, W, H);
    renderCards(signals, showFullscreen);
    scanline.style.display = signals.length ? 'none' : 'block';
  }, SCAN_MS);
}

/* ════════════════════════════════════
   야간 자동 감지
════════════════════════════════════ */
function startNightCheck() {
  setInterval(() => {
    if (phase !== 'live' || !proc.width) return;
    try {
      const data = proc.getContext('2d').getImageData(0, 0, proc.width, proc.height).data;
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
   전체화면
════════════════════════════════════ */
function showFullscreen(sig) {
  const isPed  = sig.isPedestrian;
  const accent = isPed ? '#00ee44' : '#ffcc00';
  const bg     = isPed ? '#001a08' : '#1a1500';
  const label  = isPed ? '보행신호' : '신호등';
  const range  = sig.range === 'near' ? '근거리' : '원거리';

  const fs = document.getElementById('fs');
  fs.style.background = bg;
  fs.style.filter     = nightMode ? 'brightness(1.6) contrast(1.4) saturate(1.3)' : 'none';
  fs.classList.add('show');

  const sz = 'min(72vw, 72vh)';
  Object.assign(document.getElementById('fs-circle').style, {
    width: sz, height: sz, background: accent, marginBottom: '6vh',
    boxShadow: `0 0 60px 20px ${accent}88, 0 0 120px 40px ${accent}44`,
  });

  document.getElementById('fs-svg').innerHTML   = isPed ? PERSON_SVG.walk : PERSON_SVG.stop;
  document.getElementById('fs-svg').style.cssText = 'width:55%;height:55%';

  Object.assign(document.getElementById('fs-label').style, {
    fontSize: 'min(14vw,14vh)', color: accent, marginTop: '4vh',
    textShadow: `0 0 30px ${accent}`, letterSpacing: '-.02em',
  });
  document.getElementById('fs-label').textContent = label;

  Object.assign(document.getElementById('fs-sub').style, {
    marginTop: '2vh', fontSize: 'min(4vw,4vh)',
  });
  document.getElementById('fs-sub').textContent =
    `${range} \u00B7 신뢰도 ${Math.round(sig.score * 100)}% \u00B7 탭하면 돌아갑니다`;

  if (navigator.vibrate) navigator.vibrate(isPed ? [200] : [100, 50, 100]);
}

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

/* ════════════════════════════════════
   이벤트
════════════════════════════════════ */
document.getElementById('btn-start').addEventListener('click', () => startCamera());
document.getElementById('btn-retry').addEventListener('click', () => startCamera());
document.getElementById('btn-night').addEventListener('click', () => applyNight(!nightMode));
document.getElementById('btn-flip').addEventListener('click',  () =>
  startCamera(camFacing === 'environment' ? 'user' : 'environment'));
document.getElementById('fs').addEventListener('click', () => {
  const fs = document.getElementById('fs');
  fs.classList.remove('show');
  fs.style.display = 'none';
});
