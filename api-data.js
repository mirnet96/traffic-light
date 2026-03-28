/**
 * [ULTRA VISION AI] - api-data.js
 * 카카오맵 + 현재위치 마커 + 교차로 마커
 */
import { speak } from './utils.js';

const API_BASE_URL = 'http://iot.klueware.com/api/v1';
const API_KEY      = '7c76f496-b1f7-459f-85f1-ec9359276fce';

const DEFAULT_LAT = 37.5665;
const DEFAULT_LNG = 126.9780;

let lastLat = null, lastLng = null;
let compassHeading = 0;
let gpsHeading     = 0;
let lastIntersectionId  = "";
let countdownInterval   = null;
let currentRemainCentis = 0;
let isFetching           = false;
let isDataTabInitialized = false;
let timerRunning         = false;

// ── 카카오맵 변수 ──────────────────────────────────────────────
let kakaoMap         = null;
let kakaoMyMarker    = null;   // 현재 위치 마커
let kakaoItstMarker  = null;   // 교차로 마커
let kakaoItstOverlay = null;   // 교차로 이름 오버레이

// ─────────────────────────────────────────────────────────────
// 1. 초기화 및 GPS 리스너
// ─────────────────────────────────────────────────────────────
export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;

    renderMap(DEFAULT_LAT, DEFAULT_LNG);

    if (!lastLat) {
        lastLat = DEFAULT_LAT; lastLng = DEFAULT_LNG;
        updateStatusDisplay("STARTING...", "zinc");
        fetchSignalData();
    }

    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(state => {
            if (state === 'granted')
                window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        });
    } else {
        window.addEventListener('deviceorientation', handleOrientation, true);
    }

    navigator.geolocation.watchPosition(
        (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            if (pos.coords.heading !== null) gpsHeading = pos.coords.heading;

            const h       = getEffectiveHeading();
            const locText = document.getElementById('location-text');
            if (locText) locText.innerHTML =
                `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} | ${Math.round(h)}° ${getDirectionLabel(h)}`;

            renderMap(lastLat, lastLng);
            if (!isFetching) fetchSignalData();
        },
        null,
        { enableHighAccuracy: false, timeout: 15000 }
    );

    setInterval(fetchSignalData, 10000);
}

