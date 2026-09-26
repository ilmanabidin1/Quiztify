/* Kartu hasil siap dibagikan (1080x1350, pas untuk feed & story).
   qzShareCard({ eyebrow, title, big, sub, stats: [[label, value], ...], footer }) */
(function () {
  const W = 1080, H = 1350;

  function wrap(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  async function draw(opts) {
    try { await document.fonts.ready; } catch (_) {}
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // Latar
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1b1046'); bg.addColorStop(1, '#0b0620');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 360, 0, W / 2, 360, 620);
    glow.addColorStop(0, 'rgba(124,92,255,.45)'); glow.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

    // Logo
    try {
      const logo = new Image();
      logo.src = '/logo.png';
      await logo.decode();
      const lh = 72, lw = logo.width * (lh / logo.height);
      ctx.drawImage(logo, 90, 90, lw, lh);
    } catch (_) {
      ctx.fillStyle = '#fff'; ctx.font = `800 52px ${font}`; ctx.fillText('Quiztify', 90, 150);
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#b8a6ff';
    ctx.font = `700 34px ${font}`;
    ctx.fillText((opts.eyebrow || '').toUpperCase(), W / 2, 330);

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 56px ${font}`;
    wrap(ctx, opts.title || '', W - 200).forEach((l, i) => ctx.fillText(l, W / 2, 410 + i * 68));

    ctx.font = `800 200px ${font}`;
    ctx.fillText(opts.big || '', W / 2, 760);

    ctx.fillStyle = '#d9d4f5';
    ctx.font = `600 44px ${font}`;
    ctx.fillText(opts.sub || '', W / 2, 850);

    // Statistik
    const stats = (opts.stats || []).slice(0, 3);
    if (stats.length) {
      const gap = 24, bw = (W - 180 - gap * (stats.length - 1)) / stats.length;
      stats.forEach(([label, value], i) => {
        const x = 90 + i * (bw + gap), y = 950;
        roundRect(ctx, x, y, bw, 170, 28);
        ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `800 64px ${font}`; ctx.fillText(String(value), x + bw / 2, y + 90);
        ctx.fillStyle = '#a39ec4'; ctx.font = `600 28px ${font}`; ctx.fillText(label, x + bw / 2, y + 138);
      });
    }

    ctx.fillStyle = '#76d83a';
    ctx.font = `700 34px ${font}`;
    ctx.fillText(opts.footer || location.host, W / 2, H - 90);
    return c;
  }

  function modal(url, blob, opts) {
    const wrapEl = document.createElement('div');
    wrapEl.className = 'qz-share-modal';
    wrapEl.innerHTML = `
      <div class="qz-share-box" role="dialog" aria-label="Bagikan hasil">
        <img alt="Kartu hasil">
        <div class="qz-share-actions">
          <button class="qz-share-btn primary" data-act="share">Bagikan</button>
          <button class="qz-share-btn" data-act="download">Unduh gambar</button>
          <button class="qz-share-btn ghost" data-act="close">Tutup</button>
        </div>
      </div>`;
    wrapEl.querySelector('img').src = url;
    const close = () => { wrapEl.remove(); URL.revokeObjectURL(url); };
    const download = () => {
      const a = document.createElement('a');
      a.href = url; a.download = (opts.filename || 'quiztify-hasil') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    };
    wrapEl.addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (e.target === wrapEl || act === 'close') return close();
      if (act === 'download') return download();
      if (act === 'share') {
        const file = new File([blob], (opts.filename || 'quiztify-hasil') + '.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], text: opts.shareText || '' }); } catch (_) {}
        } else {
          download();
          if (window.qzToast) qzToast('Gambar diunduh. Tinggal unggah ke story atau kirim ke teman.', 'info');
        }
      }
    });
    document.body.appendChild(wrapEl);
  }

  window.qzShareCard = async function (opts) {
    const canvas = await draw(opts || {});
    canvas.toBlob((blob) => modal(URL.createObjectURL(blob), blob, opts || {}), 'image/png');
  };
})();
