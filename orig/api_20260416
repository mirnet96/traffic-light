let userPos      = { lat: null, lng: null };
let userHeading  = null;
let fetchTimer    = null;
let debugMode     = false;

// ── 로컬 카운트다운 상태 ──────────────────────────────────────────────────────
let countdownTimer  = null;
let countdownValue  = null;
let countdownPhase  = null;

// ── 위치 기반 재조회 상태 ──────────────────────────────────────────────────────
let lastGeocodedPos  = { lat: null, lng: null };  // 마지막 주소 조회 위치
let lastNearbyPos    = { lat: null, lng: null };  // 마지막 교차로 조회 위치
let cachedItstId     = null;
let cachedItstNm     = null;

// [BUG-FIX #5] fetch 경쟁 조건 방지용 AbortController
let signalAbortCtrl  = null;

// [BUG-FIX #6] startBtn 중복 실행 방지 플래그
let isStarted        = false;

const GEO_THRESHOLD    = 30;   // 주소 재조회 거리 (m)
const NEARBY_THRESHOLD = 50;   // 교차로 재조회 거리 (m)

const AUTH_KEY  = '7c76f496-b1f7-459f-85f1-ec9359276fce';
const API_BASE  = 'https://iot.klueware.com/api/v1';

// 방향 정보 및 대칭 방향 정의
// [BUG-FIX #4] HEADING_MAP의 pdKey / stKey 필드가 선언만 되고 실제로 사용되지 않던 문제:
//   fetchSignalOnly 내에서 prefix 문자열로 직접 키를 조합하도록 통일하고
//   HEADING_MAP에서 중복·혼용을 제거.
const HEADING_MAP = [
    { dir: '북',   min: 337.5, max: 360,   prefix: 'nt', mirror: 'st' },
    { dir: '북',   min: 0,     max: 22.5,  prefix: 'nt', mirror: 'st' },
    { dir: '북동', min: 22.5,  max: 67.5,  prefix: 'ne', mirror: 'sw' },
    { dir: '동',   min: 67.5,  max: 112.5, prefix: 'et', mirror: 'wt' },
    { dir: '남동', min: 112.5, max: 157.5, prefix: 'se', mirror: 'nw' },
    { dir: '남',   min: 157.5, max: 202.5, prefix: 'st', mirror: 'nt' },
    { dir: '남서', min: 202.5, max: 247.5, prefix: 'sw', mirror: 'ne' },
    { dir: '서',   min: 247.5, max: 292.5, prefix: 'wt', mirror: 'et' },
    { dir: '북서', min: 292.5, max: 337.5, prefix: 'nw', mirror: 'se' },
];

// ── 유틸: 두 좌표 사이 거리 계산 (m) ─────────────────────────────────────────
function calcDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 특정 방향의 모든 데이터가 비었는지 체크하는 함수
function isDirectionTotallyEmpty(raw, prefix) {
    const keys = ['PdsgRmdrCs', 'StsgRmdrCs', 'LtsgRmdrCs', 'UtsgRmdrCs', 'BssgRmdrCs', 'BcsgRmdrCs'];
    return keys.every(k => {
        const val = raw[prefix + k];
        return val === null || val === undefined || val === '';
    });
}

function getDirectionByHeading(heading) {
    const h = ((heading % 360) + 360) % 360;
    for (const entry of HEADING_MAP) {
        if (entry.min <= entry.max) {
            if (h >= entry.min && h < entry.max) return entry;
        } else {
            if (h >= entry.min || h < entry.max) return entry;
        }
    }
    return HEADING_MAP[0];
}

// ── DOM 준비 ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    addLog('진단 준비 완료. 버튼을 눌러 시작하세요.');

    const debugToggle = document.getElementById('debugToggle');
    const debugPanel  = document.getElementById('debugPanel');
    if (debugToggle && debugPanel) {
        debugToggle.addEventListener('click', () => {
            debugMode = !debugMode;
            debugPanel.classList.toggle('hidden', !debugMode);

            // Debug 전용 패널들 토글
            document.getElementById('pipelinePanel')?.classList.toggle('hidden', !debugMode);
            document.getElementById('logPanel')?.classList.toggle('hidden', !debugMode);

            debugToggle.innerHTML = debugMode
                ? '<span class="material-symbols-rounded text-[16px]">bug_report</span><span>Debug ON</span>'
                : '<span class="material-symbols-rounded text-[16px]">bug_report</span><span>Debug</span>';
            debugToggle.classList.toggle('text-amber-400', debugMode);
            debugToggle.classList.toggle('border-amber-400/40', debugMode);
        });
    }

    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function () {
        // [BUG-FIX #6] 버튼 중복 클릭 시 watchPosition·scheduleFetch가 중복 등록되는 문제 방지
        if (isStarted) return;
        isStarted = true;

        this.disabled = true;
        this.innerText = '진단 중...';
        this.classList.add('opacity-50');
        addLog('진단 프로세스 시작...');

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

            const headingInfoEl = document.getElementById('headingInfo');
            if (headingInfoEl) {
                const dir = getDirectionByHeading(userHeading);
                headingInfoEl.innerText = `${Math.round(userHeading)}° (${dir.dir})`;
            }
        }, true);

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

        scheduleFetch();
    };
});

