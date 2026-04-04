/* ════════════════════════════════════
   settings.js — 설정 읽기/관리
════════════════════════════════════ */

export const cfg = { tts: true, debug: false, rec: false };

export function readConfig() {
  cfg.tts   = document.getElementById('cfg-tts').checked;
  cfg.debug = document.getElementById('cfg-debug').checked;
  cfg.rec   = document.getElementById('cfg-rec').checked;
}
