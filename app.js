/** [ULTRA VISION AI] - app.js (iOS 카메라 수정본) */
import { initVision, startCameraFirst, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');
    const pCanvas = document.getElementById('preview-canvas');

    if (type === 'vision') {
        vTab.classList.add('active');
        dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(true);

        if (pCanvas) {
            const pCtx = pCanvas.getContext('2d');
            pCtx.filter = improvedFilter;
        }
    } else {
        vTab.classList.remove('active');
        dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        setVisionActive(false);
        initDataTab();

        if (pCanvas) {
            const pCtx = pCanvas.getContext('2d');
            pCtx.filter = 'none';
        }

        if (window.kakaoMapInstance) {
            setTimeout(() => window.kakaoMapInstance.relayout(), 300);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');
    const statusSub = document.getElementById('status-sub');

    if (startBtn) {
        startBtn.onclick = async () => {
            // [iOS 핵심 수정] 
            // 1단계: 버튼 터치 직후 즉시 카메라 권한 요청 (제스처 컨텍스트 유지)
            // 2단계: 카메라 켜는 동안 부팅 화면 유지 (모델 로딩 중 표시)
            // 3단계: 카메라 + 모델 준비 완료 후 탐지 시작

            // 부트 화면 숨기기
            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);

            // 비전 탭 UI 활성화
            switchTab('vision');

            // 상태 표시
            if (statusSub) statusSub.innerText = '카메라 초기화 중...';
            Renderer_updateStatus('LOADING');

            try {
                // [iOS 핵심] 
                // step 1: 터치 직후 즉시 카메라 권한 요청 (제스처 컨텍스트 살아있을 때)
                // step 2: 카메라 켜는 동안 모델도 병렬 로딩
                if (statusSub) statusSub.innerText = '카메라 연결 중...';

                const [cameraReady] = await Promise.all([
                    startCameraFirst(),
                    (async () => {
                        if (statusSub) statusSub.innerText = 'AI 모델 로딩 중... (최초 1회)';
                        await initVision({
                            minDetectionConfidence: 0.35,
                            minTrackingConfidence: 0.4
                        });
                    })()
                ]);

                // 둘 다 준비 완료 → 탐지 루프 시작
                if (statusSub) statusSub.innerText = '개선된 필터로 신호등을 찾고 있습니다';
                speak("울트라 비전 시스템을 시작합니다.");
                startVision();

            } catch (err) {
                console.error("[초기 구동 에러]:", err);

                // HTTPS 문제 → 부트화면 유지, 재시도 안내
                if (err.message === 'HTTPS_REQUIRED' || err.message === 'CAMERA_API_UNAVAILABLE') {
                    if (statusSub) statusSub.innerText = 'HTTPS 필요 — 보안 연결로 접속해주세요';
                    bootScreen.style.display = 'flex';
                    bootScreen.style.opacity = '1';
                    startBtn.innerText = '다시 시도';
                    return;
                }

                // 권한 거부 → 설정 안내 후 부트화면 복원
                if (err.name === 'NotAllowedError') {
                    if (statusSub) statusSub.innerText = '카메라 권한 거부됨 — 설정에서 허용해주세요';
                    bootScreen.style.display = 'flex';
                    bootScreen.style.opacity = '1';
                    startBtn.innerText = '다시 시도';
                    return;
                }

                // 기타 오류
                if (statusSub) statusSub.innerText = '오류: ' + err.message;
                bootScreen.style.display = 'flex';
                bootScreen.style.opacity = '1';
                startBtn.innerText = '다시 시도';
            }
        };
    }

    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
});

// vision-renderer의 updateStatusText를 app.js에서도 쓸 수 있도록 래핑
function Renderer_updateStatus(text) {
    const main = document.getElementById('status-main');
    if (main) main.innerText = text;
}
