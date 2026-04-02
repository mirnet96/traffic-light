/** [ULTRA VISION AI] - api-data.js v5
 *  [FIX] GPS watchPosition — VISION 탭 전환 시 clearWatch (배터리 절약)
 *  [NEW] stopGPS() export → app.js visibilitychange / switchTab에서 호출 가능
 */

let _mapInitialized = false;
let _watchId        = null;
let _kakaoMap       = null;
let _kakaoMarker    = null;
let _geocoder       = null;

export function initDataTab() {
    if (_mapInitialized) { _startGPS(); return; }
    _initKakaoMap();
    _startGPS();
    _bindRefreshButton();
    _mapInitialized = true;
}

// [NEW] GPS 중단 — 외부에서 호출 가능
export function stopGPS() {
    if (_watchId !== null) {
        navigator.geolocation.clearWatch(_watchId);
        _watchId = null;
        console.log('[GPS] 중단');
    }
}

function _initKakaoMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl || typeof kakao === 'undefined') { console.warn('[api-data] 카카오맵 SDK 없음'); return; }
    try {
        _kakaoMap = new kakao.maps.Map(mapEl, {
            center: new kakao.maps.LatLng(37.5665, 126.9780), level: 3
        });
        window.kakaoMapInstance = _kakaoMap;
        _kakaoMarker = new kakao.maps.Marker({ position: _kakaoMap.getCenter() });
        _kakaoMarker.setMap(_kakaoMap);
        _geocoder = new kakao.maps.services.Geocoder();
        console.log('[api-data] 카카오맵 초기화 완료');
    } catch (e) { console.error('[api-data] 카카오맵 초기화 실패:', e.message); }
}

function _startGPS() {
    if (!navigator.geolocation) { _setAddress('위치 서비스를 지원하지 않는 환경입니다.'); return; }
    // 기존 watch 중단 후 재시작
    if (_watchId !== null) { navigator.geolocation.clearWatch(_watchId); _watchId = null; }
    _watchId = navigator.geolocation.watchPosition(
        _onPositionUpdate, _onPositionError,
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
}

function _onPositionUpdate(pos) {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    const locEl = document.getElementById('location-text');
    if (locEl) locEl.innerText = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    if (_kakaoMap && _kakaoMarker && typeof kakao !== 'undefined') {
        try {
            const ll = new kakao.maps.LatLng(lat, lng);
            _kakaoMap.setCenter(ll); _kakaoMarker.setPosition(ll);
        } catch (e) { console.warn('[api-data] 지도 갱신 실패:', e.message); }
    }

    if (_geocoder) {
        try {
            _geocoder.coord2Address(lng, lat, (result, status) => {
                if (status === kakao.maps.services.Status.OK && result[0]) {
                    const addr = result[0].road_address
                        ? result[0].road_address.address_name
                        : result[0].address.address_name;
                    _setAddress(addr);
                } else _setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
            });
        } catch (e) { _setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`); }
    } else _setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);

    _updateApiCard('ACTIVE', '위치 추적 중');
}

function _onPositionError(err) {
    console.warn('[api-data] GPS 오류:', err.message);
    _setAddress('위치 정보를 가져올 수 없습니다.');
    _updateApiCard('ERROR', err.message);
}

function _setAddress(text) { const el = document.getElementById('address-text'); if (el) el.innerText = text; }

function _updateApiCard(status, detail) {
    const sEl = document.getElementById('api-status-text-data');
    const dEl = document.getElementById('api-detailed-status');
    const nEl = document.getElementById('cross-name');
    if (sEl) sEl.innerText = status;
    if (dEl) dEl.innerText = detail || '';
    if (nEl && status === 'ACTIVE') nEl.innerText = 'GPS LIVE';
}

function _bindRefreshButton() {
    const btn = document.getElementById('refresh-api');
    if (!btn) return;
    btn.addEventListener('click', () => {
        _updateApiCard('LOADING', '갱신 중...');
        _setAddress('주소를 불러오는 중...');
        _startGPS();
    });
}
