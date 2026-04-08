let userPos     = { lat: null, lng: null };
let userHeading = null;
let fetchTimer  = null;
let debugMode   = false;

// ── 로컬 카운트다운 상태 ──────────────────────────────────────────────────────
let countdownTimer  = null;   // setInterval 핸들
let countdownValue  = null;   // 현재 표시 중인 초
let countdownPhase  = null;   // 현재 phase ('green' | 'red')

const AUTH_KEY  = '7c76f496-b1f7-459f-85f1-ec9359276fce';
const API_BASE  = 'https://iot.klueware.com/api/v1';

const HEADING_MAP = [
    { dir: '북',   min: 337.5, max: 360,   pdKey: 'ntPdsgRmdrCs', stKey: 'ntStsgRmdrCs', phKey: 'ntPhaseNm' },
    { dir: '북',   min: 0,     max: 22.5,  pdKey: 'ntPdsgRmdrCs', stKey: 'ntStsgRmdrCs', phKey: 'ntPhaseNm' },
    { dir: '북동', min: 22.5,  max: 67.5,  pdKey: 'nePdsgRmdrCs', stKey: 'neStsgRmdrCs', phKey: 'nePhaseNm' },
    { dir: '동',   min: 67.5,  max: 112.5, pdKey: 'etPdsgRmdrCs', stKey: 'etStsgRmdrCs', phKey: 'etPhaseNm' },
    { dir: '남동', min: 112.5, max: 157.5, pdKey: 'sePdsgRmdrCs', stKey: 'seStsgRmdrCs', phKey: 'sePhaseNm' },
    { dir: '남',   min: 157.5, max: 202.5, pdKey: 'stPdsgRmdrCs', stKey: 'stStsgRmdrCs', phKey: 'stPhaseNm' },
    { dir: '남서', min: 202.5, max: 247.5, pdKey: 'swPdsgRmdrCs', stKey: 'swStsgRmdrCs', phKey: 'swPhaseNm' },
    { dir: '서',   min: 247.5, max: 292.5, pdKey: 'wtPdsgRmdrCs', stKey: 'wtStsgRmdrCs', phKey: 'wtPhaseNm' },
    { dir: '북서', min: 292.5, max: 337.5, pdKey: 'nwPdsgRmdrCs', stKey: 'nwStsgRmdrCs', phKey: 'nwPhaseNm' },
];

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

// ── 폴링 루프 ─────────────────────────────────────────────────────────────────
function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchV2XData();
        scheduleFetch();
    }, 2000);
}

// ── 로컬 카운트다운 ───────────────────────────────────────────────────────────
/**
 * API에서 새 잔여시간(초)을 받으면 이 함수로 카운트다운을 (재)시작합니다.
 * 1초마다 화면 숫자를 -1 하므로 폴링 주기와 무관하게 부드럽게 줄어듭니다.
 */
function startCountdown(remainSec, phase) {
    // 이전 타이머 정리
    clearInterval(countdownTimer);

    countdownValue = remainSec;
    countdownPhase = phase;

    // 즉시 반영
    applyTimerDisplay(countdownValue, countdownPhase);

    countdownTimer = setInterval(() => {
        if (countdownValue <= 0) {
            clearInterval(countdownTimer);
            return;
        }
        countdownValue -= 1;
        applyTimerDisplay(countdownValue, countdownPhase);
    }, 1000);
}

function applyTimerDisplay(sec, phase) {
    const timerEl = document.getElementById('timer');
    if (timerEl) timerEl.innerText = sec;
}

function stopCountdown() {
    clearInterval(countdownTimer);
    countdownValue = null;
    countdownPhase = null;
}

