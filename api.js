/**
 * V2X 진단 및 데이터 통신 스크립트 (수정본)
 */

// 1. 전역 변수 선언
let userPos = { lat: null, lng: null };
let userHeading = 0;
const AUTH_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

// 2. 로그 함수 (가장 먼저 정의)
function addLog(msg, type = 'info') {
    const consoleBox = document.getElementById('logConsole');
    if (!consoleBox) return;
    const item = document.createElement('div');
    item.className = `log-item ${type === 'error' ? 'text-red-500 font-bold' : 'text-neutral-400'}`;
    const now = new Date();
    item.innerText = `[${now.toLocaleTimeString()}] ${msg}`;
    consoleBox.prepend(item);
    console.log(`[V2X LOG] ${msg}`); // 브라우저 콘솔에도 출력
}

// 3. 버튼 이벤트 리스너 (DOMContentLoaded로 감싸서 확실히 로드된 후 실행)
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    
    if (!startBtn) {
        console.error("시작 버튼(startBtn)을 찾을 수 없습니다.");
        return;
    }

    startBtn.onclick = async function() {
        addLog("버튼 클릭됨. 권한 요청 시작...");
        
        try {
            // A. 위치 정보 권한 요청
            if (!("geolocation" in navigator)) {
                throw new Error("이 브라우저는 GPS를 지원하지 않습니다.");
            }

            navigator.geolocation.watchPosition(
                (pos) => {
                    userPos.lat = pos.coords.latitude;
                    userPos.lng = pos.coords.longitude;
                    
                    document.getElementById('geoCoords').innerText = `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
                    updateStepStatus('gps', 'success', 'Connected');
                    
                    // 카카오 주소 변환 (함수 분리)
                    getAddressFromCoords(userPos.lat, userPos.lng);
                },
                (err) => {
                    addLog(`GPS 오류: ${err.message}`, 'error');
                    updateStepStatus('gps', 'error', 'Permission Denied');
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );

            // B. iOS 방위 권한 요청
            if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                addLog("iOS 방위 권한 요청 중...");
                const res = await DeviceOrientationEvent.requestPermission();
                addLog(`방위 권한 상태: ${res}`);
            }

            // C. 방위 이벤트 리스너 등록
            window.addEventListener('deviceorientation', (e) => {
                userHeading = e.webkitCompassHeading || (360 - e.alpha);
                if (userHeading) {
                    document.getElementById('headingInfo').innerText = `${Math.round(userHeading)}° (${getDirName(userHeading)})`;
                }
            }, true);

            // D. 주기적 데이터 요청 시작
            addLog("실시간 데이터 동기화 시작 (2초 간격)");
            setInterval(fetchData, 2000);

            // 버튼 상태 변경
            startBtn.disabled = true;
            startBtn.classList.replace('bg-blue-600', 'bg-neutral-800');
            startBtn.innerText = "진단 실행 중...";

        } catch (error) {
            addLog(`치명적 에러: ${error.message}`, 'error');
            alert("에러 발생: " + error.message);
        }
    };
});

// 4. 보조 함수들
function getAddressFromCoords(lat, lng) {
    if (typeof kakao === 'undefined' || !kakao.maps.services) {
        addLog("카카오 SDK 로드 실패", 'error');
        return;
    }
    const geocoder = new kakao.maps.services.Geocoder();
    geocoder.coord2Address(lng, lat, (result, status) => {
        if (status === kakao.maps.services.Status.OK) {
            document.getElementById('geoAddress').innerText = result[0].address.address_name;
        }
    });
}

function updateStepStatus(stepId, status, text) {
    const dot = document.getElementById(`step-${stepId}`);
    const label = document.getElementById(`step-${stepId}-val`);
    if (dot) dot.className = `status-dot dot-${status}`;
    if (label) {
        label.innerText = text;
        label.className = `text-[10px] ${status === 'success' ? 'text-emerald-400' : 'text-red-400'}`;
    }
}

async function fetchData() {
    if (!userPos.lat || !userHeading) return;

    try {
        const url = `https://iot.klueware.com/api/v1/front-signal?lat=${userPos.lat}&lng=${userPos.lng}&heading=${userHeading}`;
        const res = await fetch(url, { headers: { 'X-API-KEY': AUTH_KEY } });

        if (!res.ok) {
            const err = await res.json();
            updateStepStatus('nearby', 'error', 'No Match');
            return;
        }

        const data = await res.json();
        updateStepStatus('nearby', 'success', data.itstNm);
        updateStepStatus('signal', 'success', 'Received');
        
        // UI 업데이트 로직 (생략 - 이전과 동일)
        updateSignalUI(data);

    } catch (e) {
        console.error(e);
    }
}

function getDirName(h) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(h / 45) % 8];
}
