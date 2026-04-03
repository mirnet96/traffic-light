import { loadModel, runYolo }     from './detector.js';
import { drawBoxes, renderCards } from './renderer.js';

/* ── 상수 ── */
const SCAN_MS   = 120;
const NIGHT_THR = 60;

/* ── PiP 크기 ── */
const PIP_SM = { w: 120, h: 80  };
const PIP_LG = { w: 200, h: 130 };

/* ── 탐색 중 순환 텍스트 ── */
const SCAN_MSGS = [
  '신호등을 탐색 중입니다...',
  '카메라를 신호등 방향으로 향해 주세요',
  '건너편 신호등을 찾고 있습니다...',
  '멀리 있는 신호등도 감지합니다',
];
let scanMsgIdx  = 0;
let scanMsgTimer = null;

/* ── DOM 참조 ── */
const video     = document.getElementById('video');
const proc      = document.getElementById('proc');
const overlay   = document.getElementById('overlay');
const scanline  = document.getElementById('scanline');
const scanBadge = document.getElementById('badge-scan');
const pip       = document.getElementById('pip');

/* ── 상태 ── */
let stream     = null;
let scanTimer  = null;  // setTimeout 기반
let nightTimer = null;
let nightMode  = false;
let camFacing  = 'environment';
let phase      = 'init';
let lastVW     = 0, lastVH = 0;
let pipLarge   = false;

/* ── fps 측정 ── */
let fpsFrames   = 0;
let fpsLastTime = 0;
let fpsValue    = 0;

/* ── proc ctx (willReadFrequently) ── */
const procCtx = proc.getContext('2d', { willReadFrequently: true });
const pipCtx  = pip.getContext('2d');

/* ════════════════════════════════════
   UI 헬퍼
════════════════════════════════════ */
function setPhase(p) {
  phase = p;
  // ★ Tailwind hidden 클래스 충돌 방지 — style.display 로만 제어
  const show = (id, on, dtype = 'flex') =>
    document.getElementById(id).style.display = on ? dtype : 'none';
  show('init-screen',    p === 'init',    'flex');
  show('loading-screen', p === 'loading', 'flex');
  show('error-screen',   p === 'error',   'flex');
  show('bottombar',      p === 'live',    'block');
  show('btn-flip',       p === 'live',    'flex');
  scanline.style.display = p === 'live' ? 'block' : 'none';
  pip.style.display      = p === 'live' ? 'block' : 'none';

  if (p === 'live') {
    scanBadge.style.display = '';
    scanBadge.textContent   = '탐색 중';
    scanBadge.classList.remove('detected');
    scanBadge.classList.add('scan-pulse');
    applyPipSize();
    startScanMsgCycle();  // 텍스트 순환 시작
    fpsFrames   = 0;
    fpsLastTime = performance.now();
  } else {
    scanBadge.style.display = 'none';
    stopScanMsgCycle();
  }
}

function applyNight(on) {
  nightMode = on;
  video.className = `w-full h-full object-cover block ${on ? 'night' : 'day'}`;
  const btn = document.getElementById('btn-night');
  document.getElementById('night-label').textContent = on ? 'ON' : '야간';
  on ? btn.classList.add('on') : btn.classList.remove('on');
  btn.querySelector('.material-symbols-rounded').textContent =
    on ? 'light_mode' : 'dark_mode';
}

function setBadge(text, cls) {
  const b = document.getElementById('badge-ai');
  b.textContent = text;
  b.className = `text-[11px] px-2 py-0.5 rounded-md bg-black/60 ${cls}`;
}

function updateScanBadge(signals) {
  if (signals.length > 0) {
    scanBadge.textContent = `감지 ${signals.length}건`;
    scanBadge.classList.add('detected');
    scanBadge.classList.remove('scan-pulse');
  } else {
    scanBadge.textContent = `탐색 중 · ${fpsValue}fps`;
    scanBadge.classList.remove('detected');
    scanBadge.classList.add('scan-pulse');
  }
}

/* ── 탐색 중 텍스트 순환 ── */
function startScanMsgCycle() {
  stopScanMsgCycle();
  scanMsgIdx = 0;
  renderScanMsg();
  scanMsgTimer = setInterval(() => {
    // 감지 중에는 텍스트 교체 안 함
    if (document.getElementById('det-empty').style.display === 'none') return;
    scanMsgIdx = (scanMsgIdx + 1) % SCAN_MSGS.length;
    renderScanMsg();
  }, 3500);
}

function stopScanMsgCycle() {
  clearInterval(scanMsgTimer);
  scanMsgTimer = null;
}

function renderScanMsg() {
  const el = document.getElementById('det-empty');
  // fade 효과: 투명 → 불투명
  el.style.transition = 'opacity 0.4s';
  el.style.opacity    = '0';
  setTimeout(() => {
    el.querySelector('.scan-msg-text').textContent = SCAN_MSGS[scanMsgIdx];
    el.style.opacity = '1';
  }, 400);
}

/* ── fps 갱신 (1초마다) ── */
function tickFps() {
  fpsFrames++;
  const now  = performance.now();
  const diff = now - fpsLastTime;
  if (diff >= 1000) {
    fpsValue    = Math.round(fpsFrames * 1000 / diff);
    fpsFrames   = 0;
    fpsLastTime = now;
    // 탐색 중일 때만 배지 갱신 (감지 중엔 덮어쓰지 않음)
    if (!scanBadge.classList.contains('detected')) {
      scanBadge.textContent = `탐색 중 · ${fpsValue}fps`;
    }
  }
}

