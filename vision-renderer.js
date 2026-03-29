/** [ULTRA VISION AI] - vision-renderer.js */
import { speak } from './utils.js';

let audioCtx = null, beepTimer = null;

/*
 * 저시력자 전용 전체화면 ROI 모드
 *
 * [미감지 상태]
 *   - preview-canvas: 카메라 원본을 전체화면으로 표시
 *   - roi-canvas: 숨김
 *   - 배경: 어두운 색 유지
 *   - 상태 텍스트: "READY"
 *
 * [감지 상태]
 *   - preview-canvas: 숨김
 *   - roi-canvas: 신호등 영역을 전체화면으로 확대
 *   - color-overlay: RED/GREEN 판별 시 반투명 색상 오버레이
 *   - 상태 텍스트: "RED" / "GREEN" / "DETECTED"
 */

export function drawUI(ctx, box, color) {
    if (!box) return;

    // webcam-canvas 에는 내부 연산용 박스만 그림 (화면에 표시 안됨)
    const colors = { RED: '#FF3B30', GREEN: '#34C759', UNKNOWN: '#3b82f6' };
    const c = colors[color] || '#3b82f6';
    ctx.strokeStyle = c;
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    // 신호등 감지 상태: ROI 전체화면 확대
    const previewCanvas = document.getElementById('preview-canvas');
    const roiCanvas     = document.getElementById('roi-canvas');
    const overlay       = document.getElementById('color-overlay');

    if (!roiCanvas || !previewCanvas) return;

    const video = document.getElementById('webcam');
    if (!video || video.readyState < 2) return;

    // preview 숨기고 ROI 표시
    previewCanvas.style.display = 'none';
    roiCanvas.style.display = 'block';

    const W = roiCanvas.clientWidth  || window.innerWidth;
    const H = roiCanvas.clientHeight || window.innerHeight;
    roiCanvas.width  = W;
    roiCanvas.height = H;

    const rCtx = roiCanvas.getContext('2d');
    rCtx.fillStyle = '#000';
    rCtx.fillRect(0, 0, W, H);

    // 신호등 박스 비율 유지하며 전체화면에 letterbox 방식으로 그림
    const srcRatio = box.w / box.h;
    const dstRatio = W / H;
    let drawW, drawH, drawX, drawY;

    if (srcRatio > dstRatio) {
        drawW = W;
        drawH = W / srcRatio;
        drawX = 0;
        drawY = (H - drawH) / 2;
    } else {
        drawH = H;
        drawW = H * srcRatio;
        drawX = (W - drawW) / 2;
        drawY = 0;
    }

    rCtx.drawImage(video, box.x, box.y, box.w, box.h, drawX, drawY, drawW, drawH);

    // 색상 오버레이: RED/GREEN 판별 시 화면 전체에 반투명 색 입힘
    if (overlay) {
        if (color === 'RED') {
            overlay.style.background = '#FF3B30';
            overlay.style.opacity = '0.25';
        } else if (color === 'GREEN') {
            overlay.style.background = '#34C759';
            overlay.style.opacity = '0.25';
        } else {
            overlay.style.opacity = '0';
        }
    }
}

// 미감지 상태: 카메라 원본을 preview-canvas 에 전체화면으로 표시
export function drawPreview(video) {
    const previewCanvas = document.getElementById('preview-canvas');
    const roiCanvas     = document.getElementById('roi-canvas');
    const overlay       = document.getElementById('color-overlay');

    if (!previewCanvas || !video || video.readyState < 2) return;

    roiCanvas.style.display  = 'none';
    previewCanvas.style.display = 'block';
    if (overlay) overlay.style.opacity = '0';

    const W = previewCanvas.clientWidth  || window.innerWidth;
    const H = previewCanvas.clientHeight || window.innerHeight;
    previewCanvas.width  = W;
    previewCanvas.height = H;

    const pCtx = previewCanvas.getContext('2d');

    // 원본 비율 유지하며 cover 방식으로 그림
    const vRatio = video.videoWidth / video.videoHeight;
    const cRatio = W / H;
    let sx, sy, sw, sh;

    if (vRatio > cRatio) {
        sh = video.videoHeight;
        sw = sh * cRatio;
        sx = (video.videoWidth - sw) / 2;
        sy = 0;
    } else {
        sw = video.videoWidth;
        sh = sw / cRatio;
        sx = 0;
        sy = (video.videoHeight - sh) / 2;
    }

    pCtx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
}

export function updateStatusText(color) {
    const main = document.getElementById('status-main');
    const sub  = document.getElementById('status-sub');
    if (!main || !sub) return;

    if (color === 'READY') {
        main.innerText = 'READY';
        main.style.color = '#71717a';
        sub.innerText = '신호등을 찾고 있습니다';
    } else if (color === 'UNKNOWN') {
        main.innerText = 'DETECTED';
        main.style.color = '#3b82f6';
        sub.innerText = '신호등을 감지했습니다';
    } else if (color === 'RED') {
        main.innerText = 'RED';
        main.style.color = '#FF3B30';
        sub.innerText = '빨간불 - 멈추세요';
    } else if (color === 'GREEN') {
        main.innerText = 'GREEN';
        main.style.color = '#34C759';
        sub.innerText = '초록불 - 건너세요';
    }
}

export function playFeedback(color, lastColor) {
    if (color === 'UNKNOWN') return;
    if (color === lastColor) return;

    if (color === 'RED') {
        speak("빨간불입니다. 멈추세요.");
        startBeep(440, 1200);
    } else if (color === 'GREEN') {
        speak("초록불입니다. 건너세요.");
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
