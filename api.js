/**
 * V2X 신호등 실시간 클라이언트
 */

let userPos = { lat: null, lng: null };
let userHeading = 0;
let isTracking = false;
const API_BASE_URL = 'https://iot.klueware.com/api/v1'; // Laravel API 경로
const AUTH_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

// 1. 초기화 및 권한 요청
document.getElementById('startBtn').addEventListener('click', async () => {
    if (isTracking) return;

    // iOS 권한 요청 처리
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') {
            alert('방위 센서 권한이 거부되었습니다.');
            return;
        }
    }

    startTracking();
    document.getElementById('startBtn').innerText = "실시간 추적 중...";
    document.getElementById('startBtn').classList.replace('bg-blue-600', 'bg-green-600');
    isTracking = true;
});

// 2. 센서 트래킹 시작
function startTracking() {
    // GPS 위치 감시
    navigator.geolocation.watchPosition(
        (pos) => {
            userPos.lat = pos.coords.latitude;
            userPos.lng = pos.coords.longitude;
        },
        (err) => console.error("GPS Error:", err),
        { enableHighAccuracy: true }
    );

    // 나침반 방위 감시
    window.addEventListener('deviceorientation', (event) => {
        // iOS는 webkitCompassHeading, 안드로이드는 alpha 기준 보정
        userHeading = event.webkitCompassHeading || (360 - event.alpha);
        
        if (userHeading) {
            const dirText = getDirectionText(userHeading);
            document.getElementById('headingVal').innerText = `${Math.round(userHeading)}° (${dirText})`;
        }
    }, true);

    // 1.5초마다 서버와 통신 (신호 데이터 갱신)
    setInterval(fetchSignalData, 1500);
}

// 3. 8방위 텍스트 변환
function getDirectionText(heading) {
    const directions = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    const index = Math.round(heading / 45) % 8;
    return directions[index];
}

// 4. 서버로부터 정면 신호 데이터 가져오기
async function fetchSignalData() {
    if (!userPos.lat || !userHeading) return;

    try {
        const response = await fetch(`${API_BASE_URL}/front-signal?lat=${userPos.lat}&lng=${userPos.lng}&heading=${userHeading}`, {
            method: 'GET',
            headers: {
                'X-API-KEY': AUTH_KEY,
                'Accept': 'application/json'
            }
        });

        const result = await response.json();

        if (response.ok && result.walk_remaining !== undefined) {
            updateUI(result);
        } else {
            document.getElementById('statusText').innerText = "신호등 탐색 중...";
        }
    } catch (error) {
        console.error("Fetch Error:", error);
    }
}

// 5. UI 업데이트
function updateUI(data) {
    const circle = document.getElementById('signalCircle');
    const timer = document.getElementById('timer');
    const statusText = document.getElementById('statusText');
    const signalIcon = document.getElementById('signalIcon');
    const crossName = document.getElementById('crossroadName');
    const dirCode = document.getElementById('directionCode');
    const glow = document.getElementById('glow');

    // 1. 기본 정보 텍스트 업데이트
    crossName.innerText = data.itstNm;
    dirCode.innerText = data.direction_code;
    timer.innerText = Math.floor(data.walk_remaining);

    // 2. 상태별 스타일 초기화
    circle.classList.remove('border-emerald-500', 'border-red-500', 'border-slate-800');
    signalIcon.classList.remove('text-emerald-400', 'text-red-400', 'text-slate-600');
    statusText.classList.remove('text-emerald-400', 'text-red-400', 'text-slate-500');
    glow.classList.remove('bg-emerald-500', 'bg-red-500');

    // 3. 상태별 UI 분기
    if (data.status === 'green') {
        // 초록불 (보행 가능)
        circle.classList.add('border-emerald-500');
        signalIcon.classList.add('text-emerald-400');
        signalIcon.innerText = 'directions_walk'; // 걷는 아이콘
        statusText.classList.add('text-emerald-400');
        statusText.innerText = '횡단하세요';
        glow.classList.add('bg-emerald-500');
        timer.classList.add('text-emerald-400');
        timer.classList.remove('text-red-400');
    } else if (data.status === 'red') {
        // 빨간불 (대기)
        circle.classList.add('border-red-500');
        signalIcon.classList.add('text-red-400');
        signalIcon.innerText = 'front_hand'; // 멈춤 손바닥 아이콘
        statusText.classList.add('text-red-400');
        statusText.innerText = '대기하세요';
        glow.classList.add('bg-red-500');
        timer.classList.add('text-red-400');
        timer.classList.remove('text-emerald-400');
    } else {
        // 데이터 없음/대기
        circle.classList.add('border-slate-800');
        signalIcon.innerText = 'question_mark';
        statusText.innerText = '데이터 없음';
    }
}
