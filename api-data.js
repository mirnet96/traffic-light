/** [ULTRA VISION AI] - api-data.js */
import { speak } from './utils.js';

const API_BASE_URL = 'https://iot.klueware.com/api/v1';
const API_KEY      = '7c76f496-b1f7-459f-85f1-ec9359276fce';

let lastLat = null, lastLng = null;
let isDataTabInitialized = false;
let kakaoMap = null, kakaoMyMarker = null, geocoder = null;
let signalTimer = null;

const getEls = () => ({
    status: document.getElementById('api-status-text-data'),
    detailed: document.getElementById('api-detailed-status'),
    address: document.getElementById('address-text'),
    coords: document.getElementById('location-text'),
    crossName: document.getElementById('cross-name')
});

export function initDataTab() {
    if (isDataTabInitialized) return;
    
    // 카카오맵 SDK 로드 대기 후 초기화
    if (window.kakao && kakao.maps.services) {
        geocoder = new kakao.maps.services.Geocoder();
        isDataTabInitialized = true;
    } else {
        setTimeout(initDataTab, 500);
        return;
    }
    
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition((pos) => {
            const { latitude, longitude } = pos.coords;
            lastLat = latitude; lastLng = longitude;
            updateLocationUI(latitude, longitude);
            if (!kakaoMap) renderMap(latitude, longitude);
            else updateMyLocationMarker(latitude, longitude);
        }, (err) => console.error(err), { enableHighAccuracy: true });
    }
}

function updateLocationUI(lat, lng) {
    const els = getEls();
    if (els.coords) els.coords.innerText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (geocoder) {
        geocoder.coord2Address(lng, lat, (result, status) => {
            if (status === kakao.maps.services.Status.OK) {
                const addr = result[0].road_address ? result[0].road_address.address_name : result[0].address.address_name;
                if (els.address) els.address.innerText = addr;
            }
        });
    }
}

export async function fetchSignalData() {
    if (!lastLat || !lastLng) return;
    const els = getEls();
    try {
        // 엔드포인트 수정: traffic-signals
        const resp = await fetch(`${API_BASE_URL}/traffic-signals?lat=${lastLat}&lng=${lastLng}`, { 
            headers: { 'x-api-key': API_KEY } 
        });
        const data = await resp.json();
        if (data && data.length > 0) {
            if (els.crossName) els.crossName.innerText = data[0].itstName;
            // 카운트다운 로직...
        }
    } catch (err) { console.error(err); }
}

function renderMap(lat, lng) {
    const container = document.getElementById('map');
    if (!container) return;
    const options = { center: new kakao.maps.LatLng(lat, lng), level: 3 };
    kakaoMap = new kakao.maps.Map(container, options);
    window.kakaoMapInstance = kakaoMap;
    updateMyLocationMarker(lat, lng);
}

function updateMyLocationMarker(lat, lng) {
    const pos = new kakao.maps.LatLng(lat, lng);
    if (!kakaoMyMarker) kakaoMyMarker = new kakao.maps.Marker({ position: pos, map: kakaoMap });
    else kakaoMyMarker.setPosition(pos);
}
