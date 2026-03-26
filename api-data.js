/**
 * [ULTRA VISION AI] - api-data.js
 *
 * [수정 사항]
 * - BUG FIX: import { speak } 구문 누락 수정
 * - BUG FIX: isDataTabInitialized 플래그로 watchPosition 중복 등록 방지
 * - BUG FIX: GPS heading 미지원 기기 대응 → DeviceOrientationEvent(나침반) 우선 사용
 * - BUG FIX: 카운트다운 중 15초 갱신이 currentRemainCentis를 덮어쓰는 문제 수정
 *            → 타이머 진행 중에는 서버 값 무시, 타이머 종료 후에만 갱신
 * - BUG FIX: centisecond 단위 정합성 확보 (100ms tick = 10 centisecond 감소)
 * - IMPROVE: 반경 300m 이내 교차로만 허용하도록 거리 검증 추가 (Edge Function 요청 파라미터)
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './utils.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

// ── 상태 변수 ─────────────────────────────────────────────────
let lastLat = null, lastLng = null;
let compassHeading = 0;          // DeviceOrientation 나침반 값 (우선)
let gpsHeading     = 0;          // GPS heading (보조)
let lastIntersectionName = "";
let countdownInterval    = null;
let currentRemainCentis  = 0;
let naverMap = null;
let isFetching = false;
let isDataTabInitialized = false; // 중복 초기화 방지 플래그
let timerRunning = false;         // 타이머 진행 중 플래그

// ─────────────────────────────────────────────────────────────
// 1. 초기화 (최초 1회만 실행)
// ─────────────────────────────────────────────────────────────
export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;

    // [FIX] GPS heading 대신 기기 나침반(DeviceOrientation) 우선 사용
    // - GPS heading은 이동 중에만 유효하고, 정지 시 0 또는 null 반환
    // - DeviceOrientationEvent.webkitCompassHeading은 iOS/Android 모두 지원
    if (typeof DeviceOrientationEvent !== 'undefined') {
        // iOS 13+ 권한 요청
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
                .then(state => { if (state === 'granted') listenOrientation(); })
                .catch(() => {}); // 거부 시 gpsHeading fallback
        } else {
            listenOrientation();
        }
    }

    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        async (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            // GPS heading은 나침반이 없을 때 보조로 사용
            if (pos.coords.heading !== null && pos.coords.heading >= 0) {
                gpsHeading = pos.coords.heading;
            }

            const locationText = document.getElementById('location-text');
            if (locationText) {
                const h = getEffectiveHeading();
                locationText.innerHTML =
                    `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} | ${Math.round(h)}° ${getDirectionLabel(h)}`;
            }

            renderMap(lastLat, lastLng);

            // 첫 위치 확보 시 즉시 1회 호출
            if (!lastIntersectionName && !isFetching) fetchSignalData();
        },
        (err) => console.warn("GPS:", err),
        { enableHighAccuracy: true }
    );

    // 15초 주기 갱신 (타이머 진행 중에는 교차로 이름만 갱신하고 카운트다운은 건드리지 않음)
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
    // webkitCompassHeading: iOS 전용 진북 기준 나침반
    // alpha: 일반 기기 (자기장 기준, 진북 아닐 수 있음)
    if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
        compassHeading = e.webkitCompassHeading;
    } else if (e.absolute && e.alpha !== null) {
        compassHeading = (360 - e.alpha) % 360;
    }
}

/** 나침반 값 우선, 없으면 GPS heading 사용 */
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
                // [FIX] 반경 300m 이내 교차로만 반환하도록 서버에 요청
                // Edge Function에서 이 값을 활용해 거리 필터링 필요
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
            // 교차로 이름 업데이트 (항상)
            const nameEl = document.getElementById('cross-name');
            if (nameEl) nameEl.innerText = `${data.intersectionName}`;

            const prefix = getDirectionPrefix(getEffectiveHeading());
            // 보행자 신호: pdsg(보행등) 우선, 없으면 stsg(차량등) 사용
            const serverCentis =
                data.signal[`${prefix}PdsgRmdrCs`] ||
                data.signal[`${prefix}StsgRmdrCs`] ||
                0;

            // [FIX] 타이머가 이미 진행 중이면 서버 값으로 덮어쓰지 않음
            // → 15초마다 갱신될 때 카운트다운이 튀는 문제 해결
            if (serverCentis > 0 && !timerRunning) {
                currentRemainCentis = serverCentis;
                startVisualTimer();

                if (data.intersectionName !== lastIntersectionName) {
                    speak(`${data.intersectionName} 연동.`);
                    lastIntersectionName = data.intersectionName;
                }
            } else if (serverCentis > 0 && timerRunning) {
                // 타이머 진행 중에는 이름만 갱신
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

    // [FIX] 기존 타이머 반드시 정리 후 새로 시작
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    timerRunning = true;

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            // [FIX] 100ms tick = 10 centisecond 감소 (1 centisecond = 0.01s)
            currentRemainCentis -= 10;
            const displaySec = Math.max(0, currentRemainCentis / 100).toFixed(1);

            if (statusTextEl) {
                statusTextEl.innerText = `${displaySec}s`;
                statusTextEl.className =
                    "text-7xl font-black text-blue-500 italic text-center animate-pulse";
            }
        } else {
            clearInterval(countdownInterval);
            countdownInterval = null;
            timerRunning = false;  // [FIX] 타이머 종료 플래그 해제

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
    if (heading >= 315 || heading < 45)  return "nt"; // 북
    if (heading >= 45  && heading < 135) return "et"; // 동
    if (heading >= 135 && heading < 225) return "st"; // 남
    if (heading >= 225 && heading < 315) return "wt"; // 서
    return "nt";
}

function getDirectionLabel(heading) {
    if (heading >= 315 || heading < 45)  return "N";
    if (heading >= 45  && heading < 135) return "E";
    if (heading >= 135 && heading < 225) return "S";
    if (heading >= 225 && heading < 315) return "W";
    return "N";
}
