/** [ULTRA VISION AI] - vision-detector.js
 *  변경사항:
 *  - [NEW] PEDESTRIAN_ZONES: 보행자 신호등 전용 스캔존 3개 추가
 *    - PED_LEFT  : 화면 좌측 가장자리 (횡단보도 기둥 위치)
 *    - PED_RIGHT : 화면 우측 가장자리
 *    - PED_NEAR  : 화면 하단 근거리 (코앞 횡단보도)
 *  - [NEW] getPedestrianScanRects(): 픽셀 좌표 반환 헬퍼
 */

export const CONFIG = {
    SCAN_ZONE: {
        PORTRAIT:  { top: 0.0, bottom: 0.65 },
        LANDSCAPE: { top: 0.0, bottom: 0.60 }
    }
};

// ─────────────────────────────────────────────
// 보행자 신호등 전용 스캔존
//
// 보행자 신호등은 차량 신호등과 위치가 다름:
//   - 횡단보도 기둥에 설치 → 화면 좌/우 가장자리에 출현
//   - 근거리 횡단보도 → 화면 하단 중앙에도 출현
//   - 크기가 작고 세로로 긴 2구 형태 (빨강 위 / 초록 아래)
//
// xRatio/wRatio : 화면 너비 기준 비율
// yTop/yBot    : 화면 높이 기준 비율
// ─────────────────────────────────────────────
export const PEDESTRIAN_ZONES = {
    PED_LEFT: {
        xRatio: 0.0,  wRatio: 0.20,
        yTop: 0.04,   yBot: 0.68,
        label: 'PED_LEFT'
    },
    PED_RIGHT: {
        xRatio: 0.80, wRatio: 0.20,
        yTop: 0.04,   yBot: 0.68,
        label: 'PED_RIGHT'
    },
    // 근거리: 코앞의 횡단보도 기둥은 화면 하단에 큼직하게 잡힘
    PED_NEAR: {
        xRatio: 0.0,  wRatio: 1.0,
        yTop: 0.55,   yBot: 0.88,
        label: 'PED_NEAR'
    },
};

export function getScanZone(vW, vH) {
    const isLandscape = vW > vH;
    const zone = isLandscape ? CONFIG.SCAN_ZONE.LANDSCAPE : CONFIG.SCAN_ZONE.PORTRAIT;
    return {
        yMin: Math.floor(vH * zone.top),
        yMax: Math.floor(vH * zone.bottom)
    };
}

/**
 * 보행자 전용 스캔존을 픽셀 좌표 rect 배열로 반환
 * @param {number} vW - 이미지/캔버스 너비
 * @param {number} vH - 이미지/캔버스 높이
 * @returns {{ label, x, y, w, h }[]}
 */
export function getPedestrianScanRects(vW, vH) {
    return Object.values(PEDESTRIAN_ZONES).map(z => ({
        label: z.label,
        x: Math.floor(vW * z.xRatio),
        y: Math.floor(vH * z.yTop),
        w: Math.floor(vW * z.wRatio),
        h: Math.floor(vH * (z.yBot - z.yTop)),
    }));
}
