/** [ULTRA VISION AI] - app.js (수정본) */
import { initVision, startVision, setVisionActive } from './vision.js';
import { initDataTab } from './api-data.js';
import { speak } from './utils.js';

// **필터 인스턴스 미리 생성 (성능 최적화)**
// contrast(1.4): 대비 40% 증가 (흐릿한 신호등 윤곽 강조)
// saturate(1.2): 채도 20% 증가 (신호등 색상 뚜렷하게)
// brightness(1.1): 밝기 10% 증가 (어두운 객체 식별 보조)
const improvedFilter = 'contrast(1.4) saturate(1.2) brightness(1.1)';

function switchTab(type) {
    const vTab = document.getElementById('vision-tab');
    const dTab = document.getElementById('data-tab');
    const vBtn = document.getElementById('tab-v-btn');
    const dBtn = document.getElementById('tab-d-btn');
    
    // **미리 캔버스 컨텍스트 가져오기 (탭 전환 시 초기 필터 적용)**
    const pCanvas = document.getElementById('preview-canvas');
    const pCtx = pCanvas.getContext('2d');

    if (type === 'vision') {
        // 1. 시각적 활성화
        vTab.classList.add('active');
        dTab.classList.remove('active');
        
        // 2. 버튼 스타일 변경
        vBtn.className = "flex-1 py-4 font-black text-blue-400 border-b-4 border-blue-500";
        dBtn.className = "flex-1 py-4 font-black text-zinc-500 border-b-4 border-transparent";
        
        // 3. 비전 로직 가동
        setVisionActive(true);
        console.log("Vision Mode Activated with Improved Filters");

        // **비전 탭 활성화 시 기본 필터 적용 (첫 프레임 대비)**
        pCtx.filter = improvedFilter;

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

        // **데이터 탭으로 전환 시 비전 캔버스 필터 초기화 (자원 낭비 방지)**
        pCtx.filter = 'none';

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
            speak("울트라 비전 시스템을 시작합니다. 영상 품질이 개선되었습니다.");
            
            // [중요] 시작 시점에 무조건 vision 탭으로 초기화
            switchTab('vision');

            try {
                // **임계값 조정을 위해 initVision에 설정값 전달**
                // minDetectionConfidence: 0.5 -> 0.35 (감지 신뢰도 대폭 하향)
                // minTrackingConfidence: 0.5 -> 0.4 (추적 신뢰도 소폭 하향)
                await initVision({
                    minDetectionConfidence: 0.35,
                    minTrackingConfidence: 0.4
                });  
                await startVision(); // 카메라 시작
            } catch (err) {
                console.error("초기 구동 에러:", err);
            }
        };
    }

    // 탭 버튼 클릭 이벤트 바인딩 (오타 수정됨)
    document.getElementById('tab-v-btn').onclick = () => switchTab('vision');
    // document.getElementById('tab-d-btn').onclick = () => switchTab('vision'); // 오타 주의: 'data'로 되어있는지 확인
    document.getElementById('tab-d-btn').onclick = () => switchTab('data');
});
