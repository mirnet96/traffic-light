/**
 * [ULTRA VISION AI] - api-data.js (최적화 버전)
 * 부하 감소를 위한 호출 최적화 및 에러 핸들링 포함
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
speak } from './utils.js'; // 경로 변경


const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

let lastLat = null, lastLng = null, lastHeading = 0;
let lastIntersectionName = "";
let countdownInterval = null;
let currentRemainCentis = 0;
let naverMap = null;
let isFetching = false; // 중복 호출 방지 플래그

export function initDataTab() {
    const locationText = document.getElementById('location-text');
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        async (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            lastHeading = pos.coords.heading || 0;

            if (locationText) {
                locationText.innerHTML = `📍 ${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} | Dir: ${Math.round(lastHeading)}°`;
            }

            renderMap(lastLat, lastLng);
            // 위치 이동 시 즉시 호출하되, 너무 잦은 호출은 방지
            if (!isFetching && !lastIntersectionName) fetchSignalData();
        },
        (err) => console.warn("GPS:", err),
        { enableHighAccuracy: true }
    );

    // 호출 주기를 10초 -> 15초로 약간 늘려 서버 부하 감소
    setInterval(fetchSignalData, 15000);
}

export async function fetchSignalData() {
    if (!lastLat || !lastLng || isFetching) return;
    
    isFetching = true; // 잠금
    const statusTextEl = document.getElementById('api-status-text');

    try {
        // Edge Function 호출 시 타임아웃 처리를 서버 로직에 맡기거나 짧게 유지
        const { data, error } = await supabase.functions.invoke('get-traffic-signal', {
            body: { lat: lastLat, lng: lastLng, heading: lastHeading }
        });

        if (error) {
            // WORKER_LIMIT(546) 발생 시 사용자에게 알림
            if (error.message.includes("resources")) {
                if (statusTextEl) statusTextEl.innerText = "SVR OVER";
                console.error("Supabase 리소스 부족: 무료 티어 제한 또는 로직 과부하");
            }
            throw error;
        }

        if (data && data.signal) {
            document.getElementById('cross-name').innerText = `🚶 ${data.intersectionName}`;
            const prefix = getDirectionPrefix(lastHeading);
            const serverCentis = data.signal[`${prefix}PdsgRmdrCs`] || data.signal[`${prefix}StsgRmdrCs`];

            if (serverCentis > 0) {
                currentRemainCentis = serverCentis;
                startVisualTimer();
                if (data.intersectionName !== lastIntersectionName) {
                    speak(`${data.intersectionName} 연동 시작.`);
                    lastIntersectionName = data.intersectionName;
                }
            }
        }
    } catch (err) {
        console.error("V2X Error:", err);
    } finally {
        isFetching = false; // 해제
    }
}

function startVisualTimer() {
    const statusTextEl = document.getElementById('api-status-text');
    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis -= 10;
            const displaySec = (currentRemainCentis / 100).toFixed(1);
            if (statusTextEl) {
                statusTextEl.innerText = `${displaySec}s`;
                statusTextEl.className = "text-7xl font-black text-blue-500 italic text-center animate-pulse";
            }
        } else {
            clearInterval(countdownInterval);
            if (statusTextEl) {
                statusTextEl.innerText = "WAIT";
                statusTextEl.className = "text-5xl font-black text-zinc-700 text-center";
            }
        }
    }, 100);
}

// renderMap 및 getDirectionPrefix 함수는 이전과 동일하게 유지
function renderMap(lat, lng) {
    if (typeof naver === 'undefined' || !naver.maps) {
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.innerText = "인증 실패 (URL 등록 확인)";
        return;
    }
    const position = new naver.maps.LatLng(lat, lng);
    if (!naverMap) {
        naverMap = new naver.maps.Map('map', { center: position, zoom: 18, logoControl: false });
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
