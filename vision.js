/** [ULTRA VISION AI] - vision.js */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let isWorkerBusy = false;
let lastKnownBox = null;    // 마지막으로 확인된 좌표 고정용
let lockCounter = 0;        // 좌표 유지 프레임 카운트
let isVisionActive = true;  // 비전 활성화 상태 변수
const MAX_LOCK_FRAMES = 30; // 탐지 실패 시 약 1초간 마지막 좌표 유지

/**
 * 시스템 초기화: 워커 생성 및 모델 로드
 */
export async function initVision() {
    return new Promise((resolve) => {
        // 워커 파일 경로가 정확한지 확인 필수
        visionWorker = new Worker('vision-worker.js');
        visionWorker.postMessage({ type: 'LOAD' });
        visionWorker.onmessage = (e) => {
            if (e.data.type === 'LOADED') {
                console.log("Vision Model Loaded.");
                resolve();
            }
            if (e.data.type === 'RESULT') {
                handleWorkerResult(e.data.boxes);
            }
        };
    });
}

/**
 * 카메라 시작 및 루프 실행
 */
export async function startVision() {
    const video = document.getElementById('webcam');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: 'environment', 
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        video.srcObject = stream;
        await video.play();
        requestAnimationFrame(detectLoop);
    } catch (err) {
        console.error("Camera access denied:", err);
        throw err;
    }
}

/**
 * 비전 활성화/비활성화 제어 (탭 전환 시 호출)
 */
export function setVisionActive(active) {
    isVisionActive = active;
    if (!active) {
        Renderer.updateStatusText('PAUSED');
        const video = document.getElementById('webcam');
        if (video) Renderer.drawPreview(video);
    } else {
        Renderer.updateStatusText('READY');
    }
}

/**
 * 탐지 루프: 주기적으로 워커에 이미지를 전달
 */
async function detectLoop() {
    const video = document.getElementById('webcam');
    
    // 비활성 상태거나 워커가 바쁘면 다음 프레임으로 대기
    if (!video || video.readyState < 2 || isWorkerBusy || !isVisionActive) {
        requestAnimationFrame(detectLoop);
        return;
    }

    isWorkerBusy = true;
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const zone = Detector.getScanZone(vW, vH);

    try {
        const bitmap = await createImageBitmap(video);
        visionWorker.postMessage({
            type: 'DETECT',
            data: { bitmap, vW, vH, zone }
        }, [bitmap]);
    } catch (e) {
        console.error("Bitmap creation failed:", e);
        isWorkerBusy = false;
    }

    requestAnimationFrame(detectLoop);
}

/**
 * 워커 탐지 결과 처리 및 화면 고정 로직
 */
function handleWorkerResult(boxes) {
    const video = document.getElementById('webcam');
    
    if (boxes && boxes.length > 0) {
        // [탐지 성공] 좌표 업데이트 및 유지 시간 초기화
        lastKnownBox = boxes[0];
        lockCounter = MAX_LOCK_FRAMES; 
    } else {
        // [탐지 실패] 기존 좌표가 있다면 일정 시간(MAX_LOCK_FRAMES) 동안 버티기
        if (lockCounter > 0) {
            lockCounter--;
        } else {
            lastKnownBox = null;
        }
    }

    // 렌더링: 고정된 박스가 있다면 확대 UI, 없다면 일반 미리보기
    if (lastKnownBox) {
        Renderer.drawUI(video, lastKnownBox);
        Renderer.updateStatusText('DETECTED');
    } else {
        Renderer.drawPreview(video);
        Renderer.updateStatusText('READY');
    }

    isWorkerBusy = false;
}
