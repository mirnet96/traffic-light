/** [ULTRA VISION AI] - vision-renderer.js
 *  변경사항:
 *  - [NEW] 보행자 줌 레벨 UI 색상/라벨 추가
 *      PED_LEFT  : 청록색 (teal)
 *      PED_RIGHT : 청록색 (teal)
 *      PED_NEAR  : 주황색 (amber)
 *  - [NEW] 보행자 박스 렌더링: 좌측 테두리 강조 + PED 배지
 *  - [NEW] Edge-aware SR 적용 시 보라색 → 초록색으로 구분 표시
 *  - [FIX] video.videoWidth = 0 division by zero 방지 (기존 수정 유지)
 */

const SIGNAL_CONFIG = {
    RED:     { color: '#ef4444', label: '빨간불 · 정지',      glow: 'rgba(239,68,68,0.5)'  },
    GREEN:   { color: '#22c55e', label: '초록불 · 통행 가능',  glow: 'rgba(34,197,94,0.5)'  },
    UNKNOWN: { color: '#71717a', label: '신호 분석 중...',     glow: 'transparent'           },
    LOADING: { color: '#3b82f6', label: '모델 로딩 중...',     glow: 'rgba(59,130,246,0.3)'  }
};

const ZOOM_UI_CONFIG = {
    WIDE:      { color: '#3b82f6', label: 'WIDE (1x)'    },
    MID:       { color: '#f59e0b', label: 'MID (2x)'     },
    TELE:      { color: '#ec4899', label: 'TELE (4x)'    },
    // 보행자 전용 줌 레벨
    PED_LEFT:  { color: '#14b8a6', label: 'PED ←'        },
    PED_RIGHT: { color: '#14b8a6', label: 'PED →'        },
    PED_NEAR:  { color: '#f97316', label: 'PED NEAR'     },
};

let lastSignal = 'UNKNOWN';

export function drawUI(video, boxes, currentZoom, srApplied = false, edgeSR = false) {
    const previewCanvas = document.getElementById('preview-canvas');
    if (!previewCanvas) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    previewCanvas.width  = W;
    previewCanvas.height = H;

    const ctx = previewCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(video, 0, 0, W, H);

    // ── 우측 상단 스캔 모드 배지 ──
    if (currentZoom) {
        const ui = ZOOM_UI_CONFIG[currentZoom.label] || { color: '#fff', label: currentZoom.label };

        // Edge-aware SR: 초록 배지 / 기존 SR: 보라 배지
        const srTag = edgeSR ? ' ✦ESR' : srApplied ? ' ✦SR' : '';
        const isPedMode = currentZoom.pedMode;
        const modeTag   = isPedMode ? ' [보행자]' : '';
        const text      = `SCAN: ${ui.label}${srTag}${modeTag}`;

        ctx.font = 'bold 13px Inter, sans-serif';
        const tw = ctx.measureText(text).width;

        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.beginPath();
        ctx.roundRect(W - tw - 35, 25, tw + 20, 28, 14);
        ctx.fill();

        // SR 타입에 따라 배지 색상 구분
        ctx.fillStyle = edgeSR ? '#22c55e' : srApplied ? '#a855f7' : ui.color;
        ctx.fillText(text, W - tw - 25, 44);
    }

    // [BUG FIX] videoWidth = 0 가드
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    if (!vW || !vH) return;

    const scaleX = W / vW;
    const scaleY = H / vH;

    // ── 탐지 박스 렌더링 ──
    boxes.forEach(box => {
        const sx = box.x * scaleX;
        const sy = box.y * scaleY;
        const sw = box.w * scaleX;
        const sh = box.h * scaleY;

        const ui = ZOOM_UI_CONFIG[box.zoomLabel] || { color: '#fff', label: box.zoomLabel };

        // 보행자 박스: 이중 테두리로 강조
        if (box.pedMode) {
            // 외곽 강조선 (조금 더 두껍게)
            ctx.strokeStyle = ui.color;
            ctx.lineWidth   = 5;
            ctx.setLineDash([6, 3]); // 점선으로 보행자 구분
            ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
            ctx.setLineDash([]);
        }

        // Edge-aware SR 박스: 초록 외곽 / 일반 SR: 보라 외곽
        if (box.edgeSR) {
            ctx.strokeStyle = '#22c55e';
            ctx.lineWidth   = 4;
            ctx.strokeRect(sx - 3, sy - 3, sw + 6, sh + 6);
        } else if (box.srApplied) {
            ctx.strokeStyle = '#a855f7';
            ctx.lineWidth   = 4;
            ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
        }

        // 메인 박스
        ctx.strokeStyle = ui.color;
        ctx.lineWidth   = box.pedMode ? 2.5 : 3;
        ctx.strokeRect(sx, sy, sw, sh);

        // 라벨 텍스트
        const pedBadge = box.pedMode  ? ' PED' : '';
        const srBadge  = box.edgeSR   ? ' ESR' : box.srApplied ? ' SR' : '';
        const labelText = `${box.zoomLabel}${pedBadge}${srBadge} ${Math.round(box.score * 100)}%`;
        const lw = ctx.measureText(labelText).width;

        // 보행자 박스 라벨: 청록색 배경
        ctx.fillStyle = box.pedMode ? ui.color : (box.edgeSR ? '#22c55e' : box.srApplied ? '#a855f7' : ui.color);
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
        main.innerText        = signal;
        main.style.color      = cfg.color;
        main.style.textShadow = `0 0 40px ${cfg.glow}`;
    }

    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = cfg.label;
}