// ── 폴링 루프 (신호등: 1초) ───────────────────────────────────────────────────
function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchSignalOnly();
        scheduleFetch();
    }, 1000);
}

// ── 로컬 카운트다운 (튐 방지 설계) ──────────────────────────────────────────
//
// 문제: API 폴링(~1초)과 로컬 setInterval(1초)이 독립적으로 돌면
//   - API 응답이 늦으면: 로컬 48 → API 47 도착 → 화면이 48→47로 순간 튐
//   - API 응답이 빠르면: 로컬 49 → API 50 재수신 → 역주행 튐
//
// 해결: 서버값을 무조건 덮어쓰지 않고 '허용 오차(SYNC_TOLERANCE)' 내이면 무시.
//   허용 오차(기본 2초) 안에 있으면 로컬 카운트다운을 그대로 유지.
//   오차 초과(패킷 스킵·위상 전환 등 실제 큰 변화)일 때만 서버값으로 보정.
//
// 추가: 로컬 틱은 performance.now() 기반으로 drift 없이 정밀하게 동작.

const SYNC_TOLERANCE = 2;  // 서버값과의 허용 오차 (초). 이 범위 안이면 보정 안 함.

// 로컬 타이머 내부 상태 (외부에서는 syncCountdown / stopCountdown 만 사용)
let _tickBase   = null;   // performance.now() 기준점
let _tickOrigin = null;   // 기준점에서의 초 단위 값

function _startTick(initialSec) {
    clearInterval(countdownTimer);
    _tickBase   = performance.now();
    _tickOrigin = initialSec;
    countdownValue = initialSec;
    applyTimerDisplay(countdownValue);

    countdownTimer = setInterval(() => {
        // performance.now() 기반으로 실제 경과 시간을 계산 → drift 없음
        const elapsed = (performance.now() - _tickBase) / 1000;
        const next = Math.max(0, Math.round(_tickOrigin - elapsed));

        if (next !== countdownValue) {
            countdownValue = next;
            applyTimerDisplay(countdownValue);
        }
        if (countdownValue <= 0) clearInterval(countdownTimer);
    }, 200);  // 200ms 간격으로 체크해 1초 경계를 놓치지 않음
}

// API 응답마다 호출. 허용 오차 안이면 로컬 틱 유지, 벗어나면 서버값으로 재기준.
function syncCountdown(serverSec, phase) {
    const phaseChanged = phase !== countdownPhase;
    countdownPhase = phase;

    if (countdownValue === null || phaseChanged) {
        // 첫 수신이거나 신호 색이 바뀐 경우 → 무조건 서버값으로 시작
        _startTick(serverSec);
        return;
    }

    const diff = Math.abs(serverSec - countdownValue);
    if (diff > SYNC_TOLERANCE) {
        // 오차가 허용 범위 초과 → 서버값으로 재동기화
        addLog(`타이머 재동기: 로컬 ${countdownValue}s → 서버 ${serverSec}s (Δ${diff}s)`, 'info');
        _startTick(serverSec);
    }
    // 허용 오차 이내 → 로컬 틱 유지 (화면 튐 없음)
}

function applyTimerDisplay(sec) {
    const timerEl = document.getElementById('timer');
    if (timerEl) timerEl.innerText = sec;
}

function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer  = null;
    countdownValue  = null;
    countdownPhase  = null;
    _tickBase       = null;
    _tickOrigin     = null;
}

