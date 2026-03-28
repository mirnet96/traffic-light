/** [ULTRA VISION AI] - api-data.js */
import { speak } from './utils.js';

const API_BASE_URL = 'https://iot.klueware.com/api/v1';
const API_KEY      = '7c76f496-b1f7-459f-85f1-ec9359276fce';

let lastLat = null, lastLng = null;
let isDataTabInitialized = false;
let kakaoMap = null;
let kakaoMyMarker = null;
let geocoder = null;

// UI 요소 캐싱
const getEls = () => ({
    status: document.getElementById('api-status-text-data'),
    detailed: document.getElementById('api-detailed-status'),
    error: document.getElementById('api-error-msg'),
    address: document.getElementById('address-text'),
    coords: document.getElementById('location-text'),
    crossName: document.getElementById('cross-name')
});

export function initDataTab() {
    if (isDataTabInitialized) return;
    isDataTabInitialized = true;
    
    // 카카오 주소 변환 서비스 초기화
    if (window.kakao && kakao.maps.services) {
        geocoder = new kakao.maps.services.Geocoder();
    }
    
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                lastLat = latitude;
                lastLng = longitude;
                
                updateLocationUI(latitude, longitude);
                
                if (!kakaoMap) {
                    renderMap(latitude, longitude);
                } else {
                    updateMyLocationMarker(latitude, longitude);
                }
            },
            (err) => updateStatus('GPS ERROR', err.message, true),
            { enableHighAccuracy: true }
        );
    }
}

// 상세 상태 업데이트 함수
function updateStatus(stage, detail = '', isError = false) {
    const els = getEls();
    if (!els.detailed) return;

    els.detailed.innerText = stage;
    els.detailed.style.color = isError ? '#ef4444' : '#71717a';
    
    if (els.error) {
        els.error.classList.toggle('hidden', !isError);
        if (isError) els.error.innerText = detail;
    }
    console.log(`[V2X STATUS] ${stage}: ${detail}`);
}

// 주소 및 좌표 텍스트 업데이트
function updateLocationUI(lat, lng) {
    const els = getEls();
    if (els.coords) els.coords.innerText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    
    if (geocoder) {
        geocoder.coord2Address(lng, lat, (result, status) => {
            if (status === kakao.maps.services.Status.OK) {
                // 도로명 주소 우선, 없으면 지번 주소
                const addr = result[0].road_address ? result[0].road_address.address_name : result[0].address.address_name;
                if (els.address) els.address.innerText = addr;
            }
        });
    }
}

export async function fetchSignalData() {
    if (!lastLat || !lastLng) {
        updateStatus('WAITING GPS', '위치 정보를 수신 중입니다.', true);
        return;
    }

    const els = getEls();
    updateStatus('REQUESTING', '서버에서 신호 정보를 가져오는 중...');
    
    if (els.status) {
        els.status.innerText = "FETCH";
        els.status.style.color = "#3b82f6";
    }

    try {
        const url = `${API_BASE_URL}/traffic-signals?lat=${lastLat}&lng=${lastLng}`;
        const resp = await fetch(url, {
            headers: { 'x-api-key': API_KEY }
        });

        if (!resp.ok) throw new Error(`서버 응답 오류 (HTTP ${resp.status})`);

        const data = await resp.json();
        
        if (data && data.length > 0) {
            updateStatus('SUCCESS', `${data.length}개의 신호 데이터 수신`);
            if (els.status) {
                els.status.innerText = "LIVE";
                els.status.style.color = "#22c55e";
            }
            if (els.crossName) els.crossName.innerText = data[0].itstName || "교차로 정보 없음";
            // 여기서부터 신호 카운트다운 등의 추가 로직 수행 가능
        } else {
            throw new Error("주변에 검색된 교차로가 없습니다.");
        }
    } catch (err) {
        updateStatus('API ERROR', err.message, true);
        if (els.status) {
            els.status.innerText = "FAIL";
            els.status.style.color = "#7f1d1d";
        }
        if (els.crossName) els.crossName.innerText = "데이터 없음";
    }
}

function renderMap(lat, lng) {
    const container = document.getElementById('map');
    if (!container) return;
    
    const options = {
        center: new kakao.maps.LatLng(lat, lng),
        level: 3
    };
    kakaoMap = new kakao.maps.Map(container, options);
    window.kakaoMapInstance = kakaoMap;
    updateMyLocationMarker(lat, lng);
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
