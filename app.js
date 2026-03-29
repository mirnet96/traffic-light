/** [ULTRA VISION AI] - app.js */
import { initVision, startVision, setVisionActive } from './vision.js';
import { initDataTab, fetchSignalData } from './api-data.js';
import { speak } from './utils.js';

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
        initDataTab();
        setTimeout(() => { if (window.kakaoMapInstance) window.kakaoMapInstance.relayout(); }, 200);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');

    if (startBtn) {
        startBtn.onclick = async () => {
            // 브라우저 오디오 컨텍스트 활성화를 위해 더미 사운드 재생 시도
            const dummyCtx = new (window.AudioContext || window.webkitAudioContext)();
            dummyCtx.resume();

            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            speak("울트라 비전 시스템을 시작합니다.");
            
            try {
                await Promise.all([initVision().then(() => startVision()), initDataTab()]);
            } catch (err) { console.error(err); }
        };
    }
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
});
