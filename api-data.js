/**
 * [ULTRA VISION AI] - api-data.js
 *
 * [버그 수정]
 * - BUG FIX: 네이버 지도 미표시 문제 수정
 *   원인 1 — index.html의 defer 제거 (SDK 로드 타이밍 문제, index.html 참고)
 *   원인 2 — GPS 실패 시 renderMap()이 한 번도 호출되지 않아 지도가 빈 상태로 남음
 *            → initDataTab() 호출 시 기본 좌표(서울 시청)로 지도를 즉시 초기화
 *            → GPS 오류 콜백에서도 UI 피드백 표시
 * - BUG FIX: 타이머 종료 직후 15초 주기 갱신이 겹치면 다음 카운트다운이 시작 안 되는 문제
 * - BUG FIX: currentRemainCentis 음수 방어 코드 추가
 * - BUG FIX: GPS 오류 시 UI 피드백 추가
 * - KEEP: isDataTabInitialized 플래그로 watchPosition 중복 등록 방지
 * - KEEP: centisecond 단위 정합성 확보 (100ms tick = 10 centisecond 감소)
 * - KEEP: 반경 300m 이내 교차로만 허용 (maxDistanceMeters)
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './utils.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

// ── 기본 좌표 (GPS 미확보 시 fallback) ────────────────────────
// [FIX] GPS가 실패하거나 느릴 때 지도가 빈 상태로 남는 문제 방지
//       서울 시청 좌표를 기본값으로 사용
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

// ─────────────────────────────────────────────────────────────
// 1. 초기화 (최초 1회만 실행)
// ─────────────────────────────────────────────────────────────
export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;

    // [FIX] 탭 진입 즉시 기본 좌표로 지도 초기화
    //       GPS가 느리거나 실패해도 지도가 바로 표시됨
    renderMap(DEFAULT_LAT, DEFAULT_LNG);

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

            // GPS 확보 후 실제 위치로 지도 이동
            renderMap(lastLat, lastLng);

            if (!lastIntersectionName && !isFetching) fetchSignalData();
        },
        // [FIX] GPS 오류 시 UI 피드백 (기본 좌표 지도는 이미 표시됨)
        (err) => {
            console.warn("GPS:", err);
            const locationText = document.getElementById('location-text');
            if (locationText) {
                const messages = {
                    1: "위치 권한이 거부되었습니다.",
                    2: "위치를 확인할 수 없습니다.",
                    3: "위치 요청 시간이 초과되었습니다."
                };
                locationText.innerHTML = messages[err.code] || "GPS 오류가 발생했습니다.";
                locationText.style.color = "#ef4444";
            }
        },
        { enableHighAccuracy: true }
    );

    setInterval(fetchSignalData, 15000);
}

// ─────────────────────────────────────────────────────────────
// 2. 나침반 리스너
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
            } else if (serverCentis > 0 && timerRunning) {
                if (data.intersectionName !== lastIntersectionName) {
                    lastIntersectionName = data.intersectionName;
                }
            }
        }
    } catch (err) {
        console.error("V2X Error:", err);
    } finally {
        isFetching = false;
    }
}

// ─────────────────────────────────────────────────────────────
// 4. 카운트다운 타이머
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
// 5. 지도 렌더링
// ─────────────────────────────────────────────────────────────
function renderMap(lat, lng) {
    if (typeof naver === 'undefined' || !naver.maps) {
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.innerText = "지도 인증 실패 (URL 등록 확인)";
        return;
    }
    const position = new naver.maps.LatLng(lat, lng);
    if (!naverMap) {
        naverMap = new naver.maps.Map('map', {
            center: position,
            zoom: 18,
            logoControl: false
        });
        new naver.maps.Marker({ position, map: naverMap });
    } else {
        naverMap.setCenter(position);
    }
}

// ─────────────────────────────────────────────────────────────
// 6. 방향 유틸
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
