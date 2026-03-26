import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './app.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

let lastLat = null, lastLng = null, lastHeading = 0;
let lastIntersectionName = "";
let countdownInterval = null;
let currentRemainCentis = 0;
let naverMap = null; // 지도 객체 전역 관리

export function initDataTab() {
    const locationText = document.getElementById('location-text');
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        async (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            lastHeading = pos.coords.heading || 0;

            locationText.innerHTML = `📍 ${lastLat.toFixed(5)}, ${lastLng.toFixed(5)} (±${Math.round(pos.coords.accuracy)}m)`;
            
            renderMap(lastLat, lastLng);
            if (!lastIntersectionName) fetchSignalData();
        },
        (err) => { console.error(err); },
        { enableHighAccuracy: true }
    );

    setInterval(fetchSignalData, 10000);
}

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
            crossNameEl.innerText = `🚶 ${data.intersectionName}`;
            const prefix = getDirectionPrefix(lastHeading);
            const serverCentis = data.signal[`${prefix}PdsgRmdrCs`] || data.signal[`${prefix}StsgRmdrCs`];

            if (serverCentis > 0) {
                currentRemainCentis = serverCentis;
                startVisualTimer();
                if (data.intersectionName !== lastIntersectionName) {
                    speak(`${data.intersectionName} 보행 신호 연동 시작.`);
                    lastIntersectionName = data.intersectionName;
                }
            }
        }
    } catch (err) {
        console.error("V2X Error:", err);
    }
}

function startVisualTimer() {
    const statusTextEl = document.getElementById('api-status-text');
    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis -= 10;
            const displaySec = (currentRemainCentis / 100).toFixed(1);
            statusTextEl.innerText = `${displaySec}s`;
            statusTextEl.className = "text-7xl font-black text-blue-500 italic text-center animate-pulse";
            if (displaySec == "5.0") speak("신호 변경 5초 전입니다.");
        } else {
            clearInterval(countdownInterval);
            statusTextEl.innerText = "WAIT";
            statusTextEl.className = "text-6xl font-black text-zinc-700 text-center";
        }
    }, 100);
}

function renderMap(lat, lng) {
    if (typeof naver === 'undefined' || !naver.maps) return;
    
    const position = new naver.maps.LatLng(lat, lng);
    
    if (!naverMap) {
        // 처음 생성 시
        naverMap = new naver.maps.Map('map', {
            center: position,
            zoom: 18,
            logoControl: false,
            mapDataControl: false
        });
        new naver.maps.Marker({ position, map: naverMap });
    } else {
        // 이미 생성된 경우 중심점만 이동
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
