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

// ── 경찰청 계획 기반 예측 상태 ────────────────────────────────────────────────
let cachedPlan       = null;   // { cycle, pdGreen, stGreen } (초 단위)
let planFetchedId    = null;   // 계획 캐시된 itstId
let _planEstActive   = false;  // 예측 모드 활성 여부

const GEO_THRESHOLD    = 30;   // 주소 재조회 거리 (m)
const NEARBY_THRESHOLD = 50;   // 교차로 재조회 거리 (m)

const AUTH_KEY  = '7c76f496-b1f7-459f-85f1-ec9359276fce';
const API_BASE  = 'https://iot.klueware.com/api/v1';

// 방향 정보 및 대칭 방향 정의
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
            document.getElementById('pipelinePanel')?.classList.toggle('hidden', !debugMode);
            document.getElementById('logPanel')?.classList.toggle('hidden', !debugMode);
            debugToggle.classList.toggle('text-amber-400', debugMode);
        });
    }

    const startBtn = document.getElementById('startBtn');
    if (!startBtn) return;

    startBtn.onclick = async function () {
        if (isStarted) return;
        isStarted = true;

        this.disabled = true;
        this.innerText = '진단 중...';
        this.classList.add('opacity-50');
        
        addLog('진단 프로세스 시작...');
        updateStepStatus('gps', 'error', '위치 확인 중');

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

// ── 폴링 루프 ──────────────────────────────────────────────────────────────────
function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
        await fetchSignalOnly();
        scheduleFetch();
    }, 1000);
}

// ── 로컬 카운트다운 틱 ──────────────────────────────────────────────────────────
const SYNC_TOLERANCE = 2;
let _tickBase   = null;
let _tickOrigin = null;

function _startTick(initialSec) {
    clearInterval(countdownTimer);
    _tickBase   = performance.now();
    _tickOrigin = initialSec;
    countdownValue = initialSec;
    applyTimerDisplay(countdownValue);

    countdownTimer = setInterval(() => {
        const elapsed = (performance.now() - _tickBase) / 1000;
        const next = Math.max(0, Math.round(_tickOrigin - elapsed));
        if (next !== countdownValue) {
            countdownValue = next;
            applyTimerDisplay(countdownValue);
        }
        if (countdownValue <= 0) clearInterval(countdownTimer);
    }, 200);
}

function syncCountdown(serverSec, phase) {
    const phaseChanged = phase !== countdownPhase;
    countdownPhase = phase;
    if (countdownValue === null || phaseChanged) {
        _startTick(serverSec);
        return;
    }
    const diff = Math.abs(serverSec - countdownValue);
    if (diff > SYNC_TOLERANCE) {
        _startTick(serverSec);
    }
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
    _tickBase        = null;
    _tickOrigin      = null;
}

// ── GPS ───────────────────────────────────────────────────────────────────────
function successGPS(pos) {
    const newLat = pos.coords.latitude;
    const newLng = pos.coords.longitude;
    userPos.lat = newLat;
    userPos.lng = newLng;

    const geoCoordsEl = document.getElementById('geoCoords');
    if (geoCoordsEl) geoCoordsEl.innerText = `Lat: ${newLat.toFixed(6)} / Lng: ${newLng.toFixed(6)}`;

    updateStepStatus('gps', 'success', '수신중');

    const geoDist = (lastGeocodedPos.lat !== null)
        ? calcDistance(lastGeocodedPos.lat, lastGeocodedPos.lng, newLat, newLng)
        : Infinity;
    if (geoDist >= GEO_THRESHOLD) {
        lastGeocodedPos = { lat: newLat, lng: newLng };
        reverseGeocodeViaProxy(newLat, newLng);
    }

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
        const data = await res.json();
        const addr = data?.documents?.[0]?.address?.address_name;
        document.getElementById('geoAddress').innerText = addr || '주소 정보 없음';
    } catch (e) {
        document.getElementById('geoAddress').innerText = '주소 변환 실패';
    }
}