// ── GPS ───────────────────────────────────────────────────────────────────────
function successGPS(pos) {
    userPos.lat = pos.coords.latitude;
    userPos.lng = pos.coords.longitude;

    const geoCoordsEl = document.getElementById('geoCoords');
    if (geoCoordsEl)
        geoCoordsEl.innerText = `Lat: ${userPos.lat.toFixed(6)} / Lng: ${userPos.lng.toFixed(6)}`;

    updateStepStatus('gps', 'success', '수신중');
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

// ── V2X 메인 로직 ─────────────────────────────────────────────────────────────
async function fetchV2XData() {
    if (userPos.lat === null) return;

    const heading = userHeading ?? 0;
    const dirInfo = getDirectionByHeading(heading);

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

        const target  = intersections[0];
        const itstId  = target.id || target.itstId;
        const itstNm  = target.n  || target.itstNm || '알 수 없는 교차로';

        updateStepStatus('nearby', 'success', itstNm);
        addLog(`교차로 매칭: ${itstNm} (${itstId})`, 'info');

        const signalUrl = `${API_BASE}/signal/${itstId}?heading=${Math.round(heading)}`;
        const signalRes = await fetch(signalUrl, { headers: { 'X-API-KEY': AUTH_KEY } });
        const signalData = await signalRes.json();

        if (signalData && signalData.status === 'success') {
            updateStepStatus('signal', 'success', '수신완료');

            const raw  = signalData.data || signalData;
            const pdCs = raw[dirInfo.pdKey];  // 보행신호 잔여시간 (센티초)

            if (pdCs != null && pdCs > 0) {
                // ✅ 센티초 → 초: / 100
                const remainSec = Math.round(pdCs / 100);
                updateSignalUI({
                    phase:     'green',
                    remainSec: remainSec,
                    itstNm:    itstNm,
                    dirName:   dirInfo.dir,
                });
                startCountdown(remainSec, 'green');
            } else {
                const stCs    = raw[dirInfo.stKey];
                // ✅ 센티초 → 초: / 100
                const waitSec = stCs != null ? Math.round(stCs / 100) : (signalData.remainSec || 0);
                updateSignalUI({
                    phase:     'red',
                    remainSec: waitSec,
                    itstNm:    itstNm,
                    dirName:   dirInfo.dir,
                });
                startCountdown(waitSec, 'red');
            }

            updateDebugPanel(signalData, raw, dirInfo, heading);

        } else {
            updateStepStatus('signal', 'error', '데이터없음');
            addLog(`신호 데이터 없음: ${itstNm}`, 'info');
            stopCountdown();
            resetSignalUI();
        }

    } catch (e) {
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
        { label: '북(N)',  pd: 'ntPdsgRmdrCs', st: 'ntStsgRmdrCs' },
        { label: '동(E)',  pd: 'etPdsgRmdrCs', st: 'etStsgRmdrCs' },
        { label: '남(S)',  pd: 'stPdsgRmdrCs', st: 'stStsgRmdrCs' },
        { label: '서(W)',  pd: 'wtPdsgRmdrCs', st: 'wtStsgRmdrCs' },
        { label: '북동',   pd: 'nePdsgRmdrCs', st: 'neStsgRmdrCs' },
        { label: '남동',   pd: 'sePdsgRmdrCs', st: 'seStsgRmdrCs' },
        { label: '남서',   pd: 'swPdsgRmdrCs', st: 'swStsgRmdrCs' },
        { label: '북서',   pd: 'nwPdsgRmdrCs', st: 'nwStsgRmdrCs' },
    ];

    const rows = dirs.map(d => {
        const pd = raw?.[d.pd];
        const st = raw?.[d.st];
        const isActive = d.pd === dirInfo.pdKey;
        // ✅ 디버그 패널도 센티초 → 초: / 100
        const pdSec = pd != null ? (pd / 100).toFixed(1) + 's' : '-';
        const stSec = st != null ? (st / 100).toFixed(1) + 's' : '-';
        return `<div class="flex justify-between items-center py-0.5 px-1 rounded ${isActive ? 'bg-blue-900/40 text-blue-300' : ''}">
            <span class="w-10 text-[10px] font-bold">${d.label}</span>
            <span class="text-[9px] text-emerald-400">보행: ${pdSec}</span>
            <span class="text-[9px] text-amber-400">직진: ${stSec}</span>
        </div>`;
    }).join('');

    panel.innerHTML = `
        <div class="text-[9px] text-neutral-500 mb-1">heading: ${Math.round(heading)}° → 선택방위: <span class="text-blue-400">${dirInfo.dir}</span></div>
        <div class="text-[9px] text-neutral-500 mb-2">itstNm: ${signalData.itstNm || '-'} / phase: ${signalData.phase || '-'} / remain: ${signalData.remainSec ?? '-'}s</div>
        ${rows}
        <div class="mt-2 text-[9px] text-neutral-600 break-all">${JSON.stringify(raw).slice(0, 300)}…</div>
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
    const dirName = data.dirName || '';
    const itstNm  = data.itstNm  || '';

    // 교차로명 + 방향 표시
    if (dirEl)    dirEl.innerText    = dirName ? `${dirName} 방향` : '';
    if (itstNmEl) itstNmEl.innerText = itstNm;

    if (phase.includes('green')) {
        if (timerEl)  timerEl.style.color  = '#00ee44';
        if (statusEl) { statusEl.innerText = '보행 신호 — 건너도 됩니다'; statusEl.style.color = '#00ee44'; }
        if (glowEl)   glowEl.style.background = 'radial-gradient(ellipse at center, #00ee4425 0%, transparent 70%)';
        if (cardEl)   cardEl.style.borderColor = '#00ee4430';
    } else if (phase.includes('red')) {
        if (timerEl)  timerEl.style.color  = '#ff3322';
        if (statusEl) { statusEl.innerText = '정지 신호 — 기다려 주세요'; statusEl.style.color = '#ff3322'; }
        if (glowEl)   glowEl.style.background = 'radial-gradient(ellipse at center, #ff332225 0%, transparent 70%)';
        if (cardEl)   cardEl.style.borderColor = '#ff332230';
    } else {
        if (timerEl)  timerEl.style.color  = '#9ca3af';
        if (statusEl) { statusEl.innerText = itstNm || '신호 수신 대기'; statusEl.style.color = '#9ca3af'; }
        if (glowEl)   glowEl.style.background = '';
        if (cardEl)   cardEl.style.borderColor = '';
    }
}

function resetSignalUI() {
    const timerEl    = document.getElementById('timer');
    const statusEl   = document.getElementById('statusText');
    const glowEl     = document.getElementById('glow');
    const dirEl      = document.getElementById('directionBadge');
    const itstNmEl   = document.getElementById('itstNmDisplay');

    if (timerEl)  { timerEl.innerText = '--'; timerEl.style.color = '#374151'; }
    if (statusEl) { statusEl.innerText = '주변 교차로 탐색 중'; statusEl.style.color = '#4b5563'; }
    if (glowEl)   glowEl.style.background = '';
    if (dirEl)    dirEl.innerText = '';
    if (itstNmEl) itstNmEl.innerText = '';
}

// ── 공용 유틸 ─────────────────────────────────────────────────────────────────
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
