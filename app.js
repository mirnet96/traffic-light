/** [ULTRA VISION AI] - app.js
 *  [FIX] 안드로이드 삼성인터넷/크롬 ES Module 로딩 실패 근본 해결
 *  - import 구문 유지하되, 모든 초기화를 window.onload 기반으로 이동
 *  - 버튼 바인딩을 inline onclick + JS 이중 구조로 이중 보험
 *  - 전역 에러 핸들러로 무반응 원인 화면에 표시
 */
import { initVision, startCameraFirst, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

// ── 전역 에러 → 화면에 표시 (무반응 원인 파악) ──────────────
window.addEventListener('error', (e) => {
    console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno);
    _showError('JS오류: ' + e.message);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[UNHANDLED PROMISE]', e.reason);
    _showError('Promise오류: ' + (e.reason?.message || String(e.reason)));
});

function _showError(msg) {
    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = msg;
    // 부트화면이 숨겨졌을 경우 다시 표시
    const boot = document.getElementById('boot-screen');
    if (boot && boot.style.display === 'none') {
        boot.style.display = 'flex';
        boot.style.opacity = '1';
    }
    const btn = document.getElementById('start-btn');
    if (btn) { btn.disabled = false; btn.innerText = '다시 시도'; }
}

// ── switchTab ────────────────────────────────────────────────
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
        initDataTab();
        if (pCanvas) pCanvas.getContext('2d').filter = 'none';
        if (window.kakaoMapInstance) setTimeout(() => window.kakaoMapInstance.relayout(), 300);
    }
}

// ── handleStart ──────────────────────────────────────────────
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
        if (!('OffscreenCanvas' in window)) {
            console.warn('[WARN] OffscreenCanvas 미지원 → canvas 폴백 사용');
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
        speak("울트라 비전 시스템을 시작합니다.");
        startVision();

    } catch (err) {
        console.error("[초기 구동 에러]:", err);
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

// ── 이벤트 바인딩
// [FIX] window.onload 사용: DOMContentLoaded보다 늦게 실행되어
//       모듈 파싱이 완전히 끝난 뒤 바인딩 보장
// [FIX] window.__startVision 전역 노출: index.html의 onclick 폴백과 연결
// ─────────────────────────────────────────────────────────────
window.__startVision = handleStart;  // index.html onclick 폴백용 전역 함수

function bindEvents() {
    const startBtn = document.getElementById('start-btn');
    const vBtn     = document.getElementById('tab-v-btn');
    const dBtn     = document.getElementById('tab-d-btn');

    if (startBtn) {
        startBtn.addEventListener('click', handleStart, { once: true });
    }
    if (vBtn) vBtn.addEventListener('click', () => switchTab('vision'));
    if (dBtn) dBtn.addEventListener('click', () => switchTab('data'));
}

// readyState 분기 + window.onload 이중 보험
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEvents);
} else {
    bindEvents();
}
// window.onload: 모듈이 defer 실행되어 위 두 경우 모두 놓쳤을 때 최후 보루
window.addEventListener('load', () => {
    const btn = document.getElementById('start-btn');
    // 이미 바인딩됐으면 onclick만 보험으로 추가
    if (btn && !btn._bound) {
        btn._bound = true;
        btn.addEventListener('click', handleStart, { once: true });
    }
});
