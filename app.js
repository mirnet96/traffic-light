/** [ULTRA VISION AI] - app.js
 *  [FIX] 삼성 인터넷(Android) 호환성 수정
 *  1. DOMContentLoaded 대신 readyState 체크 후 즉시 바인딩
 *  2. startBtn.onclick → addEventListener 방식으로 변경
 *  3. 전역 에러 핸들러 추가 (무반응 원인 콘솔 노출)
 *  4. createImageBitmap / OffscreenCanvas 사전 지원 여부 체크
 */
import { initVision, startCameraFirst, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

// ── 전역 에러 캐치: 삼성 인터넷에서 무반응 원인 파악용 ──
window.addEventListener('error', (e) => {
    console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno);
    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = '오류: ' + e.message;
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('[UNHANDLED PROMISE]', e.reason);
    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = '오류: ' + (e.reason?.message || e.reason);
});

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

async function handleStart() {
    const startBtn   = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');
    const statusSub  = document.getElementById('status-sub');

    // 중복 클릭 방지
    if (startBtn) startBtn.disabled = true;

    bootScreen.style.opacity = '0';
    setTimeout(() => { bootScreen.style.display = 'none'; }, 500);

    switchTab('vision');

    Renderer_updateStatus('LOADING');
    if (statusSub) statusSub.innerText = '카메라 초기화 중...';

    try {
        // [FIX] createImageBitmap 지원 여부 사전 확인
        if (!('createImageBitmap' in window)) {
            throw new Error('이 브라우저는 createImageBitmap을 지원하지 않습니다.');
        }

        // [FIX] OffscreenCanvas 미지원 시 경고만 출력 후 계속 진행
        //       (vision.js analyzeAndShowSignal 에서 폴백 처리)
        if (!('OffscreenCanvas' in window)) {
            console.warn('[WARN] OffscreenCanvas 미지원 → preview-canvas 폴백 사용');
        }

        if (statusSub) statusSub.innerText = '카메라 연결 중...';

        const [cameraReady] = await Promise.all([
            startCameraFirst(),
            (async () => {
                if (statusSub) statusSub.innerText = 'AI 모델 로딩 중... (최초 1회)';
                await initVision({
                    minDetectionConfidence: 0.35,
                    minTrackingConfidence:  0.4
                });
            })()
        ]);

        if (statusSub) statusSub.innerText = '개선된 필터로 신호등을 찾고 있습니다';
        speak("울트라 비전 시스템을 시작합니다.");
        startVision();

    } catch (err) {
        console.error("[초기 구동 에러]:", err);

        if (startBtn) {
            startBtn.disabled  = false;
            startBtn.innerText = '다시 시도';
        }
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

// ── [FIX] DOMContentLoaded 대신 readyState 즉시 체크 ──────────
// type="module" 스크립트는 defer처럼 동작하므로 DOMContentLoaded가
// 이미 지난 뒤 실행될 수 있음 → readyState로 분기 처리
function bindEvents() {
    const startBtn = document.getElementById('start-btn');
    const vBtn     = document.getElementById('tab-v-btn');
    const dBtn     = document.getElementById('tab-d-btn');

    if (startBtn) {
        // [FIX] onclick 직접 할당 대신 addEventListener (삼성 인터넷 호환)
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

function Renderer_updateStatus(text) {
    const main = document.getElementById('status-main');
    if (main) main.innerText = text;
}
