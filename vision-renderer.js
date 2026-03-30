/** [ULTRA VISION AI] - vision-renderer.js (신호 상태 UI 추가) */

const SIGNAL_CONFIG = {
    RED:     { color: '#ef4444', label: '빨간불 · 정지',    glow: 'rgba(239,68,68,0.5)' },
    GREEN:   { color: '#22c55e', label: '초록불 · 통행 가능', glow: 'rgba(34,197,94,0.5)'  },
    UNKNOWN: { color: '#71717a', label: '신호 분석 중...',   glow: 'transparent'           },
    LOADING: { color: '#3b82f6', label: '모델 로딩 중...',   glow: 'rgba(59,130,246,0.3)'  }
};

let lastSignal = 'UNKNOWN';

export function drawUI(video, box) {
    const roiCanvas = document.getElementById('roi-canvas');
    const previewCanvas = document.getElementById('preview-canvas');
    if (!roiCanvas || !previewCanvas) return;

    previewCanvas.style.display = 'none';
    roiCanvas.style.display = 'block';

    const W = window.innerWidth;
    const H = window.innerHeight;
    roiCanvas.width = W;
    roiCanvas.height = H;

    const ctx = roiCanvas.getContext('2d');

    // 신호등 ROI 전체화면 확대
    ctx.drawImage(
        video,
        box.x, box.y, box.w, box.h,
        0, 0, W, H
    );

    // 탐지 박스 표시 (원래 비디오 위에 오버레이)
    // 화면 내 상대 위치 계산
    const scaleX = W / video.videoWidth;
    const scaleY = H / video.videoHeight;
    ctx.strokeStyle = SIGNAL_CONFIG[lastSignal]?.color || '#fff';
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x * scaleX, box.y * scaleY, box.w * scaleX, box.h * scaleY);
}

export function drawPreview(video) {
    const previewCanvas = document.getElementById('preview-canvas');
    const roiCanvas = document.getElementById('roi-canvas');
    if (!previewCanvas || !roiCanvas) return;

    roiCanvas.style.display = 'none';
    previewCanvas.style.display = 'block';

    const W = window.innerWidth;
    const H = window.innerHeight;
    previewCanvas.width = W;
    previewCanvas.height = H;

    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, W, H);
}

export function updateStatusText(status) {
    const main = document.getElementById('status-main');
    if (main) main.innerText = status;
}

/**
 * [신규] 신호 분석 결과를 UI에 반영
 * - 상태 텍스트 색상 변경
 * - 색상 오버레이 flash
 */
export function updateSignalStatus(signal) {
    if (signal === lastSignal) return; // 변화 없으면 스킵
    lastSignal = signal;

    const cfg = SIGNAL_CONFIG[signal] || SIGNAL_CONFIG.UNKNOWN;

    // 메인 상태 텍스트
    const main = document.getElementById('status-main');
    if (main) {
        main.innerText = signal;
        main.style.color = cfg.color;
        main.style.textShadow = `0 0 40px ${cfg.glow}, 0 4px 20px rgba(0,0,0,0.9)`;
    }

    // 서브 텍스트
    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = cfg.label;

    // 색상 오버레이 flash (RED/GREEN만)
    if (signal === 'RED' || signal === 'GREEN') {
        const overlay = document.getElementById('color-overlay');
        if (overlay) {
            overlay.style.backgroundColor = cfg.color;
            overlay.style.opacity = '0.15';
            setTimeout(() => { overlay.style.opacity = '0'; }, 400);
        }
    }
}
