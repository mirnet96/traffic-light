/** [ULTRA VISION AI] - vision-renderer.js (점진적 줌 + 화질 개선) */

const SIGNAL_CONFIG = {
    RED:     { color: '#ef4444', label: '빨간불 · 정지',     glow: 'rgba(239,68,68,0.5)'  },
    GREEN:   { color: '#22c55e', label: '초록불 · 통행 가능', glow: 'rgba(34,197,94,0.5)'  },
    UNKNOWN: { color: '#71717a', label: '신호 분석 중...',    glow: 'transparent'           },
    LOADING: { color: '#3b82f6', label: '모델 로딩 중...',    glow: 'rgba(59,130,246,0.3)'  }
};

let lastSignal  = 'UNKNOWN';
let currentZoom = 0;        // 현재 화면에 적용 중인 zoom (0 ~ 1)
let targetZoom  = 0;        // 목표 zoom
const ZOOM_STEP = 0.04;     // 프레임당 보간 속도 (클수록 빠름)
const ZOOM_OUT_STEP = 0.06; // 신호 사라질 때 더 빠르게 복귀

export function drawUI(video, box) {
    const roiCanvas     = document.getElementById('roi-canvas');
    const previewCanvas = document.getElementById('preview-canvas');
    if (!roiCanvas || !previewCanvas) return;

    previewCanvas.style.display = 'none';
    roiCanvas.style.display     = 'block';

    const W = window.innerWidth;
    const H = window.innerHeight;
    roiCanvas.width  = W;
    roiCanvas.height = H;

    const ctx = roiCanvas.getContext('2d');

    // ★ 고화질 보간 설정 (깨짐 방지 핵심)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // ★ 탐지 신뢰도(score)에 따라 목표 zoom 결정
    const score = box.score || 0;
    if (score >= 0.5)       targetZoom = 1.0;   // 고신뢰 → 풀 줌
    else if (score >= 0.2)  targetZoom = 0.5;   // 중간 신뢰 → 반 줌
    else                    targetZoom = 0.15;  // 저신뢰 → 살짝만

    // ★ 부드러운 zoom 보간 (매 프레임 ZOOM_STEP씩 이동)
    if (currentZoom < targetZoom) {
        currentZoom = Math.min(currentZoom + ZOOM_STEP, targetZoom);
    } else {
        currentZoom = Math.max(currentZoom - ZOOM_STEP, targetZoom);
    }

    if (currentZoom < 0.05) {
        // zoom 거의 0 → 전체 프리뷰만
        ctx.drawImage(video, 0, 0, W, H);
        return;
    }

    // ★ 배경: 전체 영상을 어둡게 처리 (블러 + 어두움)
    ctx.globalAlpha = 1;
    ctx.filter = 'blur(6px) brightness(0.35)';
    ctx.drawImage(video, 0, 0, W, H);
    ctx.filter = 'none';

    // ★ ROI 영역 계산 (padding 포함)
    //    원본 비디오 해상도 기준으로 잘라서 확대 → 깨짐 최소화
    const vW = video.videoWidth;
    const vH = video.videoHeight;

    const padding = Math.max(box.w, box.h) * 0.4;
    const srcX = Math.max(0, box.x - padding);
    const srcY = Math.max(0, box.y - padding);
    const srcW = Math.min(vW - srcX, box.w + padding * 2);
    const srcH = Math.min(vH - srcY, box.h + padding * 2);

    // 화면에 채울 크기 (zoom 값에 따라 결정)
    const fillRatio = 0.4 + currentZoom * 0.55; // zoom 0→1 시 화면의 40%~95% 차지
    const scale = Math.min((W * fillRatio) / srcW, (H * fillRatio) / srcH);
    const dstW  = srcW * scale;
    const dstH  = srcH * scale;
    const dstX  = (W - dstW) / 2;
    const dstY  = (H - dstH) / 2;

    // ★ 신호등 테두리 (확대 창 테두리)
    const signalColor = SIGNAL_CONFIG[lastSignal]?.color || '#ffffff';
    ctx.globalAlpha = currentZoom * 0.8;
    ctx.strokeStyle = signalColor;
    ctx.lineWidth   = 3;
    ctx.shadowColor = signalColor;
    ctx.shadowBlur  = 12;
    ctx.strokeRect(dstX - 2, dstY - 2, dstW + 4, dstH + 4);
    ctx.shadowBlur = 0;

    // ★ ROI 영상 그리기 (원본 해상도 → 확대, 고화질 보간)
    ctx.globalAlpha = Math.min(1, currentZoom * 1.5); // 서서히 나타남
    ctx.drawImage(video, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
    ctx.globalAlpha = 1;
}

export function drawPreview(video) {
    // ★ 신호 사라질 때 zoom 빠르게 복귀
    if (currentZoom > 0) {
        currentZoom = Math.max(0, currentZoom - ZOOM_OUT_STEP);
    }
    targetZoom = 0;

    const previewCanvas = document.getElementById('preview-canvas');
    const roiCanvas     = document.getElementById('roi-canvas');
    if (!previewCanvas || !roiCanvas) return;

    roiCanvas.style.display     = 'none';
    previewCanvas.style.display = 'block';

    const W = window.innerWidth;
    const H = window.innerHeight;
    previewCanvas.width  = W;
    previewCanvas.height = H;

    const ctx = previewCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, 0, 0, W, H);
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
        main.innerText     = signal;
        main.style.color   = cfg.color;
        main.style.textShadow = `0 0 40px ${cfg.glow}, 0 4px 20px rgba(0,0,0,0.9)`;
    }

    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = cfg.label;

    if (signal === 'RED' || signal === 'GREEN') {
        const overlay = document.getElementById('color-overlay');
        if (overlay) {
            overlay.style.backgroundColor = cfg.color;
            overlay.style.opacity = '0.15';
            setTimeout(() => { overlay.style.opacity = '0'; }, 400);
        }
    }
}
