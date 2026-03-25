import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { speak } from './app.js';

const supabase = createClient(
    'https://olktyhzffothlpxeddtx.supabase.co', 
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sa3R5aHpmZm90aGxweGVkZHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDIwNzUsImV4cCI6MjA4OTk3ODA3NX0.XuFgDFo0FC6BomZrwjD0cMdtQTXzVcEABDNo-VoIm2g'
);

let lastLat, lastLng;

export function initDataTab() {
    navigator.geolocation.getCurrentPosition(async (pos) => {
        lastLat = pos.coords.latitude;
        lastLng = pos.coords.longitude;
        renderMap(lastLat, lastLng);
        await fetchSignalData();
    });
}

function renderMap(lat, lng) {
    const map = new naver.maps.Map('map', { center: new naver.maps.LatLng(lat, lng), zoom: 18 });
    new naver.maps.Marker({ position: new naver.maps.LatLng(lat, lng), map: map });
}

export async function fetchSignalData() {
    const { data, error } = await supabase.rpc('get_nearest_intersection', { 
        user_lat: lastLat, user_lng: lastLng 
    });

    if (data && data.length > 0) {
        const target = data[0];
        document.getElementById('cross-name').innerText = target.name;
        document.getElementById('location-text').innerText = `${Math.round(target.dist_meters)}m 근처 교차로`;
        document.getElementById('api-status-text').innerText = "V2X ACTIVE";
        speak(`근처에 ${target.name} 교차로가 있습니다.`);
    }
}
