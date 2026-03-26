/**
 * [ULTRA VISION AI] - api-data.js
 * 보행자 전용 V2X 데이터 연동 및 고정밀 클라이언트 타이머
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './app.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

let lastLat = null, lastLng = null, lastHeading = 0;
let lastIntersectionName = "";
let countdownInterval = null;
let currentRemainCentis = 0; // 0.1초 단위 잔여시간
let naverMap = null;

/**
 * 1. 데이터 탭 초기화 (GPS 추적 시작)
 */
export function initDataTab() {
    const locationText = document.getElementById('location-text');
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        async (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            lastHeading = pos.coords.heading || 0;

            if (locationText) {
                locationText.innerHTML = `
                    <div class="flex flex-col text-[10px] font-mono opacity-70">
                        <span>GPS: ${lastLat.toFixed(5)}, ${lastLng.toFixed(5)}</span>
                        <span class="text-blue-400">방향: ${Math.round(lastHeading)}° | 오차: ±${Math.round(pos.coords.accuracy)}m</span>
                    </div>
                `;
            }

            renderMap(lastLat, lastLng);
            if (!lastIntersectionName) fetchSignalData();
        },
        (err) => console.warn("GPS Error:", err),
        { enableHighAccuracy: true }
    );

    // 10초마다 서버와 데이터 동기화
    setInterval(fetchSignalData, 10000);
}

/**
 * 2. V2X 신호 데이터 수신 (보행자 전용 필드 추출)
 */
export async function fetchSignalData() {
    if (!lastLat || !lastLng) return;

    const crossNameEl = document.getElementById('cross-name');
    const statusTextEl = document.getElementById('api-status-text');

    try {
        const { data, error } = await supabase.functions.invoke('get-traffic-signal', {
            body: { lat: lastLat, lng: lastLng, heading: lastHeading }
        });

        if (error) throw error;

        if (data && data.signal) {
            if (crossNameEl) crossNameEl.innerText = `🚶 ${data.intersectionName}`;
            
            const prefix = getDirectionPrefix(lastHeading);
            // 보행자 잔여시간(PdsgRmdrCs)을 최우선으로 가져옴
            const serverCentis = data.signal[`${prefix}PdsgRmdrCs`] || data.signal[`${prefix}StsgRmdrCs` || 0];

            if (serverCentis > 0) {
                currentRemainCentis = serverCentis;
                startVisualTimer(); // 클라이언트 타이머 가동

                if (data.intersectionName !== lastIntersectionName) {
                    speak(`${data.intersectionName} 교차로 보행 신호 연동을 시작합니다.`);
                    lastIntersectionName = data.intersectionName;
                }
            } else {
                stopVisualTimer("신호 대기");
            }
        }
    } catch (err) {
        console.error("V2X Error:", err);
        if (statusTextEl) statusTextEl.innerText = "연동 지연";
    }
}

/**
 * 3. 클라이언트 사이드 고정밀 타이머 (0.1초 단위 갱신)
 */
function startVisualTimer() {
    const statusTextEl = document.getElementById('api-status-text');
    const apiCard = document.getElementById('api-card');

    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis -= 10; 
            const displaySec = (currentRemainCentis / 100).toFixed(1);
            
            if (statusTextEl) {
                statusTextEl.innerText = `${displaySec}s`;
                statusTextEl.className = "text-7xl font-black text-blue-500 italic text-center";
            }
            if (apiCard) apiCard.style.borderLeftColor = "#3b82f6";

            // 보행자 안전을 위한 5초 전 경고
            if (displaySec === "5.0") speak("신호 변경 5초 전입니다. 무리한 진입을 자제하세요.");
        } else {
            stopVisualTimer("신호 변경");
        }
    }, 100);
}

function stopVisualTimer(msg) {
    clearInterval(countdownInterval);
    const statusTextEl = document.getElementById('api-status-text');
    if (statusTextEl) {
        statusTextEl.innerText = msg;
        statusTextEl.className = "text-5xl font-black text-zinc-700 text-center";
    }
}

export function renderMap(lat, lng) {
    if (typeof naver === 'undefined' || !naver.maps) {
        console.error("Naver Maps 라이브러리가 로드되지 않았습니다.");
        const mapContainer = document.getElementById('map');
        if (mapContainer) mapContainer.innerHTML = '<div class="p-10 text-center text-xs text-red-500 font-bold">인증 실패 또는 로드 대기 중</div>';
        return;
    }
    
    const position = new naver.maps.LatLng(lat, lng);
    
    if (!naverMap) {
        naverMap = new naver.maps.Map('map', {
            center: position,
            zoom: 18,
            logoControl: false,
            mapDataControl: false,
            scaleControl: false
        });
        new naver.maps.Marker({ position, map: naverMap });
    } else {
        naverMap.setCenter(position);
    }
}

function getDirectionPrefix(heading) {
    if (heading >= 315 || heading < 45) return "nt";
    if (heading >= 45 && heading < 135) return "et";
    if (heading >= 135 && heading < 225) return "st";
    if (heading >= 225 && heading < 315) return "wt";
    return "nt";
}
