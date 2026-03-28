/** [ULTRA VISION AI] - vision-renderer.js */
import { speak } from './utils.js';

let audioCtx = null, beepTimer = null;

export function drawUI(ctx, box, color, vW, vH) {
    if (!box) return;
    
    // 1. 상단 메인 캠 화면에 박스 그리기
    const colors = { RED: '#FF3B30', GREEN: '#34C759', UNKNOWN: '#3b82f6' };
    const c = colors[color] || '#3b82f6';
    
    ctx.strokeStyle = c;
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    
    // 2. 하단 ROI 전용 캔버스 업데이트 (신호등만 꽉 차게)
    const roiCanvas = document.getElementById('roi-canvas');
    if (roiCanvas) {
        const rCtx = roiCanvas.getContext('2d');
        // 캔버스 크기를 신호등 비율에 맞게 설정 (보통 세로가 김)
        roiCanvas.width = 300; 
        roiCanvas.height = 600; 

        rCtx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
        
        // 원본 비디오에서 탐지된 box 영역만 추출하여 roiCanvas 전체에 그림
        const video = document.getElementById('webcam');
        if (video && video.readyState >= 2) {
            rCtx.drawImage(
                video, 
                box.x, box.y, box.w, box.h, // 소스 영역 (탐지된 박스)
                0, 0, roiCanvas.width, roiCanvas.height // 대상 영역 (캔버스 전체)
            );
        }
    }
}

export function updateStatusText(color) {
    const el = document.getElementById('api-status-text');
    if (!el) return;
    
    if (color === 'UNKNOWN') {
        el.innerText = "DETECTED";
        el.style.color = "#3b82f6";
    } else {
        el.innerText = color;
        el.style.color = color === 'RED' ? '#FF3B30' : '#34C759';
    }
}

export function playFeedback(color, lastColor) {
    // 색상 판별이 비활성화되었으므로 피드백 로직도 현재는 대기
    if (color === 'UNKNOWN') return; 
    
    if (color === lastColor) return;
    if (color === 'RED') {
        speak("빨간불입니다.");
        startBeep(440, 1200);
    } else if (color === 'GREEN') {
        speak("초록불입니다.");
        startBeep(880, 500);
    } else {
        stopBeep();
    }
}

function startBeep(f, i) {
    stopBeep();
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    beepTimer = setInterval(() => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.value = f;
        g.gain.setTargetAtTime(0.1, audioCtx.currentTime, 0.02);
        o.start(); o.stop(audioCtx.currentTime + 0.1);
    }, i);
}

export function stopBeep() {
    if (beepTimer) clearInterval(beepTimer);
}
