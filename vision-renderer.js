/** [ULTRA VISION AI] - vision-renderer.js */
import { speak } from './utils.js';

let audioCtx = null;
let beepTimer = null;

export function drawDetection(ctx, box, color) {
    const colors = { RED: '#FF3B30', GREEN: '#34C759', UNKNOWN: '#FFD60A' };
    ctx.strokeStyle = colors[color] || '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    
    ctx.fillStyle = colors[color];
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(color, box.x, box.y - 10);
}

export function provideFeedback(color, lastColor) {
    if (color === lastColor) return;

    if (color === 'RED') {
        speak("빨간불입니다. 멈추세요.");
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        playBeep(440, 1000); // 낮은 음, 느린 반복
    } else if (color === 'GREEN') {
        speak("초록불입니다. 건너가세요.");
        if (navigator.vibrate) navigator.vibrate([50, 50, 50, 50, 50]);
        playBeep(880, 400); // 높은 음, 빠른 반복
    } else {
        stopBeep();
    }
}

function playBeep(freq, interval) {
    stopBeep();
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    beepTimer = setInterval(() => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        osc.start(); osc.stop(audioCtx.currentTime + 0.1);
    }, interval);
}

export function stopBeep() {
    if (beepTimer) { clearInterval(beepTimer); beepTimer = null; }
}
