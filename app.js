/** [ULTRA VISION AI] - app.js */
import { initVision, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js'; // fetchSignalData 제거 (미사용 시)
import { speak } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');

    if (startBtn) {
        startBtn.onclick = async () => {
            console.log("시작 버튼 클릭됨");
            
            // 오디오 권한 획득
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const audioCtx = new AudioContext();
            if (audioCtx.state === 'suspended') await audioCtx.resume();

            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            
            speak("울트라 비전 시스템을 시작합니다.");
            
            try {
                // 하나씩 순차적으로 실행하여 에러 지점 파악
                console.log("1. 비전 초기화 시작");
                await initVision();
                
                console.log("2. 카메라 시작");
                await startVision();
                
                console.log("3. 데이터 탭 초기화");
                await initDataTab();
                
                console.log("모든 시스템 준비 완료");
            } catch (err) {
                console.error("시스템 시작 실패:", err);
                alert("오류 발생: " + err.message);
            }
        };
    }

    // 탭 전환 버튼 이벤트 연결
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
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
