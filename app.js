/** [ULTRA VISION AI] - app.js 수정본 */
import { initVision, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');

    if (startBtn) {
        startBtn.onclick = async () => {
            console.log("System initialization started...");
            
            // 1. 오디오 컨텍스트 활성화
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const dummyCtx = new AudioContext();
            if (dummyCtx.state === 'suspended') {
                await dummyCtx.resume();
            }

            // 2. 화면 전환
            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            speak("울트라 비전 시스템을 시작합니다.");
            
            try {
                // 3. 비전 시스템 초기화 (개별 에러 핸들링)
                console.log("Loading Vision Model...");
                await initVision();
                
                console.log("Starting Camera...");
                await startVision();
                
                console.log("Initializing Data Tab...");
                await initDataTab();
                
                console.log("System Ready.");
            } catch (err) { 
                console.error("Initialization failed:", err);
                alert("시스템 초기화 중 오류가 발생했습니다: " + err.message);
            }
        };
    }
    
    // 탭 전환 버튼 연결
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');
    if (vBtn) vBtn.onclick = () => switchTab('vision');
    if (dBtn) dBtn.onclick = () => switchTab('data');
});

function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        vTab.classList.add('active'); dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500";
        setVisionActive(true);
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500";
        setVisionActive(false);
        if (window.kakaoMapInstance) window.kakaoMapInstance.relayout();
    }
}

