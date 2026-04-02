// utils.js
let isSpeaking = false;
export function speak(text) {
    if (isSpeaking) {
        window.speechSynthesis.cancel();
        setTimeout(() => _doSpeak(text), 50);
    } else {
        _doSpeak(text);
    }
}
function _doSpeak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR'; u.rate = 1.1; u.pitch = 1.0;
    u.onstart = () => { isSpeaking = true; };
    u.onend   = () => { isSpeaking = false; };
    window.speechSynthesis.speak(u);
}
