/** [ULTRA VISION AI] - vision-renderer.js */
import { speak } from './utils.js';

let audioCtx = null, beepTimer = null;

export function drawUI(ctx, box, color, vW, vH) {
    if (!box) return;
    
    const colors = { RED: '#FF3B30', GREEN: '#34C759', UNKNOWN: '#FFD60A' };
    const c = colors[color] || '#FFFFFF';
    
    // 1. 메인 박스 (부드러운 디자인)
    ctx.strokeStyle = c;
    ctx.lineWidth = 5;
    ctx.lineJoin = "round";
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    
    // 2. 우측 상단 ROI 미리보기 그리기 (이동이 적도록 고정 위치 권장)
    const roiCanvas = document.getElementById('roi-canvas');
    if (roiCanvas) {
        const rCtx = roiCanvas.getContext('2d');
        roiCanvas.width = 120; roiCanvas.height = 200;
        // 원본 영상에서 해당 박스 영역을 따와서 그림
        rCtx.drawImage(document.getElementById('webcam'), box.x, box.y, box.w, box.h, 0, 0, 120, 200);
    }
}

export function updateStatusText(color) {
    const el = document.getElementById('api-status-text');
    if (!el) return;
    el.innerText = color;
    el.style.color = color === 'RED' ? '#FF3B30' : (color === 'GREEN' ? '#34C759' : '#555');
}

export function playFeedback(color, lastColor) {
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
