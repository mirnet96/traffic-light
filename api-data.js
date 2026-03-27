/**
 * [ULTRA VISION AI] - api-data.js (Laravel API Integrated)
 * 1. Supabase 대신 iot.klueware.com 라라벨 서버 연동
 * 2. 2단계 호출: 근처 교차로 검색 -> 실시간 신호 데이터 획득
 * 3. 방향(Bearing) 기반 신호 필터링 적용
 */
import { speak } from './utils.js';

// ── 설정 ──────────────────────────────────────────────────────
const API_BASE_URL = 'https://iot.klueware.com/api/v1';
const API_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

// ── 기본 좌표 (GPS 미확보 시 fallback) ────────────────────────
const DEFAULT_LAT = 37.5665;
const DEFAULT_LNG = 126.9780;

// ── 상태 변수 ─────────────────────────────────────────────────
let lastLat = null, lastLng = null;
let compassHeading = 0;
let gpsHeading = 0;
let lastIntersectionId = "";
let lastIntersectionName = "";
let countdownInterval = null;
let currentRemainCentis = 0;
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

    renderMap(DEFAULT_LAT, DEFAULT_LNG);

    // 즉시 기본 좌표로 데이터 로드 시도
    if (!lastLat) {
        lastLat = DEFAULT_LAT;
        lastLng = DEFAULT_LNG;
        const statusTextEl = document.getElementById('api-status-text');
        if (statusTextEl) statusTextEl.innerText = "STARTING...";
        fetchSignalData(); 
    }

    // 방향 센서 초기화
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
        if (locationText) locationText.innerHTML = "GPS 미지원 기기";
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
                locationText.innerHTML = `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} | ${Math.round(h)}° ${getDirectionLabel(h)}`;
            }

            renderMap(lastLat, lastLng);
            if (!isFetching) fetchSignalData();
        },
        (err) => {
            console.warn("GPS Error:", err);
            const locationText = document.getElementById('location-text');
            if (locationText) {
                const messages = { 1: "권한 거부", 2: "신호 약함", 3: "시간 초과" };
                locationText.innerHTML = messages[err.code] || "GPS 오류";
                locationText.style.color = "#ef4444";
            }
        },
        { enableHighAccuracy: false, timeout: 15000 }
    );

    setInterval(fetchSignalData, 15000);
}

// ─────────────────────────────────────────────────────────────
// 2. 방향 및 센서 처리
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
    return compassHeading > 0 ? compassHeading : gpsHeading;
}

// ─────────────────────────────────────────────────────────────
// 3. V2X 신호 데이터 요청 (라라벨 API 연동 버전)
// ─────────────────────────────────────────────────────────────
export async function fetchSignalData() {
    if (!lastLat || !lastLng || isFetching) return;
    isFetching = true;

    const statusTextEl = document.getElementById('api-status-text');
    const heading = getEffectiveHeading();

    try {
        // Step 1: 근처 교차로 검색
        const nearbyRes = await fetch(`${API_BASE_URL}/nearby?lat=${lastLat}&lng=${lastLng}&bearing=${heading}`, {
            headers: { 'X-API-KEY': API_KEY }
        });
        const nearbyData = await nearbyRes.json();

        if (!nearbyData.data) {
            if (statusTextEl && !timerRunning) statusTextEl.innerText = "NO NODE";
            return;
        }

        const itstId = nearbyData.data.id;
        const itstNm = nearbyData.data.n;

        // Step 2: 실시간 신호 상태 조회
        const signalRes = await fetch(`${API_BASE_URL}/signal/${itstId}`, {
            headers: { 'X-API-KEY': API_KEY }
        });
        const signalData = await signalRes.json();

        if (signalData.status === 'success' && signalData.data) {
            const nameEl = document.getElementById('cross-name');
            if (nameEl) nameEl.innerText = itstNm;

            // 현재 진행 방향(nt, et, st, wt)에 맞는 데이터 추출
            const prefix = getDirectionPrefix(heading);
            const dirData = signalData.data.directions[prefix];
            
            // 보행신호 잔여시간 우선, 없으면 직진신호 잔여시간 (단위: 초 -> 센티초 변환하여 타이머 전달)
            const remainSeconds = dirData.walk > 0 ? dirData.walk : dirData.straight;
            const serverCentis = remainSeconds * 100;

            if (serverCentis > 0 && !timerRunning) {
                currentRemainCentis = serverCentis;
                startVisualTimer();

                if (itstId !== lastIntersectionId) {
                    speak(`${itstNm} 연동되었습니다.`);
                    lastIntersectionId = itstId;
                    lastIntersectionName = itstNm;
                }
            } else if (serverCentis <= 0) {
                if (statusTextEl && !timerRunning) statusTextEl.innerText = "WAIT";
            }
        } else {
            if (statusTextEl && !timerRunning) statusTextEl.innerText = "NO DATA";
        }
    } catch (err) {
        console.error("V2X API Error:", err);
        if (statusTextEl && !timerRunning) statusTextEl.innerText = "API ERR";
    } finally {
        isFetching = false;
    }
}

// ─────────────────────────────────────────────────────────────
// 4. 카운트다운 타이머
// ─────────────────────────────────────────────────────────────
function startVisualTimer() {
    const statusTextEl = document.getElementById('api-status-text');

    if (countdownInterval) clearInterval(countdownInterval);
    timerRunning = true;

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis = Math.max(0, currentRemainCentis - 10);
            const displaySec = (currentRemainCentis / 100).toFixed(1);

            if (statusTextEl) {
                statusTextEl.innerText = `${displaySec}s`;
                statusTextEl.className = "text-7xl font-black text-blue-500 italic text-center animate-pulse";
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
// 5. 지도 및 방향 유틸
// ─────────────────────────────────────────────────────────────
function renderMap(lat, lng) {
    if (typeof naver === 'undefined' || !naver.maps) {
        if (mapRetryCount < 10) {
            mapRetryCount++;
            setTimeout(() => renderMap(lat, lng), 500);
        }
        return;
    }
    const position = new naver.maps.LatLng(lat, lng);
    if (!naverMap) {
        try {
            naverMap = new naver.maps.Map('map', { center: position, zoom: 18, logoControl: false });
            new naver.maps.Marker({ position, map: naverMap });
        } catch (e) { console.error("Map Error", e); }
    } else {
        naverMap.setCenter(position);
    }
}

function getDirectionPrefix(heading) {
    if (heading >= 315 || heading < 45)  return "nt";
    if (heading >= 45  && heading < 135) return "et";
    if (heading >= 135 && heading < 225) return "st";
    if (heading >= 225 && heading < 315) return "wt";
    return "nt";
}

function getDirectionLabel(heading) {
    const labels = ["N", "E", "S", "W"];
    const index = Math.round(((heading %= 360) < 0 ? heading + 360 : heading) / 90) % 4;
    return labels[index];
}
