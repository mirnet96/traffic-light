/* ════════════════════════════════════
   renderer.js — 오버레이 박스 + 하단 카드
════════════════════════════════════ */

/* ── 오버레이 박스 그리기 ── */
export function drawBoxes(octx, signals, W, H) {
  octx.clearRect(0, 0, W, H);
  signals.forEach(sig => {
    const [y1, x1, y2, x2] = sig.box;
    const bx = x1*W, by = y1*H, bw = (x2-x1)*W, bh = (y2-y1)*H;
    const color   = sig.isPedestrian ? '#ffffff' : '#ffcc00';
    const boxLine = sig.isPedestrian ? 3 : 1.5;

    octx.strokeStyle = color; octx.lineWidth = boxLine;
    octx.strokeRect(bx, by, bw, bh);

    // 모서리 강조
    const cs = sig.isPedestrian ? 18 : 12;
    octx.lineWidth = boxLine + 2;
    [[bx,by],[bx+bw,by],[bx,by+bh],[bx+bw,by+bh]].forEach(([cx,cy], i) => {
      octx.beginPath();
      octx.moveTo(cx + (i%2===0 ? cs : -cs), cy);
      octx.lineTo(cx, cy);
      octx.lineTo(cx, cy + (i<2 ? cs : -cs));
      octx.stroke();
    });

    // 레이블
    const label    = sig.isPedestrian
      ? `보행신호 ${Math.round(sig.score*100)}%`
      : `신호등 ${Math.round(sig.score*100)}%`;
    const rangeTag = sig.range === 'near' ? '근거리' : '원거리';
    const fs       = Math.max(11, bw * 0.15);
    octx.font      = `bold ${fs}px system-ui,sans-serif`;
    const labelW   = octx.measureText(label).width + 8;  // 변수명 명확화
    octx.fillStyle = color;
    octx.fillRect(bx, by - fs - 6, labelW, fs + 6);
    octx.fillStyle = '#000';
    octx.fillText(label, bx + 4, by - 4);
    octx.fillStyle = sig.range === 'near' ? '#60a5fa' : '#a78bfa';
    octx.font      = `${Math.max(10, fs * 0.8)}px system-ui,sans-serif`;
    octx.fillText(rangeTag, bx + 4, by + fs + 4);
  });
}

/* ── 하단 카드 렌더 ── */
export function renderCards(signals, onTap, onEmpty) {
  const list  = document.getElementById('det-list');
  const empty = document.getElementById('det-empty');

  if (!signals.length) {
    onEmpty();          // opacity 리셋 포함 처리는 app.js의 showDetEmpty()
    list.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = signals.map((sig, i) => {
    const isPed    = sig.isPedestrian;
    const accent   = isPed ? '#ffffff' : '#ffcc00';
    const icon     = isPed ? 'directions_walk' : 'traffic';
    const label    = isPed ? '보행신호등' : '신호등';
    const tag      = sig.range === 'near' ? '근거리' : '원거리';
    const tagColor = sig.range === 'near' ? '#60a5fa' : '#a78bfa';
    return `
      <div class="det-card shrink-0 bg-neutral-900 rounded-xl px-4 py-2.5 text-center min-w-[110px] cursor-pointer active:scale-95 transition-transform"
           data-i="${i}" style="border:1.5px solid ${accent}">
        <span class="material-symbols-rounded block text-3xl leading-none mb-1"
              style="color:${accent}">${icon}</span>
        <div class="text-[14px] font-bold" style="color:${accent}">${label}</div>
        <div class="text-[11px] mt-0.5" style="color:${tagColor}">${tag}</div>
        <div class="text-[11px] text-neutral-500 mt-0.5">
          ${Math.round(sig.score*100)}% · YOLO · 탭하여 확대
        </div>
      </div>`;
  }).join('');

  const snapshot = signals.slice();
  list.querySelectorAll('.det-card').forEach(el =>
    el.addEventListener('click', () => onTap(snapshot[+el.dataset.i]))
  );
}
