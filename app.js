/**
 * [ULTRA VISION AI] - app.js
 */
import { initVision, startVision } from './vision.js';
import { initDataTab, fetchSignalData } from './api-data.js';
import { speak } from './utils.js';

function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        vTab.classList.add('active');    dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500";
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500";
        initDataTab();
        // 탭이 보여진 뒤 카카오맵 relayout
        setTimeout(() => {
            if (window.kakaoMapInstance) {
                window.kakaoMapInstance.relayout();
            }
        }, 200);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const startBtn   = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');
    const refreshBtn = document.getElementById('refresh-api');

    if (startBtn) {
        startBtn.onclick = async () => {
            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            speak("울트라 비전 시스템을 시작합니다. 안전한 보행을 지원합니다.");
            try {
                await Promise.all([
                    initVision().then(() => startVision()),
                    initDataTab()
                ]);
            } catch (err) {
                console.error("System Initialization Failed:", err);
            }
        };
    }

    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
    if (refreshBtn) refreshBtn.onclick = () => fetchSignalData();
});
