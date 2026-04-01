/** [ULTRA VISION AI] - app.js
 *  [FIX] import 버전 쿼리 v2 → v3 (캐시 무효화)
 *  [KEEP] api-data.js 동적 import 안전 폴백 유지
 */
import { initVision, startCameraFirst, startVision, setVisionActive } from './vision.js?v=3';
import { speak } from './utils.js?v=3';

const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

let _initDataTab = () => {};
import('./api-data.js?v=3')
    .then(mod => {
        if (typeof mod.initDataTab === 'function') {
            _initDataTab = mod.initDataTab;
        } else {
            console.warn('[api-data.js] initDataTab export 없음 — 빈 함수로 대체');
        }
    })
    .catch(e => console.warn('[api-data.js] 로드 실패:', e.message));

let _systemStarted = false;

window.addEventListener('error', (e) => {
    console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno);
    if (!_systemStarted) _showError('JS오류: ' + e.message);
});
window.addEventListener('unhandledrejection', (e) => {
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
    if (btn) { btn.disabled = false; btn.innerText = '다시 시도'; }
}

function switchTab(type) {
    const vTab    = document.getElementById('vision-tab');
    const dTab    = document.getElementById('data-tab');
    const vBtn    = document.getElementById('tab-v-btn');
    const dBtn    = document.getElementById('tab-d-btn');
    const pCanvas = document.getElementById('preview-canvas');

    if (type === 'vision') {
        vTab.classList.add('active');
        dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(true);
        if (pCanvas) pCanvas.getContext('2d').filter = improvedFilter;
    } else {
        vTab.classList.remove('active');
        dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(false);
        _initDataTab();
        if (pCanvas) pCanvas.getContext('2d').filter = 'none';
        if (window.kakaoMapInstance) setTimeout(() => window.kakaoMapInstance.relayout(), 300);
    }
}

async function handleStart() {
    const startBtn   = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');
    const statusSub  = document.getElementById('status-sub');

    if (startBtn) startBtn.disabled = true;

    bootScreen.style.opacity = '0';
    setTimeout(() => { bootScreen.style.display = 'none'; }, 500);

    switchTab('vision');
    _updateMainStatus('LOADING');
    if (statusSub) statusSub.innerText = '카메라 초기화 중...';

    try {
        if (!('createImageBitmap' in window)) {
            throw new Error('createImageBitmap 미지원 브라우저');
        }

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
        if (startBtn) { startBtn.disabled = false; startBtn.innerText = '다시 시도'; }
        bootScreen.style.display = 'flex';
        bootScreen.style.opacity = '1';

        if (err.message === 'HTTPS_REQUIRED' || err.message === 'CAMERA_API_UNAVAILABLE') {
            if (statusSub) statusSub.innerText = 'HTTPS 필요 — 보안 연결로 접속해주세요';
        } else if (err.name === 'NotAllowedError') {
            if (statusSub) statusSub.innerText = '카메라 권한 거부됨 — 설정에서 허용해주세요';
        } else {
            if (statusSub) statusSub.innerText = '오류: ' + err.message;
        }
    }
}

function _updateMainStatus(text) {
    const main = document.getElementById('status-main');
    if (main) main.innerText = text;
}

window.__startVision = handleStart;
window.__switchTab   = switchTab;

function bindEvents() {
    const startBtn = document.getElementById('start-btn');
    const vBtn     = document.getElementById('tab-v-btn');
    const dBtn     = document.getElementById('tab-d-btn');
    if (startBtn && !startBtn._bound) {
        startBtn._bound = true;
        startBtn.addEventListener('click', handleStart, { once: true });
    }
    if (vBtn) vBtn.addEventListener('click', () => switchTab('vision'));
    if (dBtn) dBtn.addEventListener('click', () => switchTab('data'));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEvents);
} else {
    bindEvents();
}
window.addEventListener('load', () => {
    const btn = document.getElementById('start-btn');
    if (btn && !btn._bound) {
        btn._bound = true;
        btn.addEventListener('click', handleStart, { once: true });
    }
});
