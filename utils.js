// utils.js
let isSpeaking = false;

export function speak(text) {
    if (isSpeaking) window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.1;
    utterance.pitch = 1.0;

    utterance.onstart = () => { isSpeaking = true; };
    utterance.onend = () => { isSpeaking = false; };

    window.speechSynthesis.speak(utterance);
}
