/** [ULTRA VISION AI] - vision.js (iOS 카메라 수정 + 원거리 인식 개선) */
import * as Detector from './vision-detector.js';
import * as Renderer from './vision-renderer.js';
import { analyzeROI, detectByHSV as analyzeByHSV } from './vision-analyzer.js';

let visionWorker = null;
let isWorkerBusy = false;
let lastKnownBox = null;
let lockCounter = 0;
let isVisionActive = true;
let videoStream = null; // iOS: 스트림을 미리 저장
const MAX_LOCK_FRAMES = 30;

/**
 * [iOS 핵심 수정]
 * 카메라 권한 요청은 반드시 사용자 제스처(터치) 직후 즉시 호출해야 함.
 * 모델 로딩(최대 15초)을 기다리면 iOS Safari가 제스처 컨텍스트를 만료시켜 카메라가 거부됨.
 * → 카메라를 먼저 켜고, 모델은 병렬로 로딩한다.
 *
 * ★ iOS Safari에서 권한 팝업이 아예 안 뜨는 2가지 원인:
 *   1) HTTP 환경: getUserMedia API 자체가 비활성화됨 → HTTPS 필요
 *   2) 제스처 컨텍스트 만료: await가 너무 길면 Safari가 권한 요청 차단
 */
export async function startCameraFirst() {
    const video = document.getElementById('webcam');
    if (!video) throw new Error("'webcam' video 태그 없음");

    // [원인 1 체크] HTTP 환경에서는 iOS Safari가 getUserMedia를 완전히 차단
    // → API 자체가 undefined로 노출됨 (권한 팝업 없이 조용히 실패)
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure) {
        const msg = '⚠️ 카메라를 사용하려면 HTTPS가 필요합니다.\n\n현재 주소: ' + location.origin + '\n\nHTTPS 도메인으로 접속하거나 localhost에서 개발해주세요.';
        alert(msg);
        throw new Error('HTTPS_REQUIRED');
    }

    // [원인 1 체크] getUserMedia API 존재 여부 확인
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const msg = '⚠️ 이 브라우저는 카메라를 지원하지 않습니다.\nSafari 최신 버전에서 HTTPS로 접속해주세요.';
        alert(msg);
        throw new Error('CAMERA_API_UNAVAILABLE');
    }

    // [원인 2 대응] 전략 1: exact 'environment' (후면 카메라 강제)
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { exact: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        return await _attachStream(video, stream);

    } catch (err) {
        console.warn("[카메라] exact:environment 실패 →", err.name, err.message);

        // NotReadableError: 카메라가 다른 앱에 점유됨
        if (err.name === 'NotReadableError') {
            alert('⚠️ 카메라가 다른 앱에서 사용 중입니다.\n다른 앱을 종료 후 다시 시도해주세요.');
            throw err;
        }

        // NotAllowedError: 사용자가 명시적으로 거부했거나 Safari 설정에서 차단됨
        if (err.name === 'NotAllowedError') {
            alert('⚠️ 카메라 권한이 거부되었습니다.\n\niPhone 설정 > Safari > 카메라 > "묻기" 또는 "허용"으로 변경 후 페이지를 새로고침해주세요.');
            throw err;
        }

        // 전략 2: 제약 조건 완화 (구형 iPhone, 일부 iOS 버전)
        console.warn("[카메라] 제약 완화 후 재시도 중...");
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false
            });
            return await _attachStream(video, stream);

        } catch (err2) {
            console.warn("[카메라] environment 실패 → 전면 카메라로 최종 시도:", err2.message);

            // 전략 3: 카메라 종류 무관 (최후 수단)
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                return await _attachStream(video, stream);
            } catch (err3) {
                console.error("[카메라] 완전 실패:", err3);
                alert('⚠️ 카메라를 시작할 수 없습니다.\n\n오류: ' + err3.message);
                throw err3;
            }
        }
    }
}

/**
 * 스트림을 video 요소에 연결하고 재생 대기
 */
async function _attachStream(video, stream) {
    videoStream = stream;
    video.srcObject = stream;

    // iOS: setAttribute로도 반드시 설정 (HTML 속성만으론 불충분한 경우 있음)
    video.setAttribute('playsinline', 'true');
    video.setAttribute('muted', 'true');
    video.muted = true; // property도 동시 설정

    await new Promise((resolve, reject) => {
        let settled = false;
        const done = (ok) => { if (!settled) { settled = true; ok ? resolve() : reject(); } };

        video.onloadedmetadata = () => {
            video.play()
                .then(() => done(true))
                .catch((e) => {
                    // iOS: play() rejected 시 muted 강제 후 재시도
                    console.warn("[video.play()] 실패, muted 재시도:", e.message);
                    video.muted = true;
                    video.play().then(() => done(true)).catch(() => done(true)); // 실패해도 진행
                });
        };

        // 메타데이터가 늦게 오는 기기 대응 (4초 타임아웃)
        setTimeout(() => done(true), 4000);
    });

    console.log("[카메라] 활성화 성공:", video.videoWidth, "x", video.videoHeight);
    return true;
}

