/** [ULTRA VISION AI] - app.js */
import { initVision, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        // 1. 시각적 활성화
        vTab.classList.add('active');
        dTab.classList.remove('active');
        
        // 2. 버튼 스타일 변경
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        
        // 3. 비전 로직 가동
        setVisionActive(true);
        console.log("Vision Mode Activated");
    } else {
        // 1. 시각적 활성화
        vTab.classList.remove('active');
        dTab.classList.add('active');
        
        // 2. 버튼 스타일 변경
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        
        // 3. 비전 로직 중지 (자원 절약)
        setVisionActive(false);
        initDataTab(); // V2X 데이터 로드
        console.log("V2X Mode Activated (Vision Paused)");

        if (window.kakaoMapInstance) {
            setTimeout(() => window.kakaoMapInstance.relayout(), 300);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');

    if (startBtn) {
        startBtn.onclick = async () => {
            // 시스템 시작 안내
            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            speak("울트라 비전 시스템을 시작합니다.");
            
            // [중요] 시작 시점에 무조건 vision 탭으로 초기화
            switchTab('vision');

            try {
                await initVision();  // 모델 로드
                await startVision(); // 카메라 시작
            } catch (err) {
                console.error("초기 구동 에러:", err);
            }
        };
    }

    // 탭 버튼 클릭 이벤트 바인딩
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('vision'); // 오타 주의: 'data'로 되어있는지 확인
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
});
