/**
 * 신호등 알리미 핵심 로직
 * 1) COCO-SSD 탐지
 * 2) HSV 정밀 색상 분석
 * 3) 자동 줌 탐색 (Smart Zoom)
 * 4) 안전 음성 가이드
 */

let model = null;
let stream = null;
let currentSignal = 'unknown';
let zoomLevel = 1.0;
let zoomTimer = null;
const MAX_ZOOM = 3.0;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const statusText = document.getElementById('main-status');
const borderSignal = document.getElementById('border-signal');
const zoomBadge = document.getElementById('zoom-badge');

// 1. 음성 안내 (TTS)
function speak(text) {
    window.speechSynthesis.cancel();
    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'ko-KR';
    msg.rate = 1.0;
    window.speechSynthesis.speak(msg);
}

// 2. 하드웨어 줌 제어
async function applyZoom(val) {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities();
    if (caps.zoom) {
        try {
            const target = Math.max(caps.zoom.min, Math.min(val, caps.zoom.max));
            await track.applyConstraints({ advanced: [{ zoom: target }] });
            zoomLevel = target;
            zoomBadge.textContent = `${zoomLevel.toFixed(1)}x`;
        } catch (e) { console.warn("Zoom not supported"); }
    }
}

// 3. 자동 줌 탐색 로직 (핵심 개선안)
function manageAutoZoom(found) {
    if (found) {
        if (zoomTimer) { clearInterval(zoomTimer); zoomTimer = null; }
    } else {
        if (!zoomTimer) {
            zoomTimer = setInterval(() => {
                if (zoomLevel < MAX_ZOOM) {
                    applyZoom(zoomLevel + 0.5);
                    speak("신호를 찾는 중입니다. 기기를 높게 유지하세요.");
                } else {
                    applyZoom(1.0); // 초기화 후 재탐색
                }
            }, 5000); // 5초 주기
        }
    }
}

// 4. 색상 정밀 분석 (기존 HSV 로직 최적화)
function analyzeSignal(imgData) {
    const d = imgData.data;
    let rSum = 0, gSum = 0;
    const total = d.length / 4;

    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b), diff = max - min;
        let h = 0;
        if (diff !== 0) {
            if (max === r) h = (g - b) / diff % 6;
            else if (max === g) h = (b - r) / diff + 2;
            else h = (r - g) / diff + 4;
            h *= 60; if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : diff / max;

        // 보행 신호등 특화 (Cyan-Green 및 Red)
        if ((h < 15 || h > 345) && s > 0.5 && r > 100) rSum++;
        else if (h > 145 && h < 195 && s > 0.4 && g > 100) gSum++;
    }
    
    if (rSum / total > 0.05) return 'red';
    if (gSum / total > 0.05) return 'green';
    return 'unknown';
}

// 5. 메인 루프
async function predict() {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const preds = await model.detect(video);
    const light = preds.find(p => p.class === 'traffic light' && p.score > 0.3);

    manageAutoZoom(!!light);

    if (light) {
        const [x, y, w, h] = light.bbox;
        ctx.drawImage(video, x, y, w, h, 0, 0, 100, 100);
        const color = analyzeSignal(ctx.getImageData(0, 0, 100, 100));
        updateUI(color);
    } else {
        updateUI('unknown');
    }
    requestAnimationFrame(predict);
}

function updateUI(color) {
    if (color === currentSignal) return;
    currentSignal = color;

    if (color === 'green') {
        borderSignal.className = 'absolute inset-0 green-active';
        statusText.textContent = "초록불 - 건너세요";
        speak("초록불이 켜졌습니다. 좌우를 살핀 후 건너가세요.");
        if(navigator.vibrate) navigator.vibrate([500, 200, 500]);
    } else if (color === 'red') {
        borderSignal.className = 'absolute inset-0 red-active';
        statusText.textContent = "빨간불 - 대기";
        speak("빨간불입니다. 보도 안쪽에서 대기하세요.");
        if(navigator.vibrate) navigator.vibrate(300);
    } else {
        borderSignal.className = 'absolute inset-0';
        statusText.textContent = "신호 탐색 중...";
    }
}

// 6. 초기화
async function initApp() {
    document.getElementById('boot-screen').classList.add('hidden');
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', focusMode: 'continuous' }
        });
        video.srcObject = stream;
        statusText.textContent = "AI 모델 로드 중...";
        model = await cocoSsd.load();
        statusText.textContent = "탐색 활성화";
        predict();
    } catch (e) {
        alert("카메라를 사용할 수 없습니다.");
    }
}

// 화면 터치 시 줌 초기화 및 재안내
document.getElementById('app').addEventListener('click', () => {
    applyZoom(1.0);
    speak(`현재 상태는 ${currentSignal === 'green' ? '초록불' : currentSignal === 'red' ? '빨간불' : '신호 확인 중'} 입니다.`);
});
