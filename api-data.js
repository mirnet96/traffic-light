/** [ULTRA VISION AI] - api-data.js */
import { speak } from './utils.js';

const API_BASE_URL = 'https://iot.klueware.com/api/v1';
const API_KEY      = '7c76f496-b1f7-459f-85f1-ec9359276fce';

let lastLat = null, lastLng = null;
let isDataTabInitialized = false;
let kakaoMap = null, kakaoMyMarker = null, geocoder = null;
let signalTimer = null, currentRemainingTime = 0, lastSignalState = ""; 

const getEls = () => ({
    status: document.getElementById('api-status-text-data'),
    detailed: document.getElementById('api-detailed-status'),
    address: document.getElementById('address-text'),
    coords: document.getElementById('location-text'),
    crossName: document.getElementById('cross-name')
});

export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;
    if (window.kakao && kakao.maps.services) geocoder = new kakao.maps.services.Geocoder();
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition((pos) => {
            const { latitude, longitude } = pos.coords;
            lastLat = latitude; lastLng = longitude;
            updateLocationUI(latitude, longitude);
            if (!kakaoMap) renderMap(latitude, longitude);
            else updateMyLocationMarker(latitude, longitude);
        }, (err) => {}, { enableHighAccuracy: true });
    }
}

function updateLocationUI(lat, lng) {
    const els = getEls();
    if (els.coords) els.coords.innerText = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    if (geocoder) {
        geocoder.coord2Address(lng, lat, (result, status) => {
            if (status === kakao.maps.services.Status.OK) els.address.innerText = result[0].address.address_name;
        });
    }
}

export async function fetchSignalData() {
    if (!lastLat || !lastLng) return;
    const els = getEls();
    try {
        const resp = await fetch(`${API_BASE_URL}/signals?lat=${lastLat}&lng=${lastLng}`, { headers: { 'x-api-key': API_KEY } });
        const data = await resp.json();
        if (data && data.length > 0) {
            if (els.crossName) els.crossName.innerText = data[0].itstName;
            startSignalCountdown(data[0]);
        }
    } catch (err) { console.error(err); }
}

function startSignalCountdown(signalData) {
    if (signalTimer) clearInterval(signalTimer);
    currentRemainingTime = parseInt(signalData.remainingTime || 0);
    lastSignalState = signalData.signalState;
    const stateFull = lastSignalState === "G" ? "초록불" : "빨간불";
    speak(`${stateFull}입니다. ${currentRemainingTime}초 남았습니다.`);

    signalTimer = setInterval(() => {
        currentRemainingTime--;
        const els = getEls();
        if (els.detailed) {
            els.detailed.innerText = `${stateFull}: ${currentRemainingTime}초 남음`;
            els.detailed.style.color = lastSignalState === "G" ? "#34C759" : "#FF3B30";
        }
        if (currentRemainingTime === 5) speak("신호 변경 5초 전입니다.");
        if (currentRemainingTime <= 0) { clearInterval(signalTimer); fetchSignalData(); }
    }, 1000);
}

function renderMap(lat, lng) {
    const container = document.getElementById('map');
    const options = { center: new kakao.maps.LatLng(lat, lng), level: 3 };
    kakaoMap = new kakao.maps.Map(container, options);
    window.kakaoMapInstance = kakaoMap;
    updateMyLocationMarker(lat, lng);
}

function updateMyLocationMarker(lat, lng) {
    const pos = new kakao.maps.LatLng(lat, lng);
    if (!kakaoMyMarker) kakaoMyMarker = new kakao.maps.Marker({ position: pos, map: kakaoMap });
    else kakaoMyMarker.setPosition(pos);
    if (kakaoMap) kakaoMap.setCenter(pos);
}
