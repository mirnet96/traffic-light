/**
 * V2X 진단 및 데이터 통신 스크립트
 */

const geocoder = new kakao.maps.services.Geocoder();
let userPos = { lat: null, lng: null };
let heading = 0;
const AUTH_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

// 커스텀 로그 함수
function addLog(msg, type = 'info') {
    const consoleBox = document.getElementById('logConsole');
    const item = document.createElement('div');
    item.className = `log-item ${type === 'error' ? 'text-red-400' : 'text-neutral-400'}`;
    const now = new Date();
    item.innerText = `[${now.toLocaleTimeString()}] ${msg}`;
    consoleBox.prepend(item);
}

// 상태 점 표시 업데이트
function setStepStatus(stepId, status, valueText) {
    const dot = document.getElementById(`step-${stepId}`);
    const val = document.getElementById(`step-${stepId}-val`);
    dot.className = `status-dot dot-${status}`;
    val.innerText = valueText;
    if(status === 'success') val.classList.add('text-emerald-400');
    if(status === 'error') val.classList.add('text-red-400');
}

// 1. 시작 버튼
document.getElementById('startBtn').addEventListener('click', async () => {
    addLog("진단을 시작합니다...");
    
    // 위치 권한 요청
    navigator.geolocation.watchPosition(
        (pos) => {
            userPos.lat = pos.coords.latitude;
            userPos.lng = pos.coords.longitude;
            
            document.getElementById('geoCoords').innerText = `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
            setStepStatus('gps', 'success', 'Connected');
            
            // 카카오 주소 변환
            geocoder.coord2Address(userPos.lng, userPos.lat, (result, status) => {
                if (status === kakao.maps.services.Status.OK) {
                    document.getElementById('geoAddress').innerText = result[0].address.address_name;
                }
            });
        },
        (err) => {
            addLog(`GPS 오류: ${err.message}`, 'error');
            setStepStatus('gps', 'error', 'Failed');
        },
        { enableHighAccuracy: true }
    );

    // 방위각 권한 (iOS)
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if(res !== 'granted') addLog("방위 권한 거부됨", 'error');
    }

    window.addEventListener('deviceorientation', (e) => {
        heading = e.webkitCompassHeading || (360 - e.alpha);
        document.getElementById('headingInfo').innerText = `${Math.round(heading)}° (${getDirName(heading)})`;
    }, true);

    // 주기적 서버 데이터 요청
    setInterval(fetchData, 2000);
});

async function fetchData() {
    if (!userPos.lat || !heading) return;

    try {
        addLog("서버 데이터 요청 중...");
        const res = await fetch(`/api/v1/front-signal?lat=${userPos.lat}&lng=${userPos.lng}&heading=${heading}`, {
            headers: { 'X-API-KEY': AUTH_KEY }
        });

        if (!res.ok) {
            const errBody = await res.json();
            setStepStatus('nearby', 'error', 'No Match');
            addLog(`매칭 실패: ${errBody.message || '교차로 없음'}`, 'error');
            return;
        }

        const data = await res.json();
        
        // Step 2 성공 (교차로 매칭)
        setStepStatus('nearby', 'success', data.itstNm);
        addLog(`교차로 매칭 성공: ${data.itstNm}`);

        // Step 3 성공 (신호 정보 수신)
        if (data.walk_remaining !== undefined) {
            setStepStatus('signal', 'success', `${data.direction_code.toUpperCase()} 수신`);
            updateSignalUI(data);
        } else {
            setStepStatus('signal', 'error', 'Data Empty');
            addLog("신호 데이터 필드 없음", 'error');
        }

    } catch (e) {
   
     setStepStatus('signal', 'error', 'Fetch Error');
        addLog(`통신 에러: ${e.message}`, 'error');
    }
}

function updateSignalUI(data) {
    const timer = document.getElementById('timer');
    const statusText = document.getElementById('statusText');
    const glow = document.getElementById('glow');

    timer.innerText = Math.floor(data.walk_remaining);
    
    if (data.status === 'green') {
        timer.style.color = '#10b981';
        statusText.innerText = "보행 가능 (GREEN)";
        statusText.style.color = '#10b981';
        glow.style.backgroundColor = '#10b981';
    } else {
        timer.style.color = '#ef4444';
        statusText.innerText = "대기 하세요 (RED)";
        statusText.style.color = '#ef4444';
        glow.style.backgroundColor = '#ef4444';
    }
}

function getDirName(h) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(h / 45) % 8];
}
