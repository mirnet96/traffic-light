/**
 * V2X 진단 및 주소 변환 통합 스크립트
 *
 * 수정 이력:
 *  - [버그] heading === 0 일 때 falsy 평가로 요청 누락 → userHeading !== null 로 변경
 *  - [버그] updateSignalUI 미정의 → 구현 추가
 *  - [버그] setInterval 중복 등록 위험 → intervalId 변수로 관리
 *  - [개선] iOS DeviceOrientation 권한 요청을 GPS보다 먼저 처리
 *  - [개선] fetchV2XData를 setTimeout 체인으로 변경 (요청 중첩 방지)
 */

let userPos     = { lat: null, lng: null };
let userHeading = null;   // [수정] 초기값 null — 0° (정북) 과 미수신을 구별
let fetchTimer  = null;

const AUTH_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

/* ─── 버튼 이벤트는 Kakao SDK와 무관하게 DOM 준비 즉시 등록 ─── */
document.addEventListener('DOMContentLoaded', () => {
    addLog('진단 준비 완료. 버튼을 눌러 시작하세요.');

    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function () {
        this.disabled = true;
        this.innerText = '진단 중...';
        addLog('진단 프로세스 시작...');

        // [수정] iOS에서 DeviceOrientation 권한은 사용자 제스처 직후(동기)에 요청해야 팝업이 뜸
        // GPS watchPosition(비동기) 등록 전에 먼저 처리
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

        // GPS 추적 시작 — Kakao SDK는 successGPS 콜백 시점에 이미 로드 완료 상태
        if (navigator.geolocation) {
            navigator.geolocation.watchPosition(successGPS, errorGPS, {
                enableHighAccuracy: true,
                timeout: 5000,
            });
        } else {
            addLog('이 기기는 GPS를 지원하지 않습니다.', 'error');
        }

        // [수정] setInterval 대신 setTimeout 체인 — 응답 완료 후 재스케줄하여 중첩 방지
        scheduleFetch();
    };
});

/* ─── fetchV2XData 스케줄러 ─── */
function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchV2XData();
        scheduleFetch();   // 응답 완료(또는 에러) 후 다음 요청 예약
    }, 2000);
}

/* ─── GPS 성공 콜백 ─── */
function successGPS(pos) {
    userPos.lat = pos.coords.latitude;
    userPos.lng = pos.coords.longitude;

    document.getElementById('geoCoords').innerText =
        `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;
    updateStepStatus('gps', 'success', '수신중');

    // Kakao SDK가 로드된 경우에만 역지오코딩 실행
    if (typeof kakao !== 'undefined' && kakao.maps && kakao.maps.services) {
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.coord2Address(userPos.lng, userPos.lat, (result, status) => {
            if (status === kakao.maps.services.Status.OK) {
                document.getElementById('geoAddress').innerText =
                    result[0].address.address_name;
            }
        });
    }
}

/* ─── GPS 실패 콜백 ─── */
function errorGPS(err) {
    addLog(`GPS 수신 실패: ${err.message}`, 'error');
    updateStepStatus('gps', 'error', '실패');
}

/* ─── V2X 서버 요청 ─── */
async function fetchV2XData() {
    // [수정] userHeading !== null 로 변경 — heading 0° (정북) 도 정상 처리
    if (userPos.lat === null || userHeading === null) return;

    try {
        const response = await fetch(
            `https://iot.klueware.com/api/v1/front-signal` +
            `?lat=${userPos.lat}&lng=${userPos.lng}&heading=${userHeading}`,
            { headers: { 'X-API-KEY': AUTH_KEY } }
        );

        const result = await response.json();

        if (response.ok) {
            updateStepStatus('nearby', 'success', result.itstNm || '매칭됨');
            updateStepStatus('signal', 'success', '수신완료');
            updateSignalUI(result);   // [수정] 이전: 함수 미정의로 ReferenceError 발생
        } else {
            updateStepStatus('nearby', 'error', '매칭없음');
            updateStepStatus('signal', 'error', '없음');
            addLog(`서버 응답: ${result.message}`, 'error');
            resetSignalUI();
        }
    } catch (e) {
        addLog(`통신 에러: ${e.message}`, 'error');
        updateStepStatus('signal', 'error', '에러');
        resetSignalUI();
    }
}

/* ─── 신호 UI 갱신 ─── */
// [수정] 이전 코드에 함수 정의 없음 — 신규 구현
function updateSignalUI(data) {
    const timerEl     = document.getElementById('timer');
    const statusEl    = document.getElementById('statusText');
    const glowEl      = document.getElementById('glow');
    const cardEl      = document.getElementById('signalCard');

    // 서버 응답 필드: remainSec(잔여 초), phase('green'|'red'|...), itstNm(교차로명)
    const remainSec = data.remainSec != null ? data.remainSec : '--';
    const phase     = (data.phase || '').toLowerCase();

    timerEl.innerText = remainSec;

    if (phase === 'green') {
        timerEl.style.color    = '#00ee44';
        statusEl.innerText     = '보행 신호 — 건너도 됩니다';
        statusEl.style.color   = '#00ee44';
        glowEl.style.background  = 'radial-gradient(ellipse at center, #00ee4420 0%, transparent 70%)';
        cardEl.style.borderColor = '#00ee4430';
    } else if (phase === 'red') {
        timerEl.style.color    = '#ff3322';
        statusEl.innerText     = '정지 신호 — 기다려 주세요';
        statusEl.style.color   = '#ff3322';
        glowEl.style.background  = 'radial-gradient(ellipse at center, #ff332220 0%, transparent 70%)';
        cardEl.style.borderColor = '#ff332230';
    } else {
        timerEl.style.color    = '#4b5563';
        statusEl.innerText     = data.itstNm ? `교차로: ${data.itstNm}` : '신호 수신 중';
        statusEl.style.color   = '#6b7280';
        glowEl.style.background  = '';
        cardEl.style.borderColor = '';
    }
}

/* ─── 신호 UI 초기화 (매칭 없음·에러) ─── */
function resetSignalUI() {
    document.getElementById('timer').innerText       = '--';
    document.getElementById('timer').style.color     = '#374151';
    document.getElementById('statusText').innerText  = '수신 대기 중';
    document.getElementById('statusText').style.color = '#4b5563';
    document.getElementById('glow').style.background = '';
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
        val.innerText   = text;
        val.className   = `text-[10px] ${status === 'success' ? 'text-emerald-400' : 'text-red-400'}`;
    }
}

function getDirName(h) {
    const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
    return dirs[Math.round(h / 45) % 8];
}