// ── GPS ───────────────────────────────────────────────────────────────────────
function successGPS(pos) {
    const newLat = pos.coords.latitude;
    const newLng = pos.coords.longitude;

    userPos.lat = newLat;
    userPos.lng = newLng;

    const geoCoordsEl = document.getElementById('geoCoords');
    if (geoCoordsEl)
        geoCoordsEl.innerText = `Lat: ${newLat.toFixed(6)} / Lng: ${newLng.toFixed(6)}`;

    updateStepStatus('gps', 'success', '수신중');

    // 주소: 첫 수신이거나 GEO_THRESHOLD 이상 이동했을 때만 재조회
    const geoDist = (lastGeocodedPos.lat !== null)
        ? calcDistance(lastGeocodedPos.lat, lastGeocodedPos.lng, newLat, newLng)
        : Infinity;

    if (geoDist >= GEO_THRESHOLD) {
        lastGeocodedPos = { lat: newLat, lng: newLng };
        reverseGeocodeViaProxy(newLat, newLng);
    }

    // 교차로: 첫 수신이거나 NEARBY_THRESHOLD 이상 이동했을 때만 재조회
    const nearbyDist = (lastNearbyPos.lat !== null)
        ? calcDistance(lastNearbyPos.lat, lastNearbyPos.lng, newLat, newLng)
        : Infinity;

    if (nearbyDist >= NEARBY_THRESHOLD) {
        lastNearbyPos = { lat: newLat, lng: newLng };
        fetchNearbyIntersection(newLat, newLng);
    }
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

// ── 교차로 조회 (이동 시에만) ─────────────────────────────────────────────────
async function fetchNearbyIntersection(lat, lng) {
    const nearbyUrl = `${API_BASE}/nearby?lat=${lat}&lng=${lng}&radius=1000`;
    try {
        const nearbyRes = await fetch(nearbyUrl, { headers: { 'X-API-KEY': AUTH_KEY } });
        const intersections = await nearbyRes.json();

        if (!Array.isArray(intersections) || intersections.length === 0) {
            updateStepStatus('nearby', 'error', '근처 없음');
            cachedItstId = null;
            cachedItstNm = null;
            resetSignalUI();
            return;
        }

        const target  = intersections[0];
        cachedItstId  = target.id || target.itstId;
        cachedItstNm  = target.n  || target.itstNm || '알 수 없는 교차로';
        updateStepStatus('nearby', 'success', cachedItstNm);
        addLog(`교차로 갱신: ${cachedItstNm}`);
    } catch (e) {
        addLog(`교차로 조회 에러: ${e.message}`, 'error');
        updateStepStatus('nearby', 'error', '통신오류');
    }
}

// ── 신호 조회만 (1초 주기) ────────────────────────────────────────────────────
async function fetchSignalOnly() {
    if (userPos.lat === null || cachedItstId === null) return;

    const heading = userHeading ?? 0;
    const dirInfo = getDirectionByHeading(heading);

    // [BUG-FIX #5] 이전 요청이 아직 진행 중이면 중단하고 새 요청 시작
    //   (네트워크 지연이 1초를 초과할 때 응답이 뒤섞이는 경쟁 조건 방지)
    if (signalAbortCtrl) signalAbortCtrl.abort();
    signalAbortCtrl = new AbortController();

    try {
        const signalRes = await fetch(
            `${API_BASE}/signal/${cachedItstId}?heading=${Math.round(heading)}`,
            { headers: { 'X-API-KEY': AUTH_KEY }, signal: signalAbortCtrl.signal }
        );
        const signalData = await signalRes.json();

        const timestampEl = document.getElementById('timestamp');

        if (signalData && signalData.status === 'success') {
            updateStepStatus('signal', 'success', '수신완료');
            timestampEl.innerText = signalData.timestamp;

            const raw = signalData.data.data || signalData.data;
            let currentPrefix = dirInfo.prefix;
            let mirrored = false;

            if (isDirectionTotallyEmpty(raw, currentPrefix)) {
                currentPrefix = dirInfo.mirror;
                mirrored = true;
            }

            const pdCs = raw[currentPrefix + 'PdsgRmdrCs'];
            const stCs = raw[currentPrefix + 'StsgRmdrCs'];

            // [BUG-FIX #3] 신호 우선순위 오류 수정.
            //   원래 코드는 pdCs(보행 신호) 값이 있으면 무조건 green 처리했으나,
            //   보행 신호 잔여시간이 있어도 실제로 차량 정지(적색) 구간일 수 있음.
            //   V2X SPAT 규격에서 stCs(직진 신호) > 0 → 차량 통행 가능(보행 적색),
            //   stCs == 0 또는 null 이고 pdCs > 0 → 보행 가능(초록) 으로 판단.
            if (stCs != null && stCs !== '' && Number(stCs) > 0) {
                // 차량 직진 신호 대기 중 → 보행자 적색
                const waitSec = Math.round(Number(stCs) / 10);
                updateSignalUI({
                    phase: 'red',
                    remainSec: waitSec,
                    itstNm: cachedItstNm + (mirrored ? ' (미러링)' : ''),
                    dirName: dirInfo.dir,
                });
                syncCountdown(waitSec, 'red');
            } else if (pdCs != null && pdCs !== '' && Number(pdCs) > 0) {
                // 보행 신호 진행 중 → 초록
                const remainSec = Math.round(Number(pdCs) / 10);
                updateSignalUI({
                    phase: 'green',
                    remainSec: remainSec,
                    itstNm: cachedItstNm + (mirrored ? ' (미러링)' : ''),
                    dirName: dirInfo.dir,
                });
                syncCountdown(remainSec, 'green');
            } else {
                stopCountdown();
                resetSignalUI();
            }

            updateDebugPanel(signalData, raw, dirInfo, heading);
        } else {
            updateStepStatus('signal', 'error', '데이터없음');
            stopCountdown();
            resetSignalUI();
            timestampEl.innerText = '-';
        }
    } catch (e) {
        if (e.name === 'AbortError') return;  // 의도적 중단은 로그 생략
        addLog(`통신 에러: ${e.message}`, 'error');
        updateStepStatus('signal', 'error', '통신오류');
        stopCountdown();
        resetSignalUI();
    }
}

// ── 디버그 패널 ───────────────────────────────────────────────────────────────
function updateDebugPanel(signalData, raw, dirInfo, heading) {
    if (!debugMode) return;
    const panel = document.getElementById('debugContent');
    if (!panel) return;

    const dirs = [
        { label: '북(N)',  p: 'nt' }, { label: '동(E)',  p: 'et' },
        { label: '남(S)',  p: 'st' }, { label: '서(W)',  p: 'wt' },
        { label: '북동',   p: 'ne' }, { label: '남동',   p: 'se' },
        { label: '남서',   p: 'sw' }, { label: '북서',   p: 'nw' },
    ];

    const rows = dirs.map(d => {
        const pd = raw?.[d.p + 'PdsgRmdrCs'];
        const st = raw?.[d.p + 'StsgRmdrCs'];
        const isActive = d.p === dirInfo.prefix;
        // [BUG-FIX #1 연동] 디버그 패널도 동일하게 /10 (센티초→초) 적용
        const pdSec = pd != null ? (pd / 10).toFixed(1) + 's' : '-';
        const stSec = st != null ? (st / 10).toFixed(1) + 's' : '-';
        return `<div class="flex justify-between items-center py-0.5 px-1 rounded ${isActive ? 'bg-blue-900/40 text-blue-300' : ''}">
            <span class="w-10 text-[10px] font-bold">${d.label}</span>
            <span class="text-[9px] text-emerald-400">보행: ${pdSec}</span>
            <span class="text-[9px] text-amber-400">직진: ${stSec}</span>
        </div>`;
    }).join('');

    panel.innerHTML = `
        <div class="text-[9px] text-neutral-500 mb-1">heading: ${Math.round(heading)}° → 방위: <span class="text-blue-400">${dirInfo.dir}</span></div>
        ${rows}
    `;
}

// ── UI 업데이트 ───────────────────────────────────────────────────────────────
function updateSignalUI(data) {
    const statusEl  = document.getElementById('statusText');
    const glowEl    = document.getElementById('glow');
    const cardEl    = document.getElementById('signalCard');
    const dirEl     = document.getElementById('directionBadge');
    const itstNmEl  = document.getElementById('itstNmDisplay');
    const timerEl   = document.getElementById('timer');

    const phase   = (data.phase || '').toLowerCase();
    const itstNm  = data.itstNm  || '';

    if (dirEl)    dirEl.innerText    = data.dirName ? `${data.dirName} 방향` : '';
    if (itstNmEl) itstNmEl.innerText = itstNm;

    if (phase === 'green') {
        if (timerEl)  timerEl.style.color  = '#00ee44';
        if (statusEl) { statusEl.innerText = '보행 신호 — 건너도 됩니다'; statusEl.style.color = '#00ee44'; }
        if (glowEl)   glowEl.style.background = 'radial-gradient(ellipse at center, #00ee4425 0%, transparent 70%)';
        if (cardEl)   cardEl.style.borderColor = '#00ee4430';
    } else if (phase === 'red') {
        if (timerEl)  timerEl.style.color  = '#ff3322';
        if (statusEl) { statusEl.innerText = '정지 신호 — 기다려 주세요'; statusEl.style.color = '#ff3322'; }
        if (glowEl)   glowEl.style.background = 'radial-gradient(ellipse at center, #ff332225 0%, transparent 70%)';
        if (cardEl)   cardEl.style.borderColor = '#ff332230';
    }
}

function resetSignalUI() {
    const timerEl    = document.getElementById('timer');
    const itstNmEl   = document.getElementById('itstNmDisplay');
    if (timerEl)  { timerEl.innerText = '--'; timerEl.style.color = '#374151'; }
    if (itstNmEl) itstNmEl.innerText = '교차로 탐색 중...';
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