// ─────────────────────────────────────────────────────────────
// 2. 신호 데이터 페칭
// ─────────────────────────────────────────────────────────────
export async function fetchSignalData() {
    if (!lastLat || isFetching) return;
    isFetching = true;

    const heading = getEffectiveHeading();

    try {
        const nearbyRes  = await fetch(
            `${API_BASE_URL}/nearby?lat=${lastLat}&lng=${lastLng}&bearing=${heading}`,
            { headers: { 'X-API-KEY': API_KEY } }
        );
        const nearbyData = await nearbyRes.json();

        if (!nearbyData.data) {
            updateStatusDisplay("NO NODE", "zinc");
            return;
        }

        const itstId  = nearbyData.data.id;
        const itstNm  = nearbyData.data.n;
        const itstLat = nearbyData.data.lat;
        const itstLng = nearbyData.data.lng;

        // 교차로 마커 업데이트
        if (itstLat && itstLng) updateItstMarker(itstLat, itstLng, itstNm);

        const signalRes  = await fetch(
            `${API_BASE_URL}/signal/${itstId}`,
            { headers: { 'X-API-KEY': API_KEY } }
        );
        const signalData = await signalRes.json();

        if (signalData.status === 'success' && signalData.data) {
            document.getElementById('cross-name').innerText = itstNm;

            const prefix        = getDirectionPrefix(heading);
            const dirData       = signalData.data.directions[prefix];
            const isWalkSignal  = dirData.walk > 0;
            const remainSeconds = isWalkSignal ? dirData.walk : dirData.straight;

            if (remainSeconds > 0 && !timerRunning) {
                currentRemainCentis = remainSeconds * 100;
                startVisualTimer(isWalkSignal);
                if (itstId !== lastIntersectionId) {
                    speak(`${itstNm} 교차로 신호가 연동되었습니다.`);
                    lastIntersectionId = itstId;
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
// 3. 시각화 타이머
// ─────────────────────────────────────────────────────────────
function startVisualTimer(isGreenPhase) {
    const statusTextEl = document.getElementById('api-status-text');
    if (countdownInterval) clearInterval(countdownInterval);
    timerRunning = true;

    if (isGreenPhase) speak("초록불입니다. 건너가셔도 좋습니다.");

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis -= 10;
            const sec = (currentRemainCentis / 100).toFixed(1);
            statusTextEl.innerText = `${sec}s`;
            if (isGreenPhase) {
                statusTextEl.className = "text-8xl font-black text-green-500 italic animate-pulse";
                if (sec == "5.0") speak("신호가 5초 남았습니다. 주의하세요.");
            } else {
                statusTextEl.className = "text-8xl font-black text-red-500 italic";
            }
        } else {
            stopTimer();
        }
    }, 100);
}

function stopTimer() {
    clearInterval(countdownInterval);
    timerRunning = false;
    updateStatusDisplay("WAIT", "zinc");
}

function updateStatusDisplay(text, colorClass) {
    const el = document.getElementById('api-status-text');
    if (el) {
        el.innerText = text;
        el.className = `text-5xl font-black text-${colorClass}-700 text-center`;
    }
}

// ─────────────────────────────────────────────────────────────
// 4. 유틸리티
// ─────────────────────────────────────────────────────────────
function handleOrientation(e) {
    if (e.webkitCompassHeading) compassHeading = e.webkitCompassHeading;
    else if (e.alpha)            compassHeading = (360 - e.alpha) % 360;
}
function getEffectiveHeading() { return compassHeading || gpsHeading; }
function getDirectionPrefix(h) {
    if (h >= 315 || h < 45)  return "nt";
    if (h >= 45  && h < 135) return "et";
    if (h >= 135 && h < 225) return "st";
    return "wt";
}
function getDirectionLabel(h) {
    return ["북","동","남","서"][Math.round(((h %= 360) < 0 ? h+360 : h) / 90) % 4];
}

// ─────────────────────────────────────────────────────────────
// 5. 카카오맵 렌더링 + 마커
// ─────────────────────────────────────────────────────────────
function renderMap(lat, lng) {
    if (typeof kakao === 'undefined' || typeof kakao.maps === 'undefined') return;

    const pos = new kakao.maps.LatLng(lat, lng);

    if (!kakaoMap) {
        kakaoMap = new kakao.maps.Map(document.getElementById('map'), {
            center: pos, level: 3
        });
        window.kakaoMapInstance = kakaoMap;

        // 현재 위치 마커 — 파란 원형
        const myImg = new kakao.maps.MarkerImage(
            'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
                '<circle cx="12" cy="12" r="10" fill="#3b82f6" stroke="white" stroke-width="3"/>' +
                '<circle cx="12" cy="12" r="4" fill="white"/></svg>'
            ),
            new kakao.maps.Size(24, 24),
            { offset: new kakao.maps.Point(12, 12) }
        );
        kakaoMyMarker = new kakao.maps.Marker({
            position: pos, map: kakaoMap, image: myImg, title: '현재 위치'
        });

        setTimeout(() => { kakaoMap.relayout(); kakaoMap.setCenter(pos); }, 300);
    } else {
        kakaoMap.relayout();
        kakaoMap.setCenter(pos);
        kakaoMyMarker.setPosition(pos);
    }
}

// 교차로 마커 (빨간 핀) + 이름 말풍선
function updateItstMarker(lat, lng, name) {
    if (!kakaoMap) return;
    const pos = new kakao.maps.LatLng(lat, lng);

    const labelHtml = `<div style="
        background:#111;color:#fff;padding:4px 10px;border-radius:20px;
        font-size:11px;font-weight:bold;border:1px solid rgba(255,255,255,0.2);
        white-space:nowrap;margin-bottom:4px;letter-spacing:-0.3px;">${name}</div>`;

    if (!kakaoItstMarker) {
        const itstImg = new kakao.maps.MarkerImage(
            'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36">' +
                '<path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22S28 24.5 28 14C28 6.27 21.73 0 14 0z"' +
                ' fill="#ef4444" stroke="white" stroke-width="2"/>' +
                '<text x="14" y="19" text-anchor="middle" font-size="13" font-weight="bold"' +
                ' fill="white" font-family="sans-serif">✦</text></svg>'
            ),
            new kakao.maps.Size(28, 36),
            { offset: new kakao.maps.Point(14, 36) }
        );
        kakaoItstMarker = new kakao.maps.Marker({
            position: pos, map: kakaoMap, image: itstImg, title: name
        });
        kakaoItstOverlay = new kakao.maps.CustomOverlay({
            position: pos, content: labelHtml, yAnchor: 1.7
        });
        kakaoItstOverlay.setMap(kakaoMap);
    } else {
        kakaoItstMarker.setPosition(pos);
        kakaoItstOverlay.setPosition(pos);
        kakaoItstOverlay.setContent(labelHtml);
    }
}
