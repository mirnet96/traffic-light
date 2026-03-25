import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './app.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co', 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

let lastLat, lastLng;
let lastIntersectionName = "";

export function initDataTab() {
    if (!navigator.geolocation) {
        console.error("GPS를 지원하지 않는 기기입니다.");
        return;
    }

    navigator.geolocation.getCurrentPosition(async (pos) => {
        lastLat = pos.coords.latitude;
        lastLng = pos.coords.longitude;
        renderMap(lastLat, lastLng);
        await fetchSignalData();
    }, (err) => {
        document.getElementById('location-text').innerText = "GPS 권한 필요";
    });
}

function renderMap(lat, lng) {
    const mapContainer = document.getElementById('map');
    if (!mapContainer || typeof naver === 'undefined') return;

    const map = new naver.maps.Map('map', { 
        center: new naver.maps.LatLng(lat, lng), 
        zoom: 18 
    });
    new naver.maps.Marker({ 
        position: new naver.maps.LatLng(lat, lng), 
        map: map 
    });
}

/**
 * 교차로 정보를 가져오는 독립 쿼리
 * 비전(vision.js)의 신호 판단 로직과는 완전히 별개로 작동합니다.
 */
export async function fetchSignalData() {
    try {
        const { data, error } = await supabase.rpc('get_nearest_intersection', { 
            user_lat: lastLat, user_lng: lastLng 
        });

        if (data && data.length > 0) {
            const target = data[0];
            
            // UI 업데이트
            document.getElementById('cross-name').innerText = target.name;
            document.getElementById('location-text').innerText = `${Math.round(target.dist_meters)}m 근처 교차로`;
            document.getElementById('api-status-text').innerText = "V2X ACTIVE";
            
            // 동일한 위치가 아닐 때만 음성 안내 (비전 음성과 섞임 방지)
            if (target.name !== lastIntersectionName) {
                speak(`근처에 ${target.name} 교차로가 있습니다.`);
                lastIntersectionName = target.name;
            }
        }
    } catch (err) {
        console.error("데이터 로드 실패:", err);
        document.getElementById('api-status-text').innerText = "V2X OFFLINE";
    }
}
