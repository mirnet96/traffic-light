/** [ULTRA VISION AI] - vision.js */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';

let visionWorker = null;
let isWorkerBusy = false;
let lastKnownBox = null;
let lockCounter = 0;
let isVisionActive = true; 
const MAX_LOCK_FRAMES = 30;

/**
 * 시스템 초기화: 워커를 생성하고 모델 로드 완료를 기다림
 */
export async function initVision() {
    console.log("Vision Worker 초기화 시작...");
    return new Promise((resolve, reject) => {
        try {
            visionWorker = new Worker('vision-worker.js');
            
            const timeout = setTimeout(() => {
                reject(new Error("모델 로딩 시간 초과 (Network 확인)"));
            }, 15000);

            visionWorker.postMessage({ type: 'LOAD' });
            
            visionWorker.onmessage = (e) => {
                if (e.data.type === 'LOADED') {
                    clearTimeout(timeout);
                    console.log("Vision Model 로드 완료.");
                    resolve();
                }
                if (e.data.type === 'RESULT') {
                    handleWorkerResult(e.data.boxes);
                }
                if (e.data.type === 'ERROR') {
                    console.error("Worker Error:", e.data.message);
                    reject(new Error(e.data.message));
                }
            };
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * 카메라 시작
 */
export async function startVision() {
    console.log("카메라 스트림 요청 중...");
    const video = document.getElementById('webcam');
    if (!video) {
        throw new Error("HTML에 'webcam' ID를 가진 video 태그가 없습니다.");
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { 
                facingMode: 'environment', 
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        
        video.srcObject = stream;
        
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play().then(resolve);
            };
        });

        console.log("카메라 활성화 성공. 탐지 루프 시작.");
        requestAnimationFrame(detectLoop);
    } catch (err) {
        console.error("카메라 접근 에러:", err);
        alert("카메라를 시작할 수 없습니다: " + err.message);
        throw err;
    }
}

export function setVisionActive(active) {
    isVisionActive = active;
}

async function detectLoop() {
    const video = document.getElementById('webcam');
    
    // 1. 비전 비활성화 상태거나 비디오 준비 안됨 체크
    if (!isVisionActive || !video || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    // 2. 워커가 작업 중이면 드로잉만 수행하고 리턴
    if (isWorkerBusy) {
        if (lastKnownBox) Renderer.drawUI(video, lastKnownBox);
        else Renderer.drawPreview(video);
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
        console.error("Bitmap 생성 에러:", e);
        isWorkerBusy = false;
    }
    
    requestAnimationFrame(detectLoop);
}

function handleWorkerResult(boxes) {
    const video = document.getElementById('webcam');
    
    if (boxes && boxes.length > 0) {
        lastKnownBox = boxes[0];
        lockCounter = MAX_LOCK_FRAMES; 
    } else {
        if (lockCounter > 0) {
            lockCounter--;
        } else {
            lastKnownBox = null;
        }
    }

    // 결과에 따른 렌더링 실행
    if (lastKnownBox) {
        Renderer.drawUI(video, lastKnownBox);
    } else {
        Renderer.drawPreview(video);
    }
    
    isWorkerBusy = false; // 워커 가용 상태로 복구
}
