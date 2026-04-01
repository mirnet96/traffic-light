/** [ULTRA VISION AI] - api-data.js
 *  [FIX] 기존 파일에 vision-analyzer.js 내용이 잘못 포함되어 있던 문제 수정
 *        analyzeROI / detectByHSV / rgbToHSV 데드 코드 전면 제거
 *  [FIX] initDataTab export 구현 → app.js 동적 import 정상 동작
 *  V2X DATA 탭: GPS 위치 추적, 카카오맵 표시, 주소 역지오코딩
 */

let _mapInitialized  = false;
let _watchId         = null;
let _kakaoMap        = null;
let _kakaoMarker     = null;
let _geocoder        = null;

// ─────────────────────────────────────────────
// initDataTab: app.js에서 DATA 탭 활성화 시 호출
// ─────────────────────────────────────────────
export function initDataTab() {
    if (_mapInitialized) {
        // 이미 초기화됐으면 GPS만 재시작
        _startGPS();
        return;
    }
    _initKakaoMap();
    _startGPS();
    _bindRefreshButton();
    _mapInitialized = true;
}

// ─────────────────────────────────────────────
// 카카오맵 초기화
// ─────────────────────────────────────────────
function _initKakaoMap() {
    const mapEl = document.getElementById('map');
    if (!mapEl || typeof kakao === 'undefined') {
        console.warn('[api-data] 카카오맵 SDK 없음');
        return;
    }

    try {
        const options = {
            center: new kakao.maps.LatLng(37.5665, 126.9780),
            level: 3
        };
        _kakaoMap = new kakao.maps.Map(mapEl, options);
        window.kakaoMapInstance = _kakaoMap;

        _kakaoMarker = new kakao.maps.Marker({
            position: _kakaoMap.getCenter()
        });
        _kakaoMarker.setMap(_kakaoMap);

        _geocoder = new kakao.maps.services.Geocoder();
        console.log('[api-data] 카카오맵 초기화 완료');
    } catch (e) {
        console.error('[api-data] 카카오맵 초기화 실패:', e.message);
    }
}

// ─────────────────────────────────────────────
// GPS 위치 추적
// ─────────────────────────────────────────────
function _startGPS() {
    if (!navigator.geolocation) {
        _setAddress('위치 서비스를 지원하지 않는 환경입니다.');
        return;
    }

    // 기존 watch 중단
    if (_watchId !== null) {
        navigator.geolocation.clearWatch(_watchId);
        _watchId = null;
    }

    _watchId = navigator.geolocation.watchPosition(
        _onPositionUpdate,
        _onPositionError,
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
}

function _onPositionUpdate(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    // 좌표 텍스트 업데이트
    const locEl = document.getElementById('location-text');
    if (locEl) locEl.innerText = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    // 카카오맵 마커/중심 이동
    if (_kakaoMap && _kakaoMarker && typeof kakao !== 'undefined') {
        try {
            const latlng = new kakao.maps.LatLng(lat, lng);
            _kakaoMap.setCenter(latlng);
            _kakaoMarker.setPosition(latlng);
        } catch (e) {
            console.warn('[api-data] 지도 갱신 실패:', e.message);
        }
    }

    // 역지오코딩 (주소 표시)
    if (_geocoder) {
        try {
            _geocoder.coord2Address(lng, lat, (result, status) => {
                if (status === kakao.maps.services.Status.OK && result[0]) {
                    const addr = result[0].road_address
                        ? result[0].road_address.address_name
                        : result[0].address.address_name;
                    _setAddress(addr);
                } else {
                    _setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
                }
            });
        } catch (e) {
            _setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
        }
    } else {
        _setAddress(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    }

    // API 상태 카드 갱신
    _updateApiCard('ACTIVE', '위치 추적 중');
}

function _onPositionError(err) {
    console.warn('[api-data] GPS 오류:', err.message);
    _setAddress('위치 정보를 가져올 수 없습니다.');
    _updateApiCard('ERROR', err.message);
}

// ─────────────────────────────────────────────
// UI 헬퍼
// ─────────────────────────────────────────────
function _setAddress(text) {
    const el = document.getElementById('address-text');
    if (el) el.innerText = text;
}

function _updateApiCard(status, detail) {
    const statusEl  = document.getElementById('api-status-text-data');
    const detailEl  = document.getElementById('api-detailed-status');
    const nameEl    = document.getElementById('cross-name');

    if (statusEl) statusEl.innerText = status;
    if (detailEl) detailEl.innerText = detail || '';
    if (nameEl && status === 'ACTIVE') nameEl.innerText = 'GPS LIVE';
}

// ─────────────────────────────────────────────
// 수동 새로고침 버튼
// ─────────────────────────────────────────────
function _bindRefreshButton() {
    const btn = document.getElementById('refresh-api');
    if (!btn) return;
    btn.addEventListener('click', () => {
        _updateApiCard('LOADING', '갱신 중...');
        _setAddress('주소를 불러오는 중...');
        // GPS 재시작
        _startGPS();
    });
}
