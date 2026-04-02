/** [ULTRA VISION AI] - app.js v5
 *  [FIX] visibilitychange → hidden 시 setVisionActive(false), visible 시 재시작
 *  [NEW] Screen Wake Lock — VISION 탭 활성 시 획득, 전환/백그라운드 시 해제
 *  [KEEP] _handleStarting 중복 호출 방지, _bindStartBtn 단일 등록
 *  [KEEP] catch diag-banner 표시
 */
import { initVision, startCameraFirst, startVision, setVisionActive } from './vision.js?v=5';
import { speak } from './utils.js?v=5';

const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

let _initDataTab    = () => {};
let _handleStarting = false;
let _systemStarted  = false;
let _wakeLock       = null;       // [NEW] Wake Lock 핸들

import('./api-data.js?v=5')
    .then(mod => {
        if (typeof mod.initDataTab === 'function') _initDataTab = mod.initDataTab;
        else console.warn('[api-data.js] initDataTab export 없음');
    })
    .catch(e => console.warn('[api-data.js] 로드 실패:', e.message));

// ─────────────────────────────────────────────
// Wake Lock
// ─────────────────────────────────────────────
async function _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        _wakeLock = await navigator.wakeLock.request('screen');
        _wakeLock.addEventListener('release', () => { _wakeLock = null; });
        console.log('[WakeLock] 획득');
    } catch (e) {
        console.warn('[WakeLock] 획득 실패:', e.message);
    }
}
function _releaseWakeLock() {
    if (_wakeLock) { _wakeLock.release(); _wakeLock = null; console.log('[WakeLock] 해제'); }
}

// ─────────────────────────────────────────────
// visibilitychange — 백그라운드 절전
// ─────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (!_systemStarted) return;
    if (document.hidden) {
        setVisionActive(false);
        _releaseWakeLock();
    } else {
        setVisionActive(true);
        _acquireWakeLock();
    }
});

// ─────────────────────────────────────────────
// 전역 에러 핸들러
// ─────────────────────────────────────────────
window.addEventListener('error', e => {
    console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno);
    if (!_systemStarted) _showError('JS오류: ' + e.message);
});
window.addEventListener('unhandledrejection', e => {
    console.error('[UNHANDLED PROMISE]', e.reason);
    if (!_systemStarted) _showError('Promise오류: ' + (e.reason?.message || String(e.reason)));
});

function _showError(msg) {
    const sub  = document.getElementById('status-sub');
    const boot = document.getElementById('boot-screen');
    const btn  = document.getElementById('start-btn');
    if (sub)  sub.innerText = msg;
    if (boot && boot.style.display === 'none') { boot.style.display = 'flex'; boot.style.opacity = '1'; }
    if (btn)  { btn.disabled = false; btn.innerText = '다시 시도'; _bindStartBtn(btn); }
}

// ─────────────────────────────────────────────
// 탭 전환
// ─────────────────────────────────────────────
function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');
    const pCvs = document.getElementById('preview-canvas');

    if (type === 'vision') {
        vTab.classList.add('active');    dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(true);
        if (pCvs) pCvs.getContext('2d').filter = improvedFilter;
        if (_systemStarted) _acquireWakeLock();
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(false);
        _releaseWakeLock();
        _initDataTab();
        if (pCvs) pCvs.getContext('2d').filter = 'none';
        if (window.kakaoMapInstance) setTimeout(() => window.kakaoMapInstance.relayout(), 600);
    }
}

// ─────────────────────────────────────────────
// 시스템 시작
// ─────────────────────────────────────────────
async function handleStart() {
    if (_handleStarting) return;
    _handleStarting = true;

    const startBtn   = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');
    const statusSub  = document.getElementById('status-sub');

    if (startBtn) { startBtn.disabled = true; startBtn.onclick = null; }
    bootScreen.style.opacity = '0';
    setTimeout(() => { bootScreen.style.display = 'none'; }, 500);

    switchTab('vision');
    _updateMainStatus('LOADING');
    if (statusSub) statusSub.innerText = '카메라 초기화 중...';

    try {
        if (!('createImageBitmap' in window)) throw new Error('createImageBitmap 미지원 브라우저');
        if (statusSub) statusSub.innerText = '카메라 연결 중...';

        await Promise.all([
            startCameraFirst(),
            (async () => {
                if (statusSub) statusSub.innerText = 'AI 모델 로딩 중... (최초 1회)';
                await initVision();
            })()
        ]);

        if (statusSub) statusSub.innerText = '신호등을 찾고 있습니다';
        _systemStarted = true;
        await _acquireWakeLock();   // [NEW]
        speak('GREEN');             // 시작음: "초록불, 통행 가능" 대신 직접 멘트 필요 시 별도 처리
        startVision();

    } catch (err) {
        console.error('[초기 구동 에러]:', err);
        _handleStarting = false;
        if (startBtn) { startBtn.disabled = false; startBtn.innerText = '다시 시도'; _bindStartBtn(startBtn); }
        bootScreen.style.display = 'flex'; bootScreen.style.opacity = '1';

        const diag = document.getElementById('diag-banner');
        if (diag) { diag.style.display = 'block'; diag.innerText = `❌ [${err.name}] ${err.message}`; }

        if (err.message === 'HTTPS_REQUIRED')   { if (statusSub) statusSub.innerText = 'HTTPS 필요 — 보안 연결로 접속해주세요'; }
        else if (err.name === 'NotAllowedError') { if (statusSub) statusSub.innerText = '카메라 권한 거부됨 — 설정에서 허용해주세요'; }
        else                                     { if (statusSub) statusSub.innerText = `[${err.name}] ${err.message}`; }
    }
}

function _updateMainStatus(t) { const el = document.getElementById('status-main'); if (el) el.innerText = t; }

function _bindStartBtn(btn) {
    if (!btn) return;
    btn.onclick = null;
    btn.removeEventListener('click', handleStart);
    btn.addEventListener('click', handleStart);
    btn._bound = true;
}

window.__startVision = handleStart;
window.__switchTab   = switchTab;

function bindEvents() {
    _bindStartBtn(document.getElementById('start-btn'));
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');
    if (vBtn) vBtn.addEventListener('click', () => switchTab('vision'));
    if (dBtn) dBtn.addEventListener('click', () => switchTab('data'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindEvents);
else bindEvents();
window.addEventListener('load', () => { const b = document.getElementById('start-btn'); if (b && !b._bound) _bindStartBtn(b); });