// ── 교차로 조회 ────────────────────────────────────────────────────────────────
async function fetchNearbyIntersection(lat, lng) {
    const nearbyUrl = `${API_BASE}/nearby?lat=${lat}&lng=${lng}&radius=1000`;
    try {
        const nearbyRes = await fetch(nearbyUrl, { headers: { 'X-API-KEY': AUTH_KEY } });
        const intersections = await nearbyRes.json();
        if (!Array.isArray(intersections) || intersections.length === 0) {
            updateStepStatus('nearby', 'error', '근처 없음');
            cachedItstId = null;
            resetSignalUI();
            return;
        }
        const target   = intersections[0];
        cachedItstId   = target.id || target.itstId;
        cachedItstNm   = target.n  || target.itstNm || '알 수 없는 교차로';
        updateStepStatus('nearby', 'success', cachedItstNm);
        addLog(`교차로 갱신: ${cachedItstNm}`);
    } catch (e) {
        updateStepStatus('nearby', 'error', '통신오류');
    }
}

// ── 신호 조회 ─────────────────────────────────────────────────────────────────
// API 응답 구조 (test.log 기준):
//   signalData.data = { itstId, itstNm, trsmUtcTime, et: { pd, st, lt }, ... }
//   pd: 보행신호 잔여 (초, null 가능)
//   st: 직진신호 잔여 (초, null 가능)
//
// 신호 판단 우선순위:
//   1. pdCs > 0  → 보행 녹색 (건너도 됨),  remainSec = pdCs
//   2. stCs > 0  → 차량 직진 중 = 보행 적색, remainSec = stCs (직진 끝나면 보행 시작)
//   3. 둘 다 0   → 보행 적색 (잔여시간 불명, 0 표시)
//   4. 둘 다 null → 데이터 없음 → fallback
// ─────────────────────────────────────────────────────────────────────────────
async function fetchSignalOnly() {
    if (userPos.lat === null || cachedItstId === null) return;
    const heading = userHeading ?? 0;
    const dirInfo = getDirectionByHeading(heading);

    if (signalAbortCtrl) signalAbortCtrl.abort();
    signalAbortCtrl = new AbortController();

    let tDataOk = false;

    try {
        const signalRes = await fetch(
            `${API_BASE}/signal/${cachedItstId}?heading=${Math.round(heading)}`,
            { headers: { 'X-API-KEY': AUTH_KEY }, signal: signalAbortCtrl.signal }
        );
        const signalData = await signalRes.json();
        const timestampEl = document.getElementById('timestamp');

        if (signalData && (signalData.status === 'success' || signalData.data)) {
            // ── 방향 prefix 결정 (미러링 포함) ─────────────────────────────
            // 서버가 이미 usedPrefix / isMirrored 를 반환하므로 우선 사용
            // 없을 경우 클라이언트에서 직접 판단
            let currentPrefix = signalData.usedPrefix || dirInfo.prefix;
            let mirrored      = signalData.isMirrored  || false;

            // 서버가 usedPrefix를 안 주는 경우 클라이언트 fallback
            if (!signalData.usedPrefix) {
                const raw0 = signalData.data?.data || signalData.data || signalData;
                if (isDirectionTotallyEmpty(raw0, dirInfo.prefix)) {
                    currentPrefix = dirInfo.mirror;
                    mirrored = true;
                }
            }

            // ── data 객체에서 방향별 값 추출 ────────────────────────────────
            // 서버 응답: signalData.data = { et: { pd, st, lt }, ... }  (초 단위)
            // 또는 raw 형태: signalData.data = { etPdsgRmdrCs, etStsgRmdrCs, ... } (0.1초 단위)
            const dirData = signalData.data?.[currentPrefix];  // { pd, st, lt } 형태

            let pdSec = null;  // 보행 잔여 (초)
            let stSec = null;  // 직진 잔여 (초)

            if (dirData !== undefined && dirData !== null) {
                // 서버가 extractDirectionSummary 로 변환한 초 단위 값
                pdSec = (dirData.pd != null && dirData.pd !== '') ? Number(dirData.pd) : null;
                stSec = (dirData.st != null && dirData.st !== '') ? Number(dirData.st) : null;
            } else {
                // raw 0.1초 단위 fallback
                const rawFallback = signalData.data?.data || signalData.data || signalData;
                const pdRaw = rawFallback[currentPrefix + 'PdsgRmdrCs'];
                const stRaw = rawFallback[currentPrefix + 'StsgRmdrCs'];
                pdSec = (pdRaw != null && pdRaw !== '') ? Math.round(Number(pdRaw) / 10) : null;
                stSec = (stRaw != null && stRaw !== '') ? Math.round(Number(stRaw) / 10) : null;
            }

            const mirrorLabel = mirrored ? ' (미러링)' : '';
            const itstLabel   = cachedItstNm + mirrorLabel;

            // ── 신호 판단 ────────────────────────────────────────────────────
            if (pdSec !== null || stSec !== null) {
                // 유효한 데이터가 하나라도 있으면 실시간 모드
                tDataOk = true;
                _planEstActive = false;
                updateStepStatus('signal', 'success', '수신완료');
                if (timestampEl) timestampEl.innerText = signalData.timestamp || new Date().toLocaleTimeString();

                if (pdSec !== null && pdSec > 0) {
                    // 보행 녹색 활성
                    updateSignalUI({ phase: 'green', remainSec: pdSec, itstNm: itstLabel, dirName: dirInfo.dir });
                    syncCountdown(pdSec, 'green');
                    addLog(`[신호] 보행녹색 ${pdSec}s (pd=${pdSec})`);

                } else if (stSec !== null && stSec > 0) {
                    // 차량 직진 중 → 보행 적색
                    // 직진 잔여시간 = 보행 신호까지 대기 시간
                    updateSignalUI({ phase: 'red', remainSec: stSec, itstNm: itstLabel, dirName: dirInfo.dir });
                    syncCountdown(stSec, 'red');
                    addLog(`[신호] 보행적색 (직진중) ${stSec}s (st=${stSec})`);

                } else {
                    // 둘 다 0 → 적색이지만 잔여시간 불명
                    updateSignalUI({ phase: 'red', remainSec: 0, itstNm: itstLabel, dirName: dirInfo.dir });
                    syncCountdown(0, 'red');
                    addLog(`[신호] 보행적색 잔여불명 (pd=${pdSec} st=${stSec})`);
                }

                updateDebugPanel(signalData, signalData.data, dirInfo, heading);
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
        updateStepStatus('signal', 'error', '통신오류');
        addLog(`[신호] 통신 오류: ${e.message}`, 'error');
    }

    // t-data 에서 유효한 데이터를 못 받았으면 경찰청 계획 기반 예측
    if (!tDataOk) {
        updateStepStatus('signal', 'error', '예측 모드');
        await _fallbackPlanEstimate(dirInfo);
    }
}

// ── 경찰청 계획 기반 예측 ─────────────────────────────────────────────────────
async function _fallbackPlanEstimate(dirInfo) {
    if (!cachedItstId) return;

    // 계획 데이터 캐시 (동일 교차로면 재사용)
    if (planFetchedId !== cachedItstId || !cachedPlan) {
        cachedPlan = await _fetchIntersectionPlan(cachedItstId);
        planFetchedId = cachedItstId;
    }

    if (!cachedPlan) {
        if (!_planEstActive) {
            stopCountdown();
            resetSignalUI();
        }
        return;
    }

    _planEstActive = true;
    const now = new Date();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

    const plan = _selectActivePlan(cachedPlan.plans, now.getHours(), now.getMinutes());
    if (!plan) { resetSignalUI(); return; }

    const cycle   = plan.cycle;
    const pdGreen = plan.pdGreen;
    const stGreen = plan.stGreen;

    if (!cycle || cycle <= 0) { resetSignalUI(); return; }

    const offset     = plan.offset || 0;
    const posInCycle = ((nowSec - offset) % cycle + cycle) % cycle;

    let phase, remainSec;
    if (posInCycle < stGreen) {
        phase     = 'red';
        remainSec = Math.round(stGreen - posInCycle);
    } else if (posInCycle < stGreen + pdGreen) {
        phase     = 'green';
        remainSec = Math.round(stGreen + pdGreen - posInCycle);
    } else {
        phase     = 'red';
        remainSec = Math.round(cycle - posInCycle + stGreen);
    }

    const label = cachedItstNm ? `${cachedItstNm} (예측)` : '예측';
    updateSignalUI({ phase, remainSec, itstNm: label, dirName: dirInfo.dir });
    syncCountdown(remainSec, phase);

    const tsEl = document.getElementById('timestamp');
    if (tsEl) tsEl.innerText = `예측 · ${now.toLocaleTimeString()} · 주기${cycle}s`;

    addLog(`[예측] phase=${phase} remain=${remainSec}s cycle=${cycle}s pos=${Math.round(posInCycle)}s`);
}

// ── 경찰청 /intersection-plan API 호출 및 파싱 ────────────────────────────────
async function _fetchIntersectionPlan(itstId) {
    try {
        const res = await fetch(
            `${API_BASE}/intersection-plan/${itstId}`,
            { headers: { 'X-API-KEY': AUTH_KEY } }
        );
        if (!res.ok) return null;
        const data = await res.json();

        const items = Array.isArray(data) ? data
            : data?.response?.body?.items?.item
            ?? data?.items
            ?? data?.data
            ?? null;

        if (!items || !items.length) return null;

        const plans = items.map(item => {
            const hh     = parseInt(item.OPER_PLAN_HH ?? item.operPlanHh ?? 0, 10);
            const mi     = parseInt(item.OPER_PLAN_MI ?? item.operPlanMi ?? 0, 10);
            const cycle  = Math.round((parseInt(item.INT_OPER_CYCLE_VAL ?? item.intOperCycleVal ?? item.cycle ?? 0, 10)));
            const offset = Math.round((parseInt(item.INT_OPER_OFFSET_VAL ?? item.intOperOffsetVal ?? item.offset ?? 0, 10)));

            // 서버가 이미 초 단위로 변환한 경우 (normalizePlanItem 결과)
            if (item.aRings) {
                const aRings  = item.aRings;
                const stGreen = item.stGreen || 0;
                const pdGreen = item.pdGreen || 0;
                return { hh, mi, cycle, offset, stGreen, pdGreen };
            }

            // raw 경찰청 데이터인 경우 (0.1초 단위)
            const aRings = [1,2,3,4,5,6,7,8].map(i =>
                Math.round((parseInt(item[`A_RING_${i}_PHASE_VAL`] ?? item[`aRing${i}PhaseVal`] ?? 0, 10)) / 10)
            );
            const stGreen = (aRings[0] || 0) + (aRings[1] || 0);
            const pdGreen = (aRings[2] || 0) + (aRings[3] || 0);

            return { hh, mi, cycle, offset, stGreen, pdGreen };
        }).filter(p => p.cycle > 0);

        if (!plans.length) {
            addLog('[계획] cycle > 0 인 시간대 없음 — 예측 불가');
            return null;
        }
        addLog(`[계획] ${plans.length}개 시간대 로드`);
        return { plans };
    } catch (e) {
        addLog(`[계획] 조회 실패: ${e.message}`, 'error');
        return null;
    }
}

// 현재 시각에 해당하는 운영계획 선택 (가장 최근 시작 시간)
function _selectActivePlan(plans, curHH, curMI) {
    if (!plans?.length) return null;
    const curMin = curHH * 60 + curMI;
    let best = null, bestMin = -1;
    for (const p of plans) {
        const planMin = p.hh * 60 + p.mi;
        if (planMin <= curMin && planMin > bestMin) {
            bestMin = planMin;
            best    = p;
        }
    }
    return best ?? plans[plans.length - 1];
}

// ── 디버그 패널 ───────────────────────────────────────────────────────────────
function updateDebugPanel(signalData, dirSummary, dirInfo, heading) {
    if (!debugMode) return;
    const panel = document.getElementById('debugContent');
    if (!panel) return;
    const dirs = [
        { label: '북(N)', p: 'nt' }, { label: '동(E)', p: 'et' },
        { label: '남(S)', p: 'st' }, { label: '서(W)', p: 'wt' },
        { label: '북동',  p: 'ne' }, { label: '남동',  p: 'se' },
        { label: '남서',  p: 'sw' }, { label: '북서',  p: 'nw' },
    ];
    const rows = dirs.map(d => {
        // dirSummary = { nt: { pd, st, lt }, et: { pd, st, lt }, ... } (초 단위)
        const entry   = dirSummary?.[d.p];
        const pdSec   = entry?.pd != null ? entry.pd + 's' : '-';
        const stSec   = entry?.st != null ? entry.st + 's' : '-';
        const isActive = d.p === (signalData.usedPrefix || dirInfo.prefix);
        return `<div class="flex justify-between items-center py-0.5 px-1 rounded ${isActive ? 'bg-blue-900/40 text-blue-300' : ''}">
            <span class="w-10 text-[10px] font-bold">${d.label}</span>
            <span class="text-[9px] text-emerald-400">보행: ${pdSec}</span>
            <span class="text-[9px] text-amber-400">직진: ${stSec}</span>
        </div>`;
    }).join('');
    panel.innerHTML = `<div class="text-[9px] text-neutral-500 mb-1">heading: ${Math.round(heading)}° → 방위: <span class="text-blue-400">${dirInfo.dir}</span> / prefix: <span class="text-amber-400">${signalData.usedPrefix || dirInfo.prefix}</span>${signalData.isMirrored ? ' <span class="text-orange-400">[미러링]</span>' : ''}</div>${rows}`;
}

// ── UI 업데이트 ───────────────────────────────────────────────────────────────
function updateSignalUI(data) {
    const statusEl  = document.getElementById('statusText');
    const glowEl    = document.getElementById('glow');
    const cardEl    = document.getElementById('signalCard');
    const dirEl     = document.getElementById('directionBadge');
    const itstNmEl  = document.getElementById('itstNmDisplay');
    const timerEl   = document.getElementById('timer');
    const tsEl      = document.getElementById('timestamp');
    const isEst     = data.itstNm?.includes('(예측)');

    if (dirEl)    dirEl.innerText = data.dirName ? `${data.dirName} 방향` : '';
    if (itstNmEl) {
        itstNmEl.innerText = data.itstNm || '';
        itstNmEl.classList.toggle('estimated', !!isEst);
    }
    if (tsEl) tsEl.classList.toggle('estimated', !!isEst);

    updateStepStatus('plan', isEst ? 'success' : 'error', isEst ? '예측 중' : '-');

    if (data.phase === 'green') {
        if (timerEl) timerEl.style.color = isEst ? '#86efac' : '#00ee44';
        if (statusEl) {
            statusEl.innerText = isEst ? '보행 신호 (예측) — 참고용' : '보행 신호 — 건너도 됩니다';
            statusEl.style.color = isEst ? '#86efac' : '#00ee44';
        }
        if (glowEl) glowEl.style.background = 'radial-gradient(ellipse at center, #00ee4425 0%, transparent 70%)';
        if (cardEl) cardEl.style.borderColor = isEst ? '#86efac30' : '#00ee4430';
    } else {
        if (timerEl) timerEl.style.color = isEst ? '#fca5a5' : '#ff3322';
        if (statusEl) {
            statusEl.innerText = isEst ? '정지 신호 (예측) — 참고용' : '정지 신호 — 기다려 주세요';
            statusEl.style.color = isEst ? '#fca5a5' : '#ff3322';
        }
        if (glowEl) glowEl.style.background = 'radial-gradient(ellipse at center, #ff332225 0%, transparent 70%)';
        if (cardEl) cardEl.style.borderColor = isEst ? '#fca5a530' : '#ff332230';
    }
}

function resetSignalUI() {
    const timerEl  = document.getElementById('timer');
    const itstNmEl = document.getElementById('itstNmDisplay');
    const statusEl = document.getElementById('statusText');
    const glowEl   = document.getElementById('glow');
    const cardEl   = document.getElementById('signalCard');
    if (timerEl)  { timerEl.innerText = '--'; timerEl.style.color = '#374151'; }
    if (itstNmEl) itstNmEl.innerText = '교차로 탐색 중...';
    if (statusEl) { statusEl.innerText = '데이터 대기 중'; statusEl.style.color = '#6b7280'; }
    if (glowEl)   glowEl.style.background = '';
    if (cardEl)   cardEl.style.borderColor = '';
    _planEstActive = false;
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
