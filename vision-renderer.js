/** [ULTRA VISION AI] - vision-renderer.js */

const SIGNAL_CONFIG = {
    RED:     { color: '#ef4444', label: '빨간불 · 정지',     glow: 'rgba(239,68,68,0.5)'  },
    GREEN:   { color: '#22c55e', label: '초록불 · 통행 가능', glow: 'rgba(34,197,94,0.5)'  },
    UNKNOWN: { color: '#71717a', label: '신호 분석 중...',    glow: 'transparent'           },
    LOADING: { color: '#3b82f6', label: '모델 로딩 중...',    glow: 'rgba(59,130,246,0.3)'  }
};

const ZOOM_COLOR = {
    WIDE: '#3b82f6', // 파랑
    MID:  '#f59e0b', // 주황
    TELE: '#ec4899'  // 핑크
};

let lastSignal = 'UNKNOWN';

export function drawUI(video, boxes, currentZoom) {
    const canvas = document.getElementById('preview-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;

    // 1. 카메라 배경 렌더링
    ctx.drawImage(video, 0, 0, W, H);

    // 2. 현재 줌 레벨 표시 (우측 상단)
    if (currentZoom) {
        const label = `SCAN MODE: ${currentZoom.label}`;
        ctx.font = 'bold 14px Inter, sans-serif';
        const metrics = ctx.measureText(label);
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.roundRect(W - metrics.width - 30, 20, metrics.width + 20, 30, 15);
        ctx.fill();
        
        ctx.fillStyle = ZOOM_COLOR[currentZoom.label] || '#fff';
        ctx.fillText(label, W - metrics.width - 20, 40);
    }

    // 3. 탐지된 신호등 박스 및 라벨 렌더링
    boxes.forEach(box => {
        // 비디오 좌표(1280x720 가정)를 화면 크기에 맞게 스케일링
        const scaleX = W / video.videoWidth;
        const scaleY = H / video.videoHeight;
        
        const screenX = box.x * scaleX;
        const screenY = box.y * scaleY;
        const screenW = box.w * scaleX;
        const screenH = box.h * scaleY;

        // 박스 그리기
        ctx.strokeStyle = ZOOM_COLOR[box.zoomLabel] || '#fff';
        ctx.lineWidth = 4;
        ctx.strokeRect(screenX, screenY, screenW, screenH);

        // 줌 라벨 그리기
        ctx.fillStyle = ZOOM_COLOR[box.zoomLabel] || '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(`${box.zoomLabel} (${Math.round(box.score * 100)}%)`, screenX, screenY - 10);
    });
}

export function updateStatusText(status) {
    const main = document.getElementById('status-main');
    if (main) main.innerText = status;
}

export function updateSignalStatus(signal) {
    if (signal === lastSignal) return;
    lastSignal = signal;

    const cfg = SIGNAL_CONFIG[signal] || SIGNAL_CONFIG.UNKNOWN;
    const main = document.getElementById('status-main');
    if (main) {
        main.innerText = signal;
        main.style.color = cfg.color;
        main.style.textShadow = `0 0 40px ${cfg.glow}`;
    }

    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = cfg.label;
}
