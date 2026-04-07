let userPos     = { lat: null, lng: null };
let userHeading = null;
let fetchTimer  = null;

const AUTH_KEY  = '7c76f496-b1f7-459f-85f1-ec9359276fce';
const API_BASE  = 'https://iot.klueware.com/api/v1';

// Kakao JS SDK 없이 index.html에서도 동작하도록
// <script src="//dapi.kakao.com/..."> 라인을 index.html / api.html 에서 제거해도 됩니다

document.addEventListener('DOMContentLoaded', () => {
    addLog('진단 준비 완료. 버튼을 눌러 시작하세요.');

    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function () {
        this.disabled = true;
        this.innerText = '진단 중...';
        addLog('진단 프로세스 시작...');

        // iOS 방향 센서 권한
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const perm = await DeviceOrientationEvent.requestPermission();
                addLog(`방향 센서 권한: ${perm}`);
            } catch (e) {
                addLog(`방향 센서 권한 오류: ${e.message}`, 'error');
            }
        }

        window.addEventListener('deviceorientation', (e) => {
            userHeading = e.webkitCompassHeading != null
                ? e.webkitCompassHeading
                : (360 - (e.alpha || 0));
            document.getElementById('headingInfo').innerText =
                `${Math.round(userHeading)}° (${getDirName(userHeading)})`;
        }, true);

        if (navigator.geolocation) {
            navigator.geolocation.watchPosition(successGPS, errorGPS, {
                enableHighAccuracy: true,
                timeout: 10000,
            });
        } else {
            addLog('GPS 미지원', 'error');
        }

        scheduleFetch();
    };
});

function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchV2XData();
        scheduleFetch();
    }, 2000);
}

function successGPS(pos) {
    userPos.lat = pos.coords.latitude;
    userPos.lng = pos.coords.longitude;

    document.getElementById('geoCoords').innerText =
        `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
    updateStepStatus('gps', 'success', '수신중');

    // Kakao JS SDK 대신 백엔드 프록시로 역지오코딩
    reverseGeocodeViaProxy(userPos.lat, userPos.lng);
}

function errorGPS(err) {
    addLog(`GPS 수신 실패: ${err.message}`, 'error');
    updateStepStatus('gps', 'error', '실패');
}

// 백엔드 프록시를 통한 역지오코딩 (Kakao JS SDK 불필요)
async function reverseGeocodeViaProxy(lat, lng) {
    try {
        const res  = await fetch(`${API_BASE}/geocode?lat=${lat}&lng=${lng}`, {
            headers: { 'X-API-KEY': AUTH_KEY }
        });
        const data = await res.json();
        const addr = data?.documents?.[0]?.address?.address_name;
        document.getElementById('geoAddress').innerText = addr || '주소 없음';
    } catch (e) {
        document.getElementById('geoAddress').innerText = '주소 변환 실패';
        addLog(`역지오코딩 에러: ${e.message}`, 'error');
    }
}

async function fetchV2XData() {
    if (userPos.lat === null || userHeading === null) return;

    const url = `${API_BASE}/front-signal` +
        `?lat=${userPos.lat}&lng=${userPos.lng}&heading=${Math.round(userHeading)}`;

    try {
        const res = await fetch(url, { headers: { 'X-API-KEY': AUTH_KEY } });

        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            const txt = await res.text();
            addLog(`비정상 응답: ${txt.substring(0, 80)}`, 'error');
            updateStepStatus('signal', 'error', '에러');
            resetSignalUI();
            return;
        }

        const result = await res.json();

        if (res.ok) {
            updateStepStatus('nearby', 'success', result.itstNm || '매칭됨');
            updateStepStatus('signal', 'success', '수신완료');
            updateSignalUI(result);
        } else {
            updateStepStatus('nearby', 'error', '매칭없음');
            updateStepStatus('signal', 'error', '없음');
            addLog(`서버: ${result.message || JSON.stringify(result)}`, 'error');
            resetSignalUI();
        }
    } catch (e) {
        addLog(`통신 에러: ${e.message}`, 'error');
        updateStepStatus('signal', 'error', '에러');
        resetSignalUI();
    }
}

function updateSignalUI(data) {
    const timerEl  = document.getElementById('timer');
    const statusEl = document.getElementById('statusText');
    const glowEl   = document.getElementById('glow');
    const cardEl   = document.getElementById('signalCard');
    const phase    = (data.phase || '').toLowerCase();

    timerEl.innerText = data.remainSec != null ? data.remainSec : '--';

    if (phase === 'green') {
        timerEl.style.color      = '#00ee44';
        statusEl.innerText       = '보행 신호 — 건너도 됩니다';
        statusEl.style.color     = '#00ee44';
        glowEl.style.background  = 'radial-gradient(ellipse at center, #00ee4420 0%, transparent 70%)';
        cardEl.style.borderColor = '#00ee4430';
    } else if (phase === 'red') {
        timerEl.style.color      = '#ff3322';
        statusEl.innerText       = '정지 신호 — 기다려 주세요';
        statusEl.style.color     = '#ff3322';
        glowEl.style.background  = 'radial-gradient(ellipse at center, #ff332220 0%, transparent 70%)';
        cardEl.style.borderColor = '#ff332230';
    } else {
        timerEl.style.color      = '#4b5563';
        statusEl.innerText       = data.itstNm ? `교차로: ${data.itstNm}` : '신호 수신 중';
        statusEl.style.color     = '#6b7280';
        glowEl.style.background  = '';
        cardEl.style.borderColor = '';
    }
}

function resetSignalUI() {
    document.getElementById('timer').innerText        = '--';
    document.getElementById('timer').style.color      = '#374151';
    document.getElementById('statusText').innerText   = '수신 대기 중';
    document.getElementById('statusText').style.color = '#4b5563';
    document.getElementById('glow').style.background  = '';
}

function addLog(msg, type = 'info') {
    const box  = document.getElementById('logConsole');
    const item = document.createElement('div');
    item.className = `log-item ${type === 'error' ? 'text-red-500' : 'text-neutral-400'}`;
    item.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    box.prepend(item);
}

function updateStepStatus(stepId, status, text) {
    const dot = document.getElementById(`step-${stepId}`);
    const val = document.getElementById(`step-${stepId}-val`);
    if (dot) dot.className = `status-dot dot-${status}`;
    if (val) {
        val.innerText = text;
        val.className = `text-[10px] ${status === 'success' ? 'text-emerald-400' : 'text-red-400'}`;
    }
}

function getDirName(h) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(h / 45) % 8];
}
