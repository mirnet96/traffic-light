/**
 * [ULTRA VISION AI] - api-data.js
 * * [수정 및 강화 사항]
 * 1. READY 상태 탈출: GPS 수신 전이라도 DEFAULT 좌표로 fetchSignalData 즉시 1회 실행
 * 2. GPS 옵션 완화: enableHighAccuracy를 false로 조정하여 수신율 향상 (code: 2 방지)
 * 3. 상태 표시 강화: API 호출 중임을 알리는 로직 추가
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './utils.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

// ── 기본 좌표 (GPS 미확보 시 fallback) ────────────────────────
const DEFAULT_LAT = 37.5665;
const DEFAULT_LNG = 126.9780;

// ── 상태 변수 ─────────────────────────────────────────────────
let lastLat = null, lastLng = null;
let compassHeading = 0;
let gpsHeading     = 0;
let lastIntersectionName = "";
let countdownInterval    = null;
let currentRemainCentis  = 0;
let naverMap = null;
let isFetching = false;
let isDataTabInitialized = false;
let timerRunning = false;
let mapRetryCount = 0;

// ─────────────────────────────────────────────────────────────
// 1. 초기화 (최초 1회만 실행)
// ─────────────────────────────────────────────────────────────
export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;

    // [FIX] 즉시 지도 표시
    renderMap(DEFAULT_LAT, DEFAULT_LNG);

    // [FIX] READY 탈출: GPS 기다리지 않고 기본 좌표로 즉시 데이터 로드 시도
    if (!lastLat) {
        lastLat = DEFAULT_LAT;
        lastLng = DEFAULT_LNG;
        const statusTextEl = document.getElementById('api-status-text');
        if (statusTextEl) statusTextEl.innerText = "STARTING...";
        fetchSignalData(); 
    }

    if (typeof DeviceOrientationEvent !== 'undefined') {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(state => { if (state === 'granted') listenOrientation(); })
                .catch(() => {});
        } else {
            listenOrientation();
        }
    }

    if (!navigator.geolocation) {
        const locationText = document.getElementById('location-text');
        if (locationText) locationText.innerHTML = "GPS를 지원하지 않는 기기입니다.";
        return;
    }

    // [FIX] enableHighAccuracy: false로 변경하여 Code 2 에러(Position Unavailable) 빈도 감소
    navigator.geolocation.watchPosition(
        async (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            if (pos.coords.heading !== null && pos.coords.heading >= 0) {
                gpsHeading = pos.coords.heading;
            }

            const locationText = document.getElementById('location-text');
            if (locationText) {
                const h = getEffectiveHeading();
                locationText.style.color = "";
                locationText.innerHTML =
                    `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} | ${Math.round(h)}° ${getDirectionLabel(h)}`;
            }

            renderMap(lastLat, lastLng);

            // 위치가 업데이트될 때마다 데이터 갱신
            if (!isFetching) fetchSignalData();
        },
        (err) => {
            console.warn("GPS Error:", err);
            const locationText = document.getElementById('location-text');
            if (locationText) {
                const messages = {
                    1: "위치 권한 거부됨",
                    2: "위치 확인 불가 (GPS 신호 약함)",
                    3: "위치 요청 시간 초과"
                };
                locationText.innerHTML = messages[err.code] || "GPS 오류";
                locationText.style.color = "#ef4444";
            }
        },
        { enableHighAccuracy: false, timeout: 15000 } // 옵션 완화
    );

    setInterval(fetchSignalData, 15000);
}

// ─────────────────────────────────────────────────────────────
// 2. 나침반 리스너 (기존과 동일)
// ─────────────────────────────────────────────────────────────
function listenOrientation() {
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);
}

function handleOrientation(e) {
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        compassHeading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
        compassHeading = (360 - e.alpha) % 360;
    }
}

function getEffectiveHeading() {
    if (compassHeading > 0) return compassHeading;
    return gpsHeading;
}

// ─────────────────────────────────────────────────────────────
// 3. V2X 신호 데이터 요청
// ─────────────────────────────────────────────────────────────
export async function fetchSignalData() {
    // [FIX] lastLat이 null인 경우를 대비해 초기화에서 DEFAULT를 할당하므로 진행 가능
    if (!lastLat || !lastLng || isFetching) return;
    isFetching = true;

    const statusTextEl = document.getElementById('api-status-text');

    try {
        const heading = getEffectiveHeading();

        const { data, error } = await supabase.functions.invoke('get-traffic-signal', {
            body: {
                lat: lastLat,
                lng: lastLng,
                heading,
                maxDistanceMeters: 300
            }
        });

        if (error) {
            if (error.message && error.message.includes("resources")) {
                if (statusTextEl) statusTextEl.innerText = "SVR OVER";
            }
            throw error;
        }

        if (data && data.signal) {
            const nameEl = document.getElementById('cross-name');
            if (nameEl) nameEl.innerText = `${data.intersectionName}`;

            const prefix = getDirectionPrefix(getEffectiveHeading());
            const serverCentis =
                data.signal[`${prefix}PdsgRmdrCs`] ||
                data.signal[`${prefix}StsgRmdrCs`] ||
                0;

            if (serverCentis > 0 && !timerRunning) {
                currentRemainCentis = serverCentis;
                startVisualTimer();

                if (data.intersectionName !== lastIntersectionName) {
                    speak(`${data.intersectionName} 연동.`);
                    lastIntersectionName = data.intersectionName;
                }
            } else if (serverCentis <= 0) {
                // 신호 정보가 없을 때
                if (statusTextEl && !timerRunning) statusTextEl.innerText = "WAIT";
            }
        } else {
             if (statusTextEl && !timerRunning) statusTextEl.innerText = "NO DATA";
        }
    } catch (err) {
        console.error("V2X Error:", err);
        if (statusTextEl && !timerRunning) statusTextEl.innerText = "API ERR";
    } finally {
        isFetching = false;
    }
}

// ─────────────────────────────────────────────────────────────
// 4. 카운트다운 타이머 (기존과 동일)
// ─────────────────────────────────────────────────────────────
function startVisualTimer() {
    const statusTextEl = document.getElementById('api-status-text');

    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    timerRunning = true;

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis = Math.max(0, currentRemainCentis - 10);
            const displaySec = (currentRemainCentis / 100).toFixed(1);

            if (statusTextEl) {
                statusTextEl.innerText = `${displaySec}s`;
                statusTextEl.className =
                    "text-7xl font-black text-blue-500 italic text-center animate-pulse";
            }
        } else {
            clearInterval(countdownInterval);
            countdownInterval = null;
            timerRunning = false;

            if (statusTextEl) {
                statusTextEl.innerText = "WAIT";
                statusTextEl.className = "text-5xl font-black text-zinc-700 text-center";
            }
        }
    }, 100);
}

// ─────────────────────────────────────────────────────────────
// 5. 지도 렌더링 (기존 로직 유지)
// ─────────────────────────────────────────────────────────────
function renderMap(lat, lng) {
    if (typeof naver === 'undefined' || !naver.maps) {
        if (mapRetryCount < 10) {
            mapRetryCount++;
            setTimeout(() => renderMap(lat, lng), 500);
        } else {
            const mapEl = document.getElementById('map');
            if (mapEl) mapEl.innerHTML = "<div class='p-4 text-red-500 text-xs text-center'>지도 SDK 로드 실패</div>";
        }
        return;
    }

    const position = new naver.maps.LatLng(lat, lng);

    if (!naverMap) {
        try {
            naverMap = new naver.maps.Map('map', {
                center: position,
                zoom: 18,
                logoControl: false,
                mapDataControl: false,
                scaleControl: true
            });

            new naver.maps.Marker({
                position,
                map: naverMap,
                icon: {
                    content: '<div style="width:16px;height:16px;background:#3b82f6;border:2px solid white;border-radius:50%;box-shadow:0 0 10px rgba(0,0,0,0.5);"></div>',
                    anchor: new naver.maps.Point(8, 8)
                }
            });
        } catch (e) {
            console.error("Naver Map Auth Error:", e);
        }
    } else {
        naverMap.setCenter(position);
    }
}

// ─────────────────────────────────────────────────────────────
// 6. 방향 유틸 (기존과 동일)
// ─────────────────────────────────────────────────────────────
function getDirectionPrefix(heading) {
    if (heading >= 315 || heading < 45)  return "nt";
    if (heading >= 45  && heading < 135) return "et";
    if (heading >= 135 && heading < 225) return "st";
    if (heading >= 225 && heading < 315) return "wt";
    return "nt";
}

function getDirectionLabel(heading) {
    if (heading >= 315 || heading < 45)  return "N";
    if (heading >= 45  && heading < 135) return "E";
    if (heading >= 135 && heading < 225) return "S";
    if (heading >= 225 && heading < 315) return "W";
    return "N";
}
