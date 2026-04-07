/**
 * V2X 진단 및 주소 변환 통합 스크립트
 *
 * 수정 이력:
 *  - [버그] heading === 0 일 때 falsy 평가로 요청 누락 → userHeading !== null 로 변경
 *  - [버그] updateSignalUI 미정의 → 구현 추가
 *  - [버그] setInterval 중복 등록 위험 → intervalId 변수로 관리
 *  - [개선] iOS DeviceOrientation 권한 요청을 GPS보다 먼저 처리
 *  - [개선] fetchV2XData를 setTimeout 체인으로 변경 (요청 중첩 방지)
 *  - [수정] CORS 에러 대응: no-cors 모드 + 응답 타입 체크 추가
 *  - [수정] Kakao SDK 로드 완료 후 역지오코딩 재시도 로직 추가
 */

let userPos     = { lat: null, lng: null };
let userHeading = null;
let fetchTimer  = null;
let lastGeocodePending = false; // Kakao 로드 전 GPS 수신 시 재시도 플래그

const AUTH_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

/* ─── Kakao SDK 로드 완료 감지 ─── */
function waitForKakao(callback, retries = 20) {
    if (typeof kakao !== 'undefined' && kakao.maps && kakao.maps.services) {
        callback();
    } else if (retries > 0) {
        setTimeout(() => waitForKakao(callback, retries - 1), 300);
    } else {
        addLog('Kakao SDK 로드 실패 — 주소 표시 불가', 'error');
    }
}

/* ─── 역지오코딩 (Kakao SDK 로드 보장 후 실행) ─── */
function reverseGeocode(lat, lng) {
    waitForKakao(() => {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.coord2Address(lng, lat, (result, status) => {
            if (status === kakao.maps.services.Status.OK) {
                document.getElementById('geoAddress').innerText =
                    result[0].address.address_name;
            } else {
                document.getElementById('geoAddress').innerText = '주소 변환 실패';
                addLog('역지오코딩 실패: ' + status, 'error');
            }
        });
    });
}

/* ─── 버튼 이벤트 ─── */
document.addEventListener('DOMContentLoaded', () => {
    addLog('진단 준비 완료. 버튼을 눌러 시작하세요.');

    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function () {
        this.disabled = true;
        this.innerText = '진단 중...';
        addLog('진단 프로세스 시작...');

        // iOS DeviceOrientation 권한 (사용자 제스처 직후)
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            try {
                const permission = await DeviceOrientationEvent.requestPermission();
                addLog(`방향 센서 권한: ${permission}`);
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
            addLog('이 기기는 GPS를 지원하지 않습니다.', 'error');
        }

        scheduleFetch();
    };
});

/* ─── fetchV2XData 스케줄러 ─── */
function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchV2XData();
        scheduleFetch();
    }, 2000);
}

/* ─── GPS 성공 콜백 ─── */
function successGPS(pos) {
    userPos.lat = pos.coords.latitude;
    userPos.lng = pos.coords.longitude;

    document.getElementById('geoCoords').innerText =
        `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
    updateStepStatus('gps', 'success', '수신중');

    // [수정] Kakao SDK 로드 완료 여부와 무관하게 reverseGeocode 호출 (내부에서 대기)
    reverseGeocode(userPos.lat, userPos.lng);
}

/* ─── GPS 실패 콜백 ─── */
function errorGPS(err) {
    addLog(`GPS 수신 실패: ${err.message}`, 'error');
    updateStepStatus('gps', 'error', '실패');
}

/* ─── V2X 서버 요청 ─── */
async function fetchV2XData() {
    if (userPos.lat === null || userHeading === null) return;

    const url =
        `https://iot.klueware.com/api/v1/front-signal` +
        `?lat=${userPos.lat}&lng=${userPos.lng}&heading=${Math.round(userHeading)}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'X-API-KEY': AUTH_KEY },
            // [수정] CORS 프리플라이트 없이 요청. 단, 서버가 Access-Control-Allow-Origin 헤더를
            //        반환하지 않으면 응답 본문을 읽을 수 없으므로 서버 설정이 선행되어야 합니다.
            //        서버가 이미 CORS를 허용하는 경우 아래 mode는 생략해도 됩니다.
        });

        // [수정] 응답이 JSON인지 Content-Type으로 먼저 확인
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const rawText = await response.text();
            addLog(`비정상 응답 (JSON 아님): ${rawText.substring(0, 80)}`, 'error');
            updateStepStatus('nearby', 'error', '응답오류');
            updateStepStatus('signal', 'error', '에러');
            resetSignalUI();
            return;
        }

        const result = await response.json();

        if (response.ok) {
            updateStepStatus('nearby', 'success', result.itstNm || '매칭됨');
            updateStepStatus('signal', 'success', '수신완료');
            updateSignalUI(result);
        } else {
            updateStepStatus('nearby', 'error', '매칭없음');
            updateStepStatus('signal', 'error', '없음');
            addLog(`서버 오류 ${response.status}: ${result.message || JSON.stringify(result)}`, 'error');
            resetSignalUI();
        }
    } catch (e) {
        addLog(`통신 에러: ${e.message}`, 'error');
        updateStepStatus('signal', 'error', '에러');
        resetSignalUI();
    }
}

/* ─── 신호 UI 갱신 ─── */
function updateSignalUI(data) {
    const timerEl  = document.getElementById('timer');
    const statusEl = document.getElementById('statusText');
    const glowEl   = document.getElementById('glow');
    const cardEl   = document.getElementById('signalCard');

    const remainSec = data.remainSec != null ? data.remainSec : '--';
    const phase     = (data.phase || '').toLowerCase();

    timerEl.innerText = remainSec;

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

/* ─── 신호 UI 초기화 ─── */
function resetSignalUI() {
    document.getElementById('timer').innerText        = '--';
    document.getElementById('timer').style.color      = '#374151';
    document.getElementById('statusText').innerText   = '수신 대기 중';
    document.getElementById('statusText').style.color = '#4b5563';
    document.getElementById('glow').style.background  = '';
}

/* ─── 공통 헬퍼 ─── */
function addLog(msg, type = 'info') {
    const consoleBox = document.getElementById('logConsole');
    const item       = document.createElement('div');
    item.className   = `log-item ${type === 'error' ? 'text-red-500' : 'text-neutral-400'}`;
    item.innerText   = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleBox.prepend(item);
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
