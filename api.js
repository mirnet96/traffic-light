/**
 * V2X 진단 및 주소 변환 통합 스크립트
 */

let userPos = { lat: null, lng: null };
let userHeading = 0;
const AUTH_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

// 카카오 SDK 로드 완료 후 실행
kakao.maps.load(() => {
    addLog("카카오 SDK 로드 완료");
    
    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function() {
        addLog("진단 프로세스 시작...");
        
        // 1. GPS 추적 시작
        if (navigator.geolocation) {
            navigator.geolocation.watchPosition(successGPS, errorGPS, { 
                enableHighAccuracy: true,
                timeout: 5000 
            });
        } else {
            addLog("이 기기는 GPS를 지원하지 않습니다.", "error");
        }

        // 2. 방향 센서 권한 (iOS)
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            const permission = await DeviceOrientationEvent.requestPermission();
            addLog(`방향 센서 권한: ${permission}`);
        }

        window.addEventListener('deviceorientation', (e) => {
            userHeading = e.webkitCompassHeading || (360 - e.alpha);
            document.getElementById('headingInfo').innerText = `${Math.round(userHeading)}° (${getDirName(userHeading)})`;
        }, true);

        // 3. 서버 통신 시작
        setInterval(fetchV2XData, 2000);
        
        this.disabled = true;
        this.innerText = "진단 중...";
    };
});

// GPS 성공 콜백
function successGPS(pos) {
    userPos.lat = pos.coords.latitude;
    userPos.lng = pos.coords.longitude;
    
    document.getElementById('geoCoords').innerText = `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
    updateStepStatus('gps', 'success', '수신중');

    // 주소 변환 실행
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.coord2Address(userPos.lng, userPos.lat, (result, status) => {
        if (status === kakao.maps.services.Status.OK) {
            const addr = result[0].address.address_name;
            document.getElementById('geoAddress').innerText = addr;
        }
    });
}

// GPS 실패 콜백
function errorGPS(err) {
    addLog(`GPS 수신 실패: ${err.message}`, "error");
    updateStepStatus('gps', 'error', '실패');
}

// 서버 데이터 요청 (V2X)
async function fetchV2XData() {
    if (!userPos.lat || !userHeading) return;

    try {
        // 확장된 5km 반경 로직이 적용된 PHP 엔드포인트 호출
        const response = await fetch(`https://iot.klueware.com/api/v1/front-signal?lat=${userPos.lat}&lng=${userPos.lng}&heading=${userHeading}`, {
            headers: { 'X-API-KEY': AUTH_KEY }
        });

        const result = await response.json();

        if (response.ok) {
            updateStepStatus('nearby', 'success', result.itstNm);
            updateStepStatus('signal', 'success', '수신완료');
            updateSignalUI(result);
        } else {
            updateStepStatus('nearby', 'error', '매칭없음');
            addLog(`서버 응답: ${result.message}`, "error");
        }
    } catch (e) {
        addLog(`통신 에러: ${e.message}`, "error");
    }
}

// 기타 UI 보조 함수 (이전과 동일)
function addLog(msg, type = 'info') {
    const consoleBox = document.getElementById('logConsole');
    const item = document.createElement('div');
    item.className = `log-item ${type === 'error' ? 'text-red-500' : 'text-neutral-400'}`;
    item.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleBox.prepend(item);
}

function updateStepStatus(stepId, status, text) {
    const dot = document.getElementById(`step-${stepId}`);
    const val = document.getElementById(`step-${stepId}-val`);
    if(dot) dot.className = `status-dot dot-${status}`;
    if(val) {
        val.innerText = text;
        val.className = `text-[10px] ${status === 'success' ? 'text-emerald-400' : 'text-red-400'}`;
    }
}

function getDirName(h) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(h / 45) % 8];
}
