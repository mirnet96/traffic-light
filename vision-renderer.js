/** [ULTRA VISION AI] - vision-renderer.js (기존 기능 + 줌 UI 표시) */

const SIGNAL_CONFIG = {
    RED:     { color: '#ef4444', label: '빨간불 · 정지',     glow: 'rgba(239,68,68,0.5)'  },
    GREEN:   { color: '#22c55e', label: '초록불 · 통행 가능', glow: 'rgba(34,197,94,0.5)'  },
    UNKNOWN: { color: '#71717a', label: '신호 분석 중...',    glow: 'transparent'           },
    LOADING: { color: '#3b82f6', label: '모델 로딩 중...',    glow: 'rgba(59,130,246,0.3)'  }
};

const ZOOM_UI_CONFIG = {
    WIDE: { color: '#3b82f6', label: 'WIDE (1x)' },
    MID:  { color: '#f59e0b', label: 'MID (2x)'  },
    TELE: { color: '#ec4899', label: 'TELE (4x)' }
};

let lastSignal = 'UNKNOWN';

export function drawUI(video, boxes, currentZoom) {
    const previewCanvas = document.getElementById('preview-canvas');
    if (!previewCanvas) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    previewCanvas.width = W;
    previewCanvas.height = H;

    const ctx = previewCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. 카메라 배경 렌더링
    ctx.drawImage(video, 0, 0, W, H);

    // 2. 우측 상단 현재 스캔 모드 표시
    if (currentZoom) {
        const ui = ZOOM_UI_CONFIG[currentZoom.label];
        const text = `SCAN: ${ui.label}`;
        ctx.font = 'bold 13px Inter, sans-serif';
        const tw = ctx.measureText(text).width;

        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.beginPath();
        ctx.roundRect(W - tw - 35, 25, tw + 20, 28, 14);
        ctx.fill();

        ctx.fillStyle = ui.color;
        ctx.fillText(text, W - tw - 25, 44);
    }

    // 3. 탐지 박스 렌더링
    boxes.forEach(box => {
        const scaleX = W / video.videoWidth;
        const scaleY = H / video.videoHeight;
        const sx = box.x * scaleX, sy = box.y * scaleY;
        const sw = box.w * scaleX, sh = box.h * scaleY;

        const uiColor = ZOOM_UI_CONFIG[box.zoomLabel]?.color || '#fff';

        ctx.strokeStyle = uiColor;
        ctx.lineWidth = 3;
        ctx.strokeRect(sx, sy, sw, sh);

        // 박스 상단 모드/확률 라벨
        ctx.fillStyle = uiColor;
        const labelText = `${box.zoomLabel} ${Math.round(box.score * 100)}%`;
        const lw = ctx.measureText(labelText).width;
        ctx.fillRect(sx - 1.5, sy - 20, lw + 10, 20);

        ctx.fillStyle = '#000';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(labelText, sx + 3, sy - 6);
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
