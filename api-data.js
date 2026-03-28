/**
 * [ULTRA VISION AI] - api-data.js (Integrated Version)
 * 1. HTTP (http://iot.klueware.com) 환경 연동
 * 2. 신호등 시각화 (색상 및 애니메이션)
 * 3. 음성 안내 및 카운트다운 로직 강화
 */
import { speak } from './utils.js';

// ── 설정 (HTTP 프로토콜 사용) ──────────────────────────────────
const API_BASE_URL = 'http://iot.klueware.com/api/v1';
const API_KEY = '7c76f496-b1f7-459f-85f1-ec9359276fce';

// ── 기본 좌표 (GPS 미확보 시 fallback) ────────────────────────
const DEFAULT_LAT = 37.5665;
const DEFAULT_LNG = 126.9780;

// ── 상태 변수 ─────────────────────────────────────────────────
let lastLat = null, lastLng = null;
let compassHeading = 0;
let gpsHeading = 0;
let lastIntersectionId = "";
let countdownInterval = null;
let currentRemainCentis = 0;
// naverMap → kakaoMap으로 교체 (api-data.js 하단 renderMap 참고)
let isFetching = false;
let isDataTabInitialized = false;
let timerRunning = false;

// ─────────────────────────────────────────────────────────────
// 1. 초기화 및 GPS 리스너
// ─────────────────────────────────────────────────────────────
export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;

    // 초기 지도 렌더링
    renderMap(DEFAULT_LAT, DEFAULT_LNG);

    // 즉시 실행 (READY 상태 탈출)
    if (!lastLat) {
        lastLat = DEFAULT_LAT; lastLng = DEFAULT_LNG;
        updateStatusDisplay("STARTING...", "zinc");
        fetchSignalData(); 
    }

    // 방향 센서 (iOS/Android 대응)
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(state => {
            if (state === 'granted') window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        });
    } else {
        window.addEventListener('deviceorientation', handleOrientation, true);
    }

    // GPS 감시 시작
    navigator.geolocation.watchPosition(
        (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            if (pos.coords.heading !== null) gpsHeading = pos.coords.heading;

            const h = getEffectiveHeading();
            const locText = document.getElementById('location-text');
            if (locText) locText.innerHTML = `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} | ${Math.round(h)}° ${getDirectionLabel(h)}`;

            renderMap(lastLat, lastLng);
            if (!isFetching) fetchSignalData();
        },
        null,
        { enableHighAccuracy: false, timeout: 15000 }
    );

    setInterval(fetchSignalData, 10000); // 10초마다 갱신
}

// ─────────────────────────────────────────────────────────────
// 2. 신호 데이터 페칭 및 시각화 로직
// ─────────────────────────────────────────────────────────────
export async function fetchSignalData() {
    if (!lastLat || isFetching) return;
    isFetching = true;

    const heading = getEffectiveHeading();

    try {
        // Step 1: 근처 교차로 검색
        const nearbyRes = await fetch(`${API_BASE_URL}/nearby?lat=${lastLat}&lng=${lastLng}&bearing=${heading}`, {
            headers: { 'X-API-KEY': API_KEY }
        });
        const nearbyData = await nearbyRes.json();

        if (!nearbyData.data) {
            updateStatusDisplay("NO NODE", "zinc");
            return;
        }

        const itstId = nearbyData.data.id;
        const itstNm = nearbyData.data.n;

        // Step 2: 실시간 신호 조회
        const signalRes = await fetch(`${API_BASE_URL}/signal/${itstId}`, {
            headers: { 'X-API-KEY': API_KEY }
        });
        const signalData = await signalRes.json();

        if (signalData.status === 'success' && signalData.data) {
            document.getElementById('cross-name').innerText = itstNm;

            const prefix = getDirectionPrefix(heading);
            const dirData = signalData.data.directions[prefix];
            
            // 시각화: 보행신호(P)가 있으면 초록색 계열, 없으면 직진신호(S) 기준
            const isWalkSignal = dirData.walk > 0;
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
// 3. 시각화 타이머 (신호등 색상 적용)
// ─────────────────────────────────────────────────────────────
function startVisualTimer(isGreenPhase) {
    const statusTextEl = document.getElementById('api-status-text');
    if (countdownInterval) clearInterval(countdownInterval);
    timerRunning = true;

    // 음성 안내: 신호 시작 시
    if (isGreenPhase) {
        speak("초록불입니다. 건너가셔도 좋습니다.");
    }

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis -= 10;
            const sec = (currentRemainCentis / 100).toFixed(1);
            
            statusTextEl.innerText = `${sec}s`;
            
            // 시각화 로직: 초록불(Green) vs 빨간불/대기(Red)
            if (isGreenPhase) {
                statusTextEl.className = "text-8xl font-black text-green-500 italic animate-pulse";
                // 5초 남았을 때 경고 음성
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
// 4. 유틸리티 함수 (방향 및 센서)
// ─────────────────────────────────────────────────────────────
function handleOrientation(e) {
    if (e.webkitCompassHeading) compassHeading = e.webkitCompassHeading;
    else if (e.alpha) compassHeading = (360 - e.alpha) % 360;
}

function getEffectiveHeading() { return compassHeading || gpsHeading; }

function getDirectionPrefix(h) {
    if (h >= 315 || h < 45)  return "nt"; // 북
    if (h >= 45  && h < 135) return "et"; // 동
    if (h >= 135 && h < 225) return "st"; // 남
    return "wt"; // 서
}

function getDirectionLabel(h) {
    const arr = ["북", "동", "남", "서"];
    return arr[Math.round(((h %= 360) < 0 ? h + 360 : h) / 90) % 4];
}

// ─────────────────────────────────────────────────────────────
// 5. 지도 렌더링 (카카오맵)
// ─────────────────────────────────────────────────────────────
let kakaoMap = null;
let kakaoMarker = null;

function renderMap(lat, lng) {
    if (typeof kakao === 'undefined' || typeof kakao.maps === 'undefined') return;

    const pos = new kakao.maps.LatLng(lat, lng);

    if (!kakaoMap) {
        const container = document.getElementById('map');
        kakaoMap = new kakao.maps.Map(container, {
            center: pos,
            level: 3
        });
        window.kakaoMapInstance = kakaoMap; // app.js에서 relayout 접근용

        kakaoMarker = new kakao.maps.Marker({
            position: pos,
            map: kakaoMap
        });

        // [FIX] 탭 전환 후 컨테이너 크기가 확정된 뒤 relayout 호출
        // → 타일이 일부만 그려지거나 회색으로 나오는 문제 해결
        setTimeout(() => {
            kakaoMap.relayout();
            kakaoMap.setCenter(pos);
        }, 300);

    } else {
        // [FIX] 위치 업데이트 시마다 relayout으로 타일 깨짐 방지
        kakaoMap.relayout();
        kakaoMap.setCenter(pos);
        kakaoMarker.setPosition(pos);
    }
}
