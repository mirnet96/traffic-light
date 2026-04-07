let userPos     = { lat: null, lng: null };
let userHeading = null;
let fetchTimer  = null;

const AUTH_KEY  = '7c76f496-b1f7-459f-85f1-ec9359276fce';
const API_BASE  = 'https://iot.klueware.com/api/v1';

document.addEventListener('DOMContentLoaded', () => {
    addLog('진단 준비 완료. 버튼을 눌러 시작하세요.');

    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function () {
        this.disabled = true;
        this.innerText = '진단 중...';
        this.classList.add('opacity-50');
        addLog('진단 프로세스 시작...');

        // iOS 방향 센서 권한 요청
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const perm = await DeviceOrientationEvent.requestPermission();
                addLog(`방향 센서 권한: ${perm}`);
            } catch (e) {
                addLog(`방향 센서 권한 오류: ${e.message}`, 'error');
            }
        }

        // 방향 센서 리스너 등록
        window.addEventListener('deviceorientation', (e) => {
            userHeading = e.webkitCompassHeading != null
                ? e.webkitCompassHeading
                : (360 - (e.alpha || 0));
            
            const headingInfoEl = document.getElementById('headingInfo');
            if (headingInfoEl) {
                headingInfoEl.innerText = `${Math.round(userHeading)}° (${getDirName(userHeading)})`;
            }
        }, true);

        // GPS 위치 추적 시작
        if (navigator.geolocation) {
            navigator.geolocation.watchPosition(successGPS, errorGPS, {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            });
        } else {
            addLog('GPS 미지원 브라우저입니다.', 'error');
            updateStepStatus('gps', 'error', '지원불가');
        }

        // 데이터 페칭 루프 시작
        scheduleFetch();
    };
});

function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchV2XData();
        scheduleFetch();
    }, 2000); // 2초 간격 갱신
}

