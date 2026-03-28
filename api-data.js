/**
 * [ULTRA VISION AI] - api-data.js
 * 카카오맵 + 현재위치 마커 + 교차로 마커 + HTTPS API 연동
 */
import { speak } from './utils.js';

// 1. 접속 정보를 HTTPS로 변경
const API_BASE_URL = 'https://iot.klueware.com/api/v1';
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

    // 초기 맵 렌더링
    renderMap(DEFAULT_LAT, DEFAULT_LNG);

    // GPS 감시 시작
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (pos) => {
                lastLat = pos.coords.latitude;
                lastLng = pos.coords.longitude;
                gpsHeading = pos.coords.heading || 0;

                updateMyLocationMarker(lastLat, lastLng);
                document.getElementById('location-text').innerText = 
                    `LAT: ${lastLat.toFixed(5)} / LNG: ${lastLng.toFixed(5)} / H: ${gpsHeading}°`;

                // 위치가 처음 잡히면 즉시 API 호출 시도
                if (!lastIntersectionId && !isFetching) {
                    fetchSignalData();
                }
            },
            (err) => {
                console.error("GPS Error:", err);
                document.getElementById('location-text').innerText = "GPS Error: " + err.message;
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
    }

    // 나침반(방향) 센서
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (e) => {
            compassHeading = e.webkitCompassHeading || (360 - e.alpha) || 0;
        });
    }

    // 10초마다 자동 갱신
    setInterval(fetchSignalData, 10000);

    // 수동 갱신 버튼 이벤트 연결
    const refreshBtn = document.getElementById('refresh-api');
    if (refreshBtn) {
        refreshBtn.onclick = () => {
            speak("데이터를 수동 갱신합니다.");
            fetchSignalData();
        };
    }
}

// ─────────────────────────────────────────────────────────────
// 2. 핵심 API 통신 로직 (주변 교차로 -> 실시간 신호)
// ─────────────────────────────────────────────────────────────
export async function fetchSignalData() {
    // 위치 정보가 없거나 이미 요청 중이면 중단
    if (isFetching || !lastLat || !lastLng) return;
    
    isFetching = true;
    updateStatusUI("WAIT", "bg-zinc-800 text-zinc-500");

    try {
        // STEP A: 주변 교차로 검색 (Remote 테스트 결과 구조 반영)
        const nearbyUrl = `${API_BASE_URL}/nearby?lat=${lastLat}&lng=${lastLng}&bearing=${gpsHeading}`;
        const nearbyRes = await fetch(nearbyUrl, {
            headers: { 
                'X-API-KEY': API_KEY,
                'Accept': 'application/json'
            }
        });

        if (!nearbyRes.ok) throw new Error(`Nearby API Fail: ${nearbyRes.status}`);
        
        const nearbyData = await nearbyRes.json();
        
        // Remote 테스트 결과에 따라 data[0] 추출
        const itst = (nearbyData.status === 'success' && nearbyData.data && nearbyData.data.length > 0) 
                     ? nearbyData.data[0] 
                     : null;

        if (!itst) {
            updateStatusUI("NO NODE", "bg-zinc-800 text-zinc-600");
            document.getElementById('cross-name').innerText = "SEARCHING...";
            return;
        }

        const itstId = itst.itstId;
        const itstName = itst.name || "알 수 없는 교차로";

        // 교차로 정보 UI 반영
        document.getElementById('cross-name').innerText = itstName;
        renderItstMarker(itst.lat || lastLat, itst.lng || lastLng, itstName);

        // STEP B: 실시간 신호 잔여 시간 조회
        const signalUrl = `${API_BASE_URL}/signal/${itstId}`;
        const signalRes = await fetch(signalUrl, {
            headers: { 
                'X-API-KEY': API_KEY,
                'Accept': 'application/json'
            }
        });

        if (!signalRes.ok) throw new Error(`Signal API Fail: ${signalRes.status}`);
        
        const signalResult = await signalRes.json();

        if (signalResult.status === 'success' && signalResult.data) {
            processSignalInfo(signalResult.data);
            lastIntersectionId = itstId;
        } else {
            updateStatusUI("WAIT", "bg-zinc-800 text-zinc-500");
        }

    } catch (err) {
        console.error("V2X Data Fetch Error:", err);
        updateStatusUI("ERR", "bg-red-900/20 text-red-500");
    } finally {
        isFetching = false;
    }
}

