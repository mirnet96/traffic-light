/** [ULTRA VISION AI] - vision-renderer.js */

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
    
    // 신호등 영역을 전체 화면에 꽉 차게 확대해서 그림 (Stretch 모드)
    // error_01.jpg 처럼 작게 나오는 문제를 해결하기 위해 drawImage 인자를 조정
    ctx.drawImage(
        video,
        box.x, box.y, box.w, box.h, // 탐지된 박스 영역
        0, 0, W, H                  // 화면 전체 영역
    );
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
