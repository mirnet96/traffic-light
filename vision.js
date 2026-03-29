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
    }
}

/**
 * 비전 활성화/비활성화 제어 (탭 전환 시 호출)
 */
export function setVisionActive(active) {
    isVisionActive = active;
    if (!active) {
        Renderer.updateStatusText('PAUSED');
        // 비활성화 시 즉시 캔버스 초기화 (선택 사항)
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
    
    // 1. 영상 준비 미흡, 워커 작업 중, 혹은 비활성 상태면 스킵
    if (!video || video.readyState < 2 || isWorkerBusy || !isVisionActive) {
        requestAnimationFrame(detectLoop);
        return;
    }

    isWorkerBusy = true;
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const zone = Detector.getScanZone(vW, vH);

    // 2. 현재 프레임을 비트맵으로 캡처하여 워커로 전송
    try {
        const bitmap = await createImageBitmap(video);
        visionWorker.postMessage({
            type: 'DETECT',
            data: { bitmap, vW, vH, zone }
        }, [bitmap]);
    } catch (e) {
        isWorkerBusy = false;
    }

    requestAnimationFrame(detectLoop);
}

/**
 * 워커로부터 받은 탐지 결과 처리
 */
function handleWorkerResult(boxes) {
    const video = document.getElementById('webcam');
    
    if (boxes && boxes.length > 0) {
        // [탐지 성공] 가장 신뢰도 높은 첫 번째 박스 선택
        lastKnownBox = boxes[0];
        lockCounter = MAX_LOCK_FRAMES; 
    } else {
        // [탐지 실패] 기존 좌표가 있다면 카운트 감소하며 유지 (Hysteresis)
        if (lockCounter > 0) {
            lockCounter--;
        } else {
            lastKnownBox = null;
        }
    }

    // 렌더링 결정
    if (lastKnownBox) {
        // 찾았거나 유지 중이면 확대 UI
        Renderer.drawUI(video, lastKnownBox);
        Renderer.updateStatusText('DETECTED');
    } else {
        // 완전히 놓쳤으면 일반 미리보기
        Renderer.drawPreview(video);
        Renderer.updateStatusText('READY');
    }

    isWorkerBusy = false;
}
