/** [ULTRA VISION AI] - app.js 수정본 */
import { initVision, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

// 탭 전환 함수 개선
function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        // 비전 탭 활성화
        vTab.classList.add('active');
        dTab.classList.remove('active');
        
        // 버튼 스타일 (Tailwind)
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500";
        
        // 카메라 로직 활성화
        setVisionActive(true);
    } else {
        // 데이터(V2X) 탭 활성화
        vTab.classList.remove('active');
        dTab.classList.add('active');
        
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500";
        
        // 카메라 로직 비활성화 (성능 최적화)
        setVisionActive(false);
        initDataTab();
        
        if (window.kakaoMapInstance) {
            setTimeout(() => window.kakaoMapInstance.relayout(), 200);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');

    if (startBtn) {
        startBtn.onclick = async () => {
            // 부트 스크린 제거
            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            
            speak("울트라 비전 시스템을 시작합니다.");
            
            // 1. 초기 시작 시 무조건 'vision' 탭이 활성화되도록 강제 설정
            switchTab('vision');

            try {
                // 2. 비전 엔진 및 카메라 구동
                await initVision();
                await startVision();
                
                // 3. 백그라운드에서 데이터 미리 준비
                initDataTab();
                
            } catch (err) {
                console.error("시스템 시작 실패:", err);
                alert("카메라 혹은 모델 로드 실패: " + err.message);
            }
        };
    }

    // 버튼 이벤트 바인딩
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
});
