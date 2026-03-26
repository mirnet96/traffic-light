import { initVision, startVision } from './vision.js';
import { initDataTab, fetchSignalData } from './api-data.js';

export function speak(text) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.2;
    window.speechSynthesis.speak(utterance);
}

function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        vTab.classList.add('active'); dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500";
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500";
        initDataTab();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
    document.getElementById('refresh-api').onclick = () => fetchSignalData();

    document.getElementById('start-btn').onclick = async () => {
        document.getElementById('boot-screen').style.display = 'none';
        speak("시스템 가동.");
        try {
            await initVision();
            startVision();
            initDataTab(); // 데이터 탭 초기화
        } catch (err) {
            console.error(err);
        }
    };
});