function successGPS(pos) {
    userPos.lat = pos.coords.latitude;
    userPos.lng = pos.coords.longitude;

    const geoCoordsEl = document.getElementById('geoCoords');
    if (geoCoordsEl) {
        geoCoordsEl.innerText = `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
    }
    updateStepStatus('gps', 'success', '수신중');

    // 백엔드 프록시를 통한 주소 변환
    reverseGeocodeViaProxy(userPos.lat, userPos.lng);
}

function errorGPS(err) {
    addLog(`GPS 수신 실패: ${err.message}`, 'error');
    updateStepStatus('gps', 'error', '실패');
}

async function reverseGeocodeViaProxy(lat, lng) {
    try {
        const res = await fetch(`${API_BASE}/geocode?lat=${lat}&lng=${lng}`, {
            headers: { 'X-API-KEY': AUTH_KEY }
        });
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        const addr = data?.documents?.[0]?.address?.address_name;
        document.getElementById('geoAddress').innerText = addr || '주소 정보 없음';
    } catch (e) {
        document.getElementById('geoAddress').innerText = '주소 변환 실패';
    }
}

/**
 * 서버 API 규격에 맞춘 V2X 데이터 통신
 */
async function fetchV2XData() {
    if (userPos.lat === null || userHeading === null) return;

    // 1. 먼저 주변 교차로를 찾습니다 (/nearby)
    // 서버 응답이 [ {id: "101", ...}, ... ] 형태인 것을 가정합니다.
    const nearbyUrl = `${API_BASE}/nearby?lat=${userPos.lat}&lng=${userPos.lng}&radius=1000`;

    try {
        const nearbyRes = await fetch(nearbyUrl, { headers: { 'X-API-KEY': AUTH_KEY } });
        const intersections = await nearbyRes.json();

        if (!Array.isArray(intersections) || intersections.length === 0) {
            updateStepStatus('nearby', 'error', '근처 없음');
            updateStepStatus('signal', 'error', '대기');
            resetSignalUI();
            return;
        }

        // 가장 가까운 교차로 선택
        const target = intersections[0];
        const itstId = target.id || target.itstId;
        const itstNm = target.n || target.itstNm || '알 수 없는 교차로';

        updateStepStatus('nearby', 'success', itstNm);

        // 2. 선택된 교차로의 신호 정보를 가져옵니다 (/signal/{id})
        const signalUrl = `${API_BASE}/signal/${itstId}`;
        const signalRes = await fetch(signalUrl, { headers: { 'X-API-KEY': AUTH_KEY } });
        const signalData = await signalRes.json();

        if (signalData && signalData.status === 'success') {
            updateStepStatus('signal', 'success', '수신완료');
            updateSignalUI(signalData);
        } else {
            updateStepStatus('signal', 'error', '데이터없음');
            addLog(`신호 데이터 없음: ${itstNm}`, 'info');
            resetSignalUI();
        }

    } catch (e) {
        addLog(`통신 에러: ${e.message}`, 'error');
        updateStepStatus('signal', 'error', '통신오류');
        resetSignalUI();
    }
}

function updateSignalUI(data) {
    const timerEl  = document.getElementById('timer');
    const statusEl = document.getElementById('statusText');
    const glowEl   = document.getElementById('glow');
    const cardEl   = document.getElementById('signalCard');
    
    // 데이터 구조에 따른 필드 매핑 (phaseNm 또는 phase)
    const phaseRaw = data.phase || '';
    const phase    = phaseRaw.toLowerCase();
    const remain   = data.remainSec != null ? data.remainSec : '--';

    if (timerEl) timerEl.innerText = remain;

    if (phase.includes('green')) {
        if (timerEl) timerEl.style.color = '#00ee44';
        if (statusEl) {
            statusEl.innerText = '보행 신호 — 건너도 됩니다';
            statusEl.style.color = '#00ee44';
        }
        if (glowEl) glowEl.style.background = 'radial-gradient(ellipse at center, #00ee4420 0%, transparent 70%)';
        if (cardEl) cardEl.style.borderColor = '#00ee4430';
    } else if (phase.includes('red')) {
        if (timerEl) timerEl.style.color = '#ff3322';
        if (statusEl) {
            statusEl.innerText = '정지 신호 — 기다려 주세요';
            statusEl.style.color = '#ff3322';
        }
        if (glowEl) glowEl.style.background = 'radial-gradient(ellipse at center, #ff332220 0%, transparent 70%)';
        if (cardEl) cardEl.style.borderColor = '#ff332230';
    } else {
        if (timerEl) timerEl.style.color = '#9ca3af';
        if (statusEl) {
            statusEl.innerText = data.itstNm ? `${data.itstNm}` : '신호 수신 대기';
            statusEl.style.color = '#9ca3af';
        }
        if (glowEl) glowEl.style.background = '';
        if (cardEl) cardEl.style.borderColor = '';
    }
}

function resetSignalUI() {
    const timerEl = document.getElementById('timer');
    const statusTextEl = document.getElementById('statusText');
    const glowEl = document.getElementById('glow');

    if (timerEl) {
        timerEl.innerText = '--';
        timerEl.style.color = '#374151';
    }
    if (statusTextEl) {
        statusTextEl.innerText = '주변 교차로 탐색 중';
        statusTextEl.style.color = '#4b5563';
    }
    if (glowEl) glowEl.style.background = '';
}

function addLog(msg, type = 'info') {
    const box = document.getElementById('logConsole');
    if (!box) return;
    const item = document.createElement('div');
    item.className = `log-item py-0.5 border-b border-white/5 ${type === 'error' ? 'text-red-400' : 'text-neutral-400'}`;
    item.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    box.prepend(item);
}

function updateStepStatus(stepId, status, text) {
    const dot = document.getElementById(`step-${stepId}`);
    const val = document.getElementById(`step-${stepId}-val`);
    if (dot) dot.className = `status-dot dot-${status}`;
    if (val) {
        val.innerText = text;
        val.className = `text-[10px] uppercase font-bold ${status === 'success' ? 'text-emerald-400' : 'text-red-400'}`;
    }
}

function getDirName(h) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(h / 45) % 8];
}
