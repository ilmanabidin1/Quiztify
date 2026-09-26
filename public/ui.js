/* Quiztify UI kit: non-blocking toasts (replacing native alert) and the
   mobile drawer for the creator sidebar. Loaded on every page. */
(function () {
  'use strict';

  let stack = null;
  function ensureStack() {
    if (stack && document.body.contains(stack)) return stack;
    stack = document.createElement('div');
    stack.className = 'qz-toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
    return stack;
  }

  function guessType(msg) {
    const m = String(msg).toLowerCase();
    if (/gagal|error|tidak (valid|mendukung|memiliki akses)|wajib|dilarang|peringatan|⚠|diblokir|salah/.test(m)) return 'error';
    if (/berhasil|sukses|🎉|✅|disimpan|dihapus|diakhiri|luar biasa/.test(m)) return 'success';
    return 'info';
  }

  const ICONS = { success: '✓', error: '!', info: 'i' };

  function toast(message, type, duration) {
    if (!document.body) return;
    type = type || guessType(message);
    const text = String(message == null ? '' : message).trim();
    duration = duration || Math.min(9000, 3200 + text.length * 35);

    const el = document.createElement('div');
    el.className = 'qz-toast ' + type;
    el.style.position = 'relative';
    el.style.overflow = 'hidden';
    el.innerHTML =
      '<div class="qz-toast-icon" aria-hidden="true">' + ICONS[type] + '</div>' +
      '<div class="qz-toast-body"></div>' +
      '<button class="qz-toast-close" aria-label="Tutup notifikasi">×</button>';
    el.querySelector('.qz-toast-body').textContent = text;

    const s = ensureStack();
    s.appendChild(el);
    while (s.children.length > 4) s.firstElementChild.remove();

    let timer;
    const close = () => {
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 250);
    };
    const start = () => { timer = setTimeout(close, duration); };
    el.querySelector('.qz-toast-close').addEventListener('click', close);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', start);
    start();
    return close;
  }

  window.qzToast = toast;
  window.qzEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Every alert() in the app is fire-and-forget feedback, so a toast keeps
  // the same message without freezing the page behind a browser dialog.
  window.alert = function (msg) { toast(msg); };

  /* ---------- Creator sidebar drawer (mobile) ---------- */
  function setupDrawer() {
    const sidebar = document.querySelector('body > .sidebar');
    const header = document.querySelector('.top-header');
    if (!sidebar || !header || header.querySelector('.qz-menu-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'qz-menu-btn';
    btn.setAttribute('aria-label', 'Buka menu navigasi');
    btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
    header.insertBefore(btn, header.firstChild);

    const scrim = document.createElement('div');
    scrim.className = 'qz-drawer-scrim';
    document.body.appendChild(scrim);

    const setOpen = (open) => document.body.classList.toggle('qz-drawer-open', open);
    btn.addEventListener('click', () => setOpen(true));
    scrim.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    sidebar.addEventListener('click', (e) => { if (e.target.closest('.nav-btn')) setOpen(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupDrawer);
  else setupDrawer();
})();