/**
 * 모델 로딩 (카메라와 병렬 실행 가능)
 */
export async function initVision(options = {}) {
    console.log("[Vision Worker] 초기화 시작...");
    return new Promise((resolve, reject) => {
        try {
            visionWorker = new Worker('vision-worker.js');

            const timeout = setTimeout(() => {
                reject(new Error("모델 로딩 시간 초과 (Network 확인)"));
            }, 30000); // iOS는 느릴 수 있어 30초로 연장

            visionWorker.postMessage({ type: 'LOAD', options });

            visionWorker.onmessage = (e) => {
                if (e.data.type === 'LOADED') {
                    clearTimeout(timeout);
                    console.log("[Vision Model] 로드 완료.");
                    resolve();
                }
                if (e.data.type === 'RESULT') {
                    handleWorkerResult(e.data.boxes);
                }
                if (e.data.type === 'ERROR') {
                    clearTimeout(timeout);
                    console.error("[Worker Error]:", e.data.message);
                    reject(new Error(e.data.message));
                }
            };
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * 탐지 루프 시작 (카메라 + 모델 모두 준비된 후 호출)
 */
export function startVision() {
    console.log("[탐지 루프] 시작");
    requestAnimationFrame(detectLoop);
}

export function setVisionActive(active) {
    isVisionActive = active;
}

async function detectLoop() {
    const video = document.getElementById('webcam');

    if (!isVisionActive || !video || video.readyState < 2) {
        requestAnimationFrame(detectLoop);
        return;
    }

    if (isWorkerBusy) {
        if (lastKnownBox) Renderer.drawUI(video, lastKnownBox);
        else Renderer.drawPreview(video);
        requestAnimationFrame(detectLoop);
        return;
    }

    isWorkerBusy = true;
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    if (!vW || !vH) { isWorkerBusy = false; requestAnimationFrame(detectLoop); return; }

    const zone = Detector.getScanZone(vW, vH);

    try {
        const bitmap = await createImageBitmap(video);
        visionWorker.postMessage({
            type: 'DETECT',
            data: { bitmap, vW, vH, zone }
        }, [bitmap]);
    } catch (e) {
        console.error("[Bitmap 생성 에러]:", e);
        isWorkerBusy = false;
    }

    requestAnimationFrame(detectLoop);
}

function handleWorkerResult(boxes) {
    const video = document.getElementById('webcam');

    if (boxes && boxes.length > 0) {
        // YOLO 탐지 성공
        lastKnownBox = boxes[0];
        lockCounter = MAX_LOCK_FRAMES;
        analyzeAndShowSignal(video, lastKnownBox);
    } else {
        if (lockCounter > 0) {
            // 이전 박스 유지 (lock 중)
            lockCounter--;
        } else {
            // [HSV Fallback] YOLO 탐지 실패 + lock 만료 → HSV로 직접 스캔
            lastKnownBox = null;
            tryHSVFallback(video);
        }
    }

    if (lastKnownBox) {
        Renderer.drawUI(video, lastKnownBox);
    } else {
        Renderer.drawPreview(video);
    }

    isWorkerBusy = false;
}

/**
 * YOLO 미탐지 시 HSV 색상 분석으로 신호 판별
 * preview-canvas에 현재 프레임이 그려져 있으므로 그것을 읽어 분석
 */
function tryHSVFallback(video) {
    try {
        const previewCanvas = document.getElementById('preview-canvas');
        if (!previewCanvas) return;
        const ctx = previewCanvas.getContext('2d');

        const vW = video.videoWidth  || previewCanvas.width;
        const vH = video.videoHeight || previewCanvas.height;
        const zone = Detector.getScanZone(vW, vH);

        const { signal, box } = analyzeByHSV(ctx, zone);

        if (signal !== 'UNKNOWN' && box) {
            // HSV fallback으로 박스 확보 → 짧게 유지 (lockCounter 절반)
            lastKnownBox = box;
            lockCounter = Math.floor(MAX_LOCK_FRAMES / 2);
            Renderer.updateSignalStatus(signal);
        } else {
            Renderer.updateSignalStatus('UNKNOWN');
        }
    } catch (e) {
        console.warn('[HSV Fallback]:', e.message);
    }
}

/**
 * [신규] 탐지 박스 → 색상 분석 → 상태 UI 업데이트
 */
function analyzeAndShowSignal(video, box) {
    try {
        // 오프스크린 캔버스에서 ROI 픽셀 추출
        const offscreen = new OffscreenCanvas(Math.max(1, Math.floor(box.w)), Math.max(1, Math.floor(box.h)));
        const ctx = offscreen.getContext('2d');
        ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

        const result = analyzeROI(ctx, { x: 0, y: 0, w: box.w, h: box.h });
        Renderer.updateSignalStatus(result);
    } catch (e) {
        // OffscreenCanvas 미지원 환경 fallback
        console.warn("[색상분석] OffscreenCanvas 미지원:", e.message);
    }
}
