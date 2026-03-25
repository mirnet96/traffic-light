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
    if(type === 'vision') {
        vTab.classList.add('active'); dTab.classList.remove('active');
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        initDataTab();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
    document.getElementById('refresh-api').onclick = () => fetchSignalData();
    document.getElementById('start-btn').onclick = async () => {
        document.getElementById('boot-screen').style.display = 'none';
        speak("시스템 가동. 분석을 시작합니다.");
        await initVision();
        startVision();
    };
});
