/** [ULTRA VISION AI] - vision-renderer.js
 *  [FIX] 카메라 화면 사라짐 / 검은 화면 문제 해결
 *  - drawVideo()  : video → canvas 렌더링만 담당 (renderLoop에서 매 프레임 호출)
 *  - drawBoxes()  : 탐지 박스 오버레이만 담당 (Worker RESULT 시 호출)
 *  - drawUI()     : 하위 호환용 래퍼
 *  [KEEP] 보행자 박스 UI, SR 배지, 신호 상태 업데이트 유지
 */

const SIGNAL_CONFIG = {
    RED:     { color: '#ef4444', label: '빨간불 · 정지',      glow: 'rgba(239,68,68,0.5)'  },
    GREEN:   { color: '#22c55e', label: '초록불 · 통행 가능',  glow: 'rgba(34,197,94,0.5)'  },
    UNKNOWN: { color: '#71717a', label: '신호 분석 중...',     glow: 'transparent'           },
    LOADING: { color: '#3b82f6', label: '모델 로딩 중...',     glow: 'rgba(59,130,246,0.3)'  }
};

const ZOOM_UI_CONFIG = {
    WIDE:       { color: '#3b82f6', label: 'WIDE (1x)'  },
    MID:        { color: '#f59e0b', label: 'MID (2x)'   },
    TELE:       { color: '#ec4899', label: 'TELE (4x)'  },
    PED_LEFT:   { color: '#14b8a6', label: 'PED ←'      },
    PED_RIGHT:  { color: '#14b8a6', label: 'PED →'      },
    PED_NEAR:   { color: '#f97316', label: 'PED NEAR'   },
    PED_LEFT2:  { color: '#14b8a6', label: 'PED ←2'     },
    PED_RIGHT2: { color: '#14b8a6', label: 'PED →2'     },
};

let lastSignal = 'UNKNOWN';
let lastBoxes  = [];
let lastZoom   = null;
let lastSR     = false;
let lastEdgeSR = false;

// ─────────────────────────────────────────────
// 캔버스 크기 안전하게 가져오기
// window.innerWidth/Height 가 0인 경우 screen 값으로 폴백
// ─────────────────────────────────────────────
function _safeSize() {
    const W = window.innerWidth  || screen.width  || 390;
    const H = window.innerHeight || screen.height || 844;
    return { W, H };
}

// ─────────────────────────────────────────────
// drawVideo(): video → canvas 렌더링 전담
// vision.js의 renderLoop()에서 매 프레임 호출
// ─────────────────────────────────────────────
export function drawVideo(video) {
    const canvas = document.getElementById('preview-canvas');
    if (!canvas) return;

    const { W, H } = _safeSize();

    // 크기 변경 시에만 재설정 (매 프레임 리셋하면 깜빡임 발생)
    if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
    }

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // video 프레임 그리기
    try {
        if (video && video.srcObject) {
            ctx.drawImage(video, 0, 0, W, H);
        }
    } catch (e) {
        // drawImage 실패 시 무시 (검은 화면 유지)
        console.warn('[Renderer] drawImage 실패:', e.message);
    }

    // 마지막으로 받은 박스 오버레이 유지
    if (lastBoxes.length > 0 || lastZoom) {
        _renderOverlay(ctx, video, W, H, lastBoxes, lastZoom, lastSR, lastEdgeSR);
    }
}

// ─────────────────────────────────────────────
// drawBoxes(): 탐지 박스 정보 저장
// vision.js의 Worker RESULT 콜백에서 호출
// 실제 그리기는 drawVideo() → _renderOverlay()에서 처리
// ─────────────────────────────────────────────
export function drawBoxes(video, boxes, currentZoom, srApplied = false, edgeSR = false) {
    lastBoxes  = boxes  || [];
    lastZoom   = currentZoom;
    lastSR     = srApplied;
    lastEdgeSR = edgeSR;
}

// ─────────────────────────────────────────────
// drawUI(): 하위 호환용 래퍼
// ─────────────────────────────────────────────
export function drawUI(video, boxes, currentZoom, srApplied = false, edgeSR = false) {
    drawBoxes(video, boxes, currentZoom, srApplied, edgeSR);
}

// ─────────────────────────────────────────────
// 스캔 배지 + 탐지 박스 오버레이 렌더링
// ─────────────────────────────────────────────
function _renderOverlay(ctx, video, W, H, boxes, currentZoom, srApplied, edgeSR) {
    // ── 우측 상단 스캔 모드 배지 ──
    if (currentZoom) {
        const ui      = ZOOM_UI_CONFIG[currentZoom.label] || { color: '#fff', label: currentZoom.label };
        const srTag   = edgeSR ? ' ✦ESR' : srApplied ? ' ✦SR' : '';
        const modeTag = currentZoom.pedMode ? ' [보행자]' : '';
        const text    = `SCAN: ${ui.label}${srTag}${modeTag}`;

        ctx.font = 'bold 13px Inter, sans-serif';
        const tw = ctx.measureText(text).width;

        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.beginPath();
        ctx.roundRect(W - tw - 35, 25, tw + 20, 28, 14);
        ctx.fill();

        ctx.fillStyle = edgeSR ? '#22c55e' : srApplied ? '#a855f7' : ui.color;
        ctx.fillText(text, W - tw - 25, 44);
    }

    // videoWidth 없으면 박스 렌더링 스킵
    const vW = video?.videoWidth;
    const vH = video?.videoHeight;
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

        // 보행자 박스: 점선 외곽 강조
        if (box.pedMode) {
            ctx.strokeStyle = ui.color;
            ctx.lineWidth   = 5;
            ctx.setLineDash([6, 3]);
            ctx.strokeRect(sx - 2, sy - 2, sw + 4, sh + 4);
            ctx.setLineDash([]);
        }

        // Edge-aware SR / 일반 SR 외곽선
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

        // 라벨
        const pedBadge  = box.pedMode ? ' PED' : '';
        const srBadge   = box.edgeSR  ? ' ESR' : box.srApplied ? ' SR' : '';
        const labelText = `${box.zoomLabel}${pedBadge}${srBadge} ${Math.round(box.score * 100)}%`;
        const lw        = ctx.measureText(labelText).width;

        ctx.fillStyle = box.pedMode
            ? ui.color
            : (box.edgeSR ? '#22c55e' : box.srApplied ? '#a855f7' : ui.color);
        ctx.fillRect(sx - 1.5, sy - 20, lw + 10, 20);

        ctx.fillStyle = '#000';
        ctx.font      = 'bold 11px sans-serif';
        ctx.fillText(labelText, sx + 3, sy - 6);
    });
}

// ─────────────────────────────────────────────
// 상태 텍스트 업데이트
// ─────────────────────────────────────────────
export function updateStatusText(status) {
    const main = document.getElementById('status-main');
    if (main) main.innerText = status;
}

export function updateSignalStatus(signal) {
    if (signal === lastSignal) return;
    lastSignal = signal;

    const cfg  = SIGNAL_CONFIG[signal] || SIGNAL_CONFIG.UNKNOWN;
    const main = document.getElementById('status-main');
    if (main) {
        main.innerText        = signal;
        main.style.color      = cfg.color;
        main.style.textShadow = `0 0 40px ${cfg.glow}`;
    }

    const sub = document.getElementById('status-sub');
    if (sub) sub.innerText = cfg.label;
}
