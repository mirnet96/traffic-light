/* ════════════════════════════════════
   app.js — 진입점 · 설정 초기화 · 이벤트
════════════════════════════════════ */

import { startCamera, camFacing }   from './camera.js';
import { readConfig }               from './settings.js';
import { applyNight, getNightMode } from './ui.js';
import { closeFullscreen }          from './fullscreen.js';

/* ════════════════════════════════════
   설정 토글 초기화
════════════════════════════════════ */
function initSettings() {
  const items = [
    { row: 'row-tts',   input: 'cfg-tts',   track: 'cfg-tts-track',   thumb: 'cfg-tts-thumb'   },
    { row: 'row-debug', input: 'cfg-debug', track: 'cfg-debug-track', thumb: 'cfg-debug-thumb' },
    { row: 'row-rec',   input: 'cfg-rec',   track: 'cfg-rec-track',   thumb: 'cfg-rec-thumb'   },
  ];
  items.forEach(({ row, input, track, thumb }) => {
    const rowEl   = document.getElementById(row);
    const inputEl = document.getElementById(input);
    const trackEl = document.getElementById(track);
    const thumbEl = document.getElementById(thumb);
    rowEl.addEventListener('click', () => {
      inputEl.checked = !inputEl.checked;
      trackEl.style.background = inputEl.checked ? '#2563eb' : '#3a3a3a';
      thumbEl.style.transform  = inputEl.checked ? 'translateX(18px)' : 'translateX(0)';
      readConfig();
    });
  });
}

/* ════════════════════════════════════
   이벤트 등록
════════════════════════════════════ */
initSettings();

const btnStart = document.getElementById('btn-start');
const btnRetry = document.getElementById('btn-retry');
if (btnStart) btnStart.addEventListener('click', () => startCamera());
else console.error('[app] btn-start 없음');
if (btnRetry) btnRetry.addEventListener('click', () => startCamera());

document.getElementById('btn-night').addEventListener('click',
  () => applyNight(!getNightMode()));

document.getElementById('btn-flip').addEventListener('click',
  () => startCamera(camFacing === 'environment' ? 'user' : 'environment'));

document.getElementById('fs').addEventListener('click', closeFullscreen);
