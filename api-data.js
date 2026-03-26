import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './app.js';

// 1. Supabase 설정
const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

let lastLat = null, lastLng = null, lastHeading = 0;
let lastIntersectionName = "";
let countdownInterval = null;
let currentRemainCentis = 0; // 0.1초 단위 잔여시간

/**
 * [1] 데이터 탭 초기화 및 보행자 GPS 추적 시작
 */
export function initDataTab() {
    const locationText = document.getElementById('location-text');
    if (!navigator.geolocation) return;

    // 보행자 특성상 고정밀도 유지 및 watchPosition 사용
    navigator.geolocation.watchPosition(
        async (pos) => {
            lastLat = pos.coords.latitude;
            lastLng = pos.coords.longitude;
            lastHeading = pos.coords.heading || 0;

            locationText.innerHTML = `
                <div class="flex flex-col text-[10px] font-mono opacity-70">
                    <span>GPS: ${lastLat.toFixed(5)}, ${lastLng.toFixed(5)}</span>
                    <span class="text-blue-400">보행 방향: ${Math.round(lastHeading)}° | 오차: ±${Math.round(pos.coords.accuracy)}m</span>
                </div>
            `;

            renderMap(lastLat, lastLng);
            // 처음 위치를 잡으면 즉시 데이터 호출
            if (!lastIntersectionName) fetchSignalData();
        },
        (err) => console.error("GPS Error:", err),
        { enableHighAccuracy: true }
    );

    // 10초마다 서버 데이터 동기화 (네트워크 부하 절감)
    setInterval(fetchSignalData, 10000);
}

/**
 * [2] 서버로부터 실시간 신호 데이터 수신
 */
export async function fetchSignalData() {
    if (!lastLat || !lastLng) return;

    const crossNameEl = document.getElementById('cross-name');
    const statusTextEl = document.getElementById('api-status-text');
    const apiCard = document.getElementById('api-card');

    try {
        const { data, error } = await supabase.functions.invoke('get-traffic-signal', {
            body: { lat: lastLat, lng: lastLng, heading: lastHeading }
        });

        if (error) throw error;

        if (data && data.signal) {
            crossNameEl.innerText = `🚶 ${data.intersectionName}`;
            
            // 보행자용 접두어 결정 (nt, et, st, wt)
            const prefix = getDirectionPrefix(lastHeading);
            // 보행 신호 잔여시간(PdsgRmdrCs) 우선 추출
            const serverCentis = data.signal[`${prefix}PdsgRmdrCs`] || data.signal[`${prefix}StsgRmdrCs`];

            if (serverCentis > 0) {
                currentRemainCentis = serverCentis;
                startVisualTimer(); // 클라이언트 타이머 가동

                if (data.intersectionName !== lastIntersectionName) {
                    speak(`${data.intersectionName} 교차로 보행 신호 연동을 시작합니다.`);
                    lastIntersectionName = data.intersectionName;
                }
            } else {
                stopVisualTimer("신호 대기 중");
            }
        }
    } catch (err) {
        console.error("V2X Data Error:", err);
        statusTextEl.innerText = "V2X 연동 지연";
    }
}

/**
 * [3] 클라이언트 사이드 고정밀 타이머 (0.1초 단위 갱신)
 */
function startVisualTimer() {
    const statusTextEl = document.getElementById('api-status-text');
    const apiCard = document.getElementById('api-card');

    if (countdownInterval) clearInterval(countdownInterval);

    countdownInterval = setInterval(() => {
        if (currentRemainCentis > 0) {
            currentRemainCentis -= 10; // 0.1초(10센티초)씩 차감
            const displaySec = (currentRemainCentis / 100).toFixed(1);
            
            statusTextEl.innerText = `${displaySec}s`;
            statusTextEl.className = "text-7xl font-black text-blue-500 italic";
            apiCard.style.borderLeftColor = "#3b82f6";

            // 5초 남았을 때 음성 경고
            if (displaySec == "5.0") speak("신호 변경 5초 전입니다. 주의하세요.");
        } else {
            stopVisualTimer("신호 변경");
        }
    }, 100); // 0.1초마다 실행
}

function stopVisualTimer(msg) {
    clearInterval(countdownInterval);
    document.getElementById('api-status-text').innerText = msg;
    document.getElementById('api-status-text').className = "text-3xl font-black text-zinc-500";
}

/**
 * [4] 네이버 지도 렌더링
 */
function renderMap(lat, lng) {
    if (typeof naver === 'undefined') return;
    const map = new naver.maps.Map('map', {
        center: new naver.maps.LatLng(lat, lng),
        zoom: 19, // 보행자용이므로 더 확대
        zoomControl: false,
        mapDataControl: false
    });
    new naver.maps.Marker({
        position: new naver.maps.LatLng(lat, lng),
        map: map,
        icon: {
            content: '<div class="w-4 h-4 bg-blue-500 border-2 border-white rounded-full shadow-xl"></div>',
            anchor: new naver.maps.Point(8, 8)
        }
    });
}

function getDirectionPrefix(heading) {
    if (heading >= 315 || heading < 45) return "nt";
    if (heading >= 45 && heading < 135) return "et";
    if (heading >= 135 && heading < 225) return "st";
    if (heading >= 225 && heading < 315) return "wt";
    return "nt";
}
