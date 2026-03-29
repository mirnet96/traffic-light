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
        roiCanvas.width = 300; 
        roiCanvas.height = 600; 

        rCtx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
        
        const video = document.getElementById('webcam');
        if (video && video.readyState >= 2) {
            rCtx.drawImage(
                video, 
                box.x, box.y, box.w, box.h,
                0, 0, roiCanvas.width, roiCanvas.height
            );
        }
    }
}

export function updateStatusText(color) {
    const el = document.getElementById('api-status-text');
    if (!el) return;
    
    // [BUG4 FIX] 'READY' 케이스 명시적 처리 추가
    if (color === 'READY') {
        el.innerText = "READY";
        el.style.color = "#71717a";
    } else if (color === 'UNKNOWN') {
        el.innerText = "DETECTED";
        el.style.color = "#3b82f6";
    } else {
        el.innerText = color;
        el.style.color = color === 'RED' ? '#FF3B30' : '#34C759';
    }
}

export function playFeedback(color, lastColor) {
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
