// utils.js
let isSpeaking = false;
export function speak(text) {
    if (isSpeaking) {
        window.speechSynthesis.cancel();
        // [FIX] iOS Safari에서 cancel() 직후 speak() 호출 시 발화가 무시되는 문제
        // → 50ms 지연 후 speak() 호출로 해결
        setTimeout(() => _doSpeak(text), 50);
    } else {
        _doSpeak(text);
    }
}

function _doSpeak(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.1;
    utterance.pitch = 1.0;
    utterance.onstart = () => { isSpeaking = true; };
    utterance.onend   = () => { isSpeaking = false; };
    window.speechSynthesis.speak(utterance);
}
