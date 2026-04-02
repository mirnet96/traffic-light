/** [ULTRA VISION AI] - utils.js v5
 *  [FIX] UNKNOWN 상태 TTS 미발화
 *  [NEW] navigator.language 기반 ko/en 분기
 *  [NEW] navigator.vibrate() 촉각 피드백 (RED: 단진동, GREEN: 장진동)
 */

let isSpeaking = false;

const LANG = navigator.language?.startsWith('ko') ? 'ko' : 'en';

const TEXTS = {
    ko: { RED: '빨간불, 정지', GREEN: '초록불, 통행 가능' },
    en: { RED: 'Red light, stop', GREEN: 'Green light, go' },
};

export function speak(signal) {
    // [FIX] UNKNOWN은 TTS/진동 없음
    if (signal === 'UNKNOWN') return;

    const text = TEXTS[LANG][signal];
    if (!text) return;

    // 진동 피드백
    if (navigator.vibrate) {
        if (signal === 'RED')   navigator.vibrate(200);
        if (signal === 'GREEN') navigator.vibrate([100, 50, 100]);
    }

    if (isSpeaking) {
        window.speechSynthesis.cancel();
        setTimeout(() => _doSpeak(text), 50);
    } else {
        _doSpeak(text);
    }
}

function _doSpeak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = LANG === 'ko' ? 'ko-KR' : 'en-US';
    u.rate  = 1.1;
    u.pitch = 1.0;
    u.onstart = () => { isSpeaking = true; };
    u.onend   = () => { isSpeaking = false; };
    window.speechSynthesis.speak(u);
}
