/**
 * [ULTRA VISION AI] - app.js
 * 전체 시스템 흐름 제어 및 음성 합성(TTS) 관리
 */
import { initVision, startVision } from './vision.js';
import { initDataTab, fetchSignalData } from './api-data.js';

let isSpeaking = false;

/**
 * 1. 음성 안내 함수 (중복 방지 및 대기열 관리)
 */
export function speak(text) {
    if (isSpeaking) window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.1;
    utterance.pitch = 1.0;

    utterance.onstart = () => { isSpeaking = true; };
    utterance.onend = () => { isSpeaking = false; };
    
    window.speechSynthesis.speak(utterance);
}

/**
 * 2. 탭 전환 로직 (비전 vs 데이터)
 */
function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        vTab.classList.add('active');
        dTab.classList.remove('active');
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500";
    } else {
        vTab.classList.remove('active');
        dTab.classList.add('active');
        dBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        vBtn.className = "flex-1 py-4 font-black text-zinc-500";
        // 데이터 탭으로 올 때 지도가 깨질 수 있으므로 위치 갱신 호출
        initDataTab();
    }
}

/**
 * 3. 초기 진입 버튼 및 이벤트 바인딩
 */
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-btn');
    const bootScreen = document.getElementById('boot-screen');
    const refreshBtn = document.getElementById('refresh-api');

    if (startBtn) {
        startBtn.onclick = async () => {
            bootScreen.style.opacity = '0';
            setTimeout(() => { bootScreen.style.display = 'none'; }, 500);
            
            speak("울트라 비전 시스템을 시작합니다. 안전한 보행을 지원합니다.");

            try {
                // 비전과 데이터 시스템 병렬 초기화
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