/* ════════════════════════════════════
   PiP
════════════════════════════════════ */
function applyPipSize() {
  const sz = pipLarge ? PIP_LG : PIP_SM;
  pip.width  = sz.w;
  pip.height = sz.h;
}

function drawPip() {
  if (phase !== 'live' || !proc.width || !proc.height) return;
  const sz = pipLarge ? PIP_LG : PIP_SM;
  pipCtx.drawImage(proc, 0, 0, sz.w, sz.h);
  pipCtx.drawImage(overlay, 0, 0, sz.w, sz.h);
  const detected = scanBadge.classList.contains('detected');
  pipCtx.strokeStyle = detected ? '#00ee44' : '#3b82f6';
  pipCtx.lineWidth   = 1.5;
  pipCtx.strokeRect(0.75, 0.75, sz.w - 1.5, sz.h - 1.5);
  // fps를 PiP 우하단에 표시
  pipCtx.fillStyle = 'rgba(0,0,0,0.55)';
  pipCtx.fillRect(sz.w - 34, sz.h - 14, 34, 14);
  pipCtx.fillStyle = '#94a3b8';
  pipCtx.font      = 'bold 9px system-ui,sans-serif';
  pipCtx.fillText(`${fpsValue}fps`, sz.w - 30, sz.h - 4);
  // 좌상단 라벨
  pipCtx.fillStyle = 'rgba(0,0,0,0.55)';
  pipCtx.fillRect(0, 0, 36, 14);
  pipCtx.fillStyle = detected ? '#4ade80' : '#93c5fd';
  pipCtx.fillText(detected ? '감지됨' : '탐색중', 3, 10);
}

/* ════════════════════════════════════
   카메라
════════════════════════════════════ */
async function startCamera(facing) {
  if (facing) camFacing = facing;
  setPhase('loading');
  document.getElementById('load-msg').textContent = '카메라 시작 중...';

  // ★ 디버그: 진입 확인
  const dbg = (m) => {
    let el = document.getElementById('debug-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'debug-overlay';
      Object.assign(el.style, {
        position:'fixed', top:'60px', left:'0', right:'0',
        background:'rgba(0,0,0,0.82)', color:'#0f0',
        fontSize:'11px', fontFamily:'monospace', padding:'8px',
        zIndex:'99999', whiteSpace:'pre-wrap', wordBreak:'break-all',
        maxHeight:'40vh', overflowY:'auto',
      });
      el.addEventListener('click', () => el.remove());
      document.body.appendChild(el);
    }
    el.textContent += m + '\n';
  };

  try {
    dbg('[cam] startCamera');
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    dbg('[cam] getUserMedia OK');
    video.srcObject = stream;
    await new Promise(r => { video.onloadedmetadata = r; });
    video.play();
    dbg('[cam] video playing');
    await loadModel(
      t => { document.getElementById('load-msg').textContent = t; dbg('[cam] ' + t); },
      setBadge
    );
    dbg('[cam] model loaded → setPhase live');
    setPhase('live');
    startScan();
    startNightCheck();
  } catch (e) {
    dbg(`[cam] ERROR: ${e.name} ${e.message}`);
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
  clearTimeout(scanTimer);  // ★ clearTimeout으로 변경

  async function loop() {
    if (phase !== 'live') return;  // live 아니면 루프 종료

    if (video.readyState >= 2) {
      const W = video.videoWidth, H = video.videoHeight;
      if (W && H) {
        if (W !== lastVW || H !== lastVH) {
          proc.width    = W; proc.height    = H;
          overlay.width = W; overlay.height = H;
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
        renderCards(signals, showFullscreen);
        scanline.style.display = signals.length ? 'none' : 'block';
        drawPip();
      }
    }

    // ★ 완료 후 다음 프레임 예약 — 중첩 실행 없음
    scanTimer = setTimeout(loop, SCAN_MS);
  }

  loop();  // 즉시 첫 프레임 시작
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
      if (cnt) applyNight(sum / cnt < NIGHT_THR);
    } catch { /* cross-origin guard */ }
  }, 3000);
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

function showFullscreen(sig) {
  const isPed  = sig.isPedestrian;
  const accent = isPed ? '#00ee44' : '#ffcc00';
  const bg     = isPed ? '#001a08' : '#1a1500';
  const label  = isPed ? '보행신호' : '신호등';
  const range  = sig.range === 'near' ? '근거리' : '원거리';

  const fs = document.getElementById('fs');
  fs.style.background = bg;
  fs.style.filter     = nightMode ? 'brightness(1.6) contrast(1.4) saturate(1.3)' : 'none';
  fs.style.display    = '';
  fs.classList.add('show');

  const sz = 'min(72vw, 72vh)';
  Object.assign(document.getElementById('fs-circle').style, {
    width: sz, height: sz, background: accent, marginBottom: '6vh',
    boxShadow: `0 0 60px 20px ${accent}88, 0 0 120px 40px ${accent}44`,
  });
  document.getElementById('fs-svg').innerHTML     = isPed ? PERSON_SVG.walk : PERSON_SVG.stop;
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

/* ════════════════════════════════════
   이벤트
════════════════════════════════════ */
document.getElementById('btn-start').addEventListener('click', () => startCamera());
document.getElementById('btn-retry').addEventListener('click', () => startCamera());
document.getElementById('btn-night').addEventListener('click', () => applyNight(!nightMode));
document.getElementById('btn-flip').addEventListener('click',  () =>
  startCamera(camFacing === 'environment' ? 'user' : 'environment'));
document.getElementById('fs').addEventListener('click', () => {
  document.getElementById('fs').classList.remove('show');
});
pip.addEventListener('click', () => {
  pipLarge = !pipLarge;
  applyPipSize();
});
