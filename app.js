import { initVision, startVision } from './vision.js';
import { initDataTab, fetchSignalData } from './api-data.js';

/**
 * 시스템 통합 음성 출력 함수
 * 비전과 API 데이터 모두 이 함수를 통해 메시지를 출력합니다.
 */
export function speak(text) {
    // 이전 음성이 재생 중이면 취소하고 새로운 음성을 즉시 출력
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.2;
    window.speechSynthesis.speak(utterance);
}

/**
 * 탭 전환 로직 (UI 독립성 보장)
 */
function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');

    if (type === 'vision') {
        vTab.classList.add('active'); dTab.classList.remove('active');
        vBtn.classList.add('text-blue-400', 'border-b-4', 'border-blue-500');
        dBtn.classList.remove('text-blue-400', 'border-b-4', 'border-blue-500');
    } else {
        vTab.classList.remove('active'); dTab.classList.add('active');
        dBtn.classList.add('text-blue-400', 'border-b-4', 'border-blue-500');
        vBtn.classList.remove('text-blue-400', 'border-b-4', 'border-blue-500');
        
        // 데이터 탭 클릭 시에만 별도로 데이터 로드 시도
        try {
            initDataTab();
        } catch (e) {
            console.warn("API 데이터 모듈이 아직 준비되지 않았습니다.");
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // UI 이벤트 리스너
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
    document.getElementById('refresh-api').onclick = () => fetchSignalData();

    // 시스템 시작 버튼
    document.getElementById('start-btn').onclick = async () => {
        document.getElementById('boot-screen').style.display = 'none';
        speak("시스템 가동. 분석을 시작합니다.");

        // [트랙 1] 비전 시스템 초기화 및 실행 (완료된 기능)
        try {
            await initVision();
            startVision();
        } catch (err) {
            console.error("비전 시스템 시작 실패:", err);
        }

        // [트랙 2] API 데이터 초기화 (작업 중인 기능 - 실패해도 비전은 유지)
        try {
            initDataTab(); 
        } catch (err) {
            console.warn("V2X 데이터 모듈 대기 중...");
        }
    };
});
