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
            
            // 타임아웃 설정 (10초 내에 로드 안되면 실패 처리)
            const timeout = setTimeout(() => {
                reject(new Error("모델 로딩 시간 초과 (Network 확인)"));
            }, 10000);

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
 * 카메라 시작: 권한을 요청하고 영상을 비디오 태그에 연결
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
        
        // play()가 완료될 때까지 대기
        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                video.play().then(resolve);
            };
        });

        console.log("카메라 활성화 성공. 탐지 루프 시작.");
        requestAnimationFrame(detectLoop);
    } catch (err) {
        console.error("카메라 접근 에러:", err);
        if (err.name === 'NotAllowedError') {
            alert("카메라 권한이 거부되었습니다. 설정에서 카메라를 허용해주세요.");
        }
        throw err;
    }
}

export function setVisionActive(active) {
    isVisionActive = active;
}

async function detectLoop() {
    const video = document.getElementById('webcam');
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
        if (lockCounter > 0) lockCounter--;
        else lastKnownBox = null;
    }

    if (lastKnownBox) {
        Renderer.drawUI(video, lastKnownBox);
    } else {
        Renderer.drawPreview(video);
    }
    isWorkerBusy = false;
}