// ─────────────────────────────────────────────────────────────
// 3. 데이터 처리 및 타이머 구동
// ─────────────────────────────────────────────────────────────
function processSignalInfo(data) {
    // 4방향 중 보행자 신호(walk)가 0보다 큰 가장 첫 번째 데이터를 우선 표시
    const dirs = ['nt', 'et', 'st', 'wt'];
    let activeSec = 0;

    for (const d of dirs) {
        if (data.directions[d] && data.directions[d].walk > 0) {
            activeSec = data.directions[d].walk;
            break;
        }
    }

    if (activeSec > 0) {
        startLocalCountdown(activeSec);
    } else {
        updateStatusUI("WAIT", "bg-zinc-800 text-zinc-500");
    }
}

function startLocalCountdown(seconds) {
    if (countdownInterval) clearInterval(countdownInterval);
    
    currentRemainCentis = Math.floor(seconds * 10); // 0.1초 단위
    timerRunning = true;

    countdownInterval = setInterval(() => {
        if (currentRemainCentis <= 0) {
            clearInterval(countdownInterval);
            timerRunning = false;
            updateStatusUI("0.0", "bg-zinc-800 text-zinc-700");
            return;
        }

        currentRemainCentis--;
        const displaySec = (currentRemainCentis / 10).toFixed(1);
        
        // 초록불 5초 미만 시 빨간색 강조
        const colorClass = (currentRemainCentis < 50) ? "text-red-500" : "text-green-400";
        updateStatusUI(displaySec, colorClass);

        // 음성 안내 (정각 초 마다)
        if (currentRemainCentis > 0 && currentRemainCentis % 10 === 0) {
            const sec = currentRemainCentis / 10;
            if (sec <= 5) speak(sec.toString());
        }
    }, 100);
}

function updateStatusUI(text, colorClass) {
    const el = document.getElementById('api-status-text');
    if (!el) return;
    el.innerText = text;
    el.className = `text-7xl font-black text-center tracking-tighter ${colorClass}`;
}

// ─────────────────────────────────────────────────────────────
// 4. 카카오맵 헬퍼 함수
// ─────────────────────────────────────────────────────────────
function renderMap(lat, lng) {
    const container = document.getElementById('map');
    if (!container) return;

    const options = {
        center: new kakao.maps.LatLng(lat, lng),
        level: 3
    };

    kakaoMap = new kakao.maps.Map(container, options);
    window.kakaoMapInstance = kakaoMap; // app.js relayout 대응
}

function updateMyLocationMarker(lat, lng) {
    if (!kakaoMap) return;
    const pos = new kakao.maps.LatLng(lat, lng);

    if (!kakaoMyMarker) {
        kakaoMyMarker = new kakao.maps.Marker({ position: pos, map: kakaoMap });
    } else {
        kakaoMyMarker.setPosition(pos);
    }
}

function renderItstMarker(lat, lng, name) {
    if (!kakaoMap) return;
    const pos = new kakao.maps.LatLng(lat, lng);

    if (!kakaoItstMarker) {
        kakaoItstMarker = new kakao.maps.Marker({
            position: pos,
            map: kakaoMap,
            image: new kakao.maps.MarkerImage(
                'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png',
                new kakao.maps.Size(24, 35)
            )
        });
    } else {
        kakaoItstMarker.setPosition(pos);
    }
    
    // 오버레이 처리 (교차로 이름 표시)
    if (kakaoItstOverlay) kakaoItstOverlay.setMap(null);
    kakaoItstOverlay = new kakao.maps.CustomOverlay({
        position: pos,
        content: `<div style="padding:5px; background:rgba(0,0,0,0.7); color:#fff; border-radius:5px; font-size:12px;">${name}</div>`,
        yAnchor: 2.5
    });
    kakaoItstOverlay.setMap(kakaoMap);
}
