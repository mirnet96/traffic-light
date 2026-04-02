/** [ULTRA VISION AI] - app.js v4
 *  [FIX] handleStart 중복 호출 방지 (_handleStarting 플래그)
 *  [FIX] once:true + 인라인 onclick 충돌 제거 → _bindStartBtn() 단일 등록
 *  [FIX] 실패 시 _handleStarting 해제 → 다시시도 정상 동작
 *  [FIX] catch에 diag-banner 표시로 에러 원인 즉시 확인
 */
import { initVision, startCameraFirst, startVision, setVisionActive } from './vision.js?v=4';
import { speak } from './utils.js?v=4';

const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

let _initDataTab    = () => {};
let _handleStarting = false;
let _systemStarted  = false;

import('./api-data.js?v=4')
    .then(mod => {
        if (typeof mod.initDataTab === 'function') _initDataTab = mod.initDataTab;
        else console.warn('[api-data.js] initDataTab export 없음');
    })
    .catch(e => console.warn('[api-data.js] 로드 실패:', e.message));

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
    if (boot && boot.style.display === 'none') {
        boot.style.display = 'flex';
        boot.style.opacity = '1';
    }
    if (btn) { btn.disabled = false; btn.innerText = '다시 시도'; _bindStartBtn(btn); }
}

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
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(false);
        _initDataTab();
        if (pCvs) pCvs.getContext('2d').filter = 'none';
        // [FIX] iOS 지도 찌그러짐 → relayout 타이밍 600ms
        if (window.kakaoMapInstance) setTimeout(() => window.kakaoMapInstance.relayout(), 600);
    }
}

async function handleStart() {
    if (_handleStarting) return;   // 중복 호출 차단
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

        if (statusSub) statusSub.innerText = '개선된 필터로 신호등을 찾고 있습니다';
        _systemStarted = true;
        speak('울트라 비전 시스템을 시작합니다.');
        startVision();

    } catch (err) {
        console.error('[초기 구동 에러]:', err);
        _handleStarting = false;   // 재시도 가능하도록 해제

        if (startBtn) { startBtn.disabled = false; startBtn.innerText = '다시 시도'; _bindStartBtn(startBtn); }
        bootScreen.style.display = 'flex';
        bootScreen.style.opacity = '1';

        const diag = document.getElementById('diag-banner');
        if (diag) { diag.style.display = 'block'; diag.innerText = `❌ [${err.name}] ${err.message}`; }

        if (err.message === 'HTTPS_REQUIRED') {
            if (statusSub) statusSub.innerText = 'HTTPS 필요 — 보안 연결로 접속해주세요';
        } else if (err.name === 'NotAllowedError') {
            if (statusSub) statusSub.innerText = '카메라 권한 거부됨 — 설정에서 허용해주세요';
        } else {
            if (statusSub) statusSub.innerText = `[${err.name}] ${err.message}`;
        }
    }
}

function _updateMainStatus(t) {
    const el = document.getElementById('status-main');
    if (el) el.innerText = t;
}

// 중복 등록 방지 + 인라인 onclick 완전 제거
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

window.addEventListener('load', () => {
    const btn = document.getElementById('start-btn');
    if (btn && !btn._bound) _bindStartBtn(btn);
});
