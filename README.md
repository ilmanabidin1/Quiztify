# ⚡ Quiztify.id — Platform Kuis Interaktif, Gamifikasi & Asesmen Modern ala Quizizz

**Quiztify.id** adalah platform pembelajaran berbasis kuis interaktif, gamifikasi *real-time multiplayer*, dan evaluasi hasil belajar komprehensif (Pre-Test & Post-Test N-Gain) yang dirancang siap untuk dikomersialkan (*SaaS/EdTech ready*).

---

## 🌟 Fitur Utama

### 🎮 1. Mode Multiplayer Real-time (Game PIN 6 Digit)
- **Instant Join**: Peserta cukup memasukkan 6 digit Game PIN dan memilih avatar tanpa perlu registrasi akun.
- **Proyektor Host / Presenter**: Layar besar dengan kode PIN raksasa, QR Code, dan roster peserta yang masuk secara interaktif.
- **Gameplay Cepat ala Quizizz**:
  - 4 tombol jawaban warna-warni (*Violet ▲, Cyan ◆, Amber ●, Rose ■*).
  - Poin dinamis berbasis kecepatan menjawab.
  - Kombo streak api (🔥 x2, x3, x4).
  - Feedback seketika dan pembahasan soal.
  - Papan klasemen (*Live Leaderboard*) dan podium juara beranimasi konfeti 🏆.

### 🤖 2. Quiz Studio Pro & AI Smart Quiz Generator
- **AI Generator**: Cukup ketik topik materi (misal: *Pemrograman Web*, *Biologi Sel*, *Pemasaran Digital*), sistem otomatis menyusun soal, opsi, kunci, dan pembahasan hanya dalam 1 klik.
- Pengaturan batas waktu (15s, 20s, 30s, 60s) dan bobot poin per soal.

### 📊 3. Evaluasi Pembelajaran & Hake's N-Gain (Akademik Ready)
- Pengukuran peningkatan kompetensi sebelum (*Pre-Test*) dan sesudah (*Post-Test*) pembelajaran secara ilmiah dengan metrik *Normalized Gain* (N-Gain).
- Klasifikasi efektivitas otomatis: **Tinggi (g ≥ 0.7)**, **Sedang (0.3 ≤ g < 0.7)**, dan **Rendah (g < 0.3)**.
- **Ekspor Laporan CSV/Excel**: Unduh rekapitulasi nilai seluruh kelas dalam satu klik.

### 🔥 Retensi & Pertumbuhan
- **Portal mahasiswa** (`/student.html`): daftar dengan kode kelas, kerjakan kuis kelas, lihat nilai.
- **5 soal harian + streak**: soal diambil dari kuis yang sudah dikerjakan; soal yang pernah salah diulang dengan jeda 1, 3, 7, 14 hari sampai dikuasai.
- **Liga mingguan**: XP dari soal harian dan kuis kelas; divisi Perunggu, Perak, Emas, Berlian dengan zona naik/turun tiap Senin (WIB).
- **Duel 1 lawan 1** (`/duel.html?code=`): tantang teman lewat link, 5 soal, poin dari ketepatan dan kecepatan.
- **Kartu hasil**: gambar 1080x1350 siap dibagikan dari podium, duel, dan soal harian.
- **Mode tim & taruhan soal terakhir** di kuis live; **rekap sesi** otomatis di layar akhir.
- **Kuis dari materi kuliah**: upload PDF/PPTX/TXT, soal merujuk halaman sumber.
- **Peta miskonsepsi**: jawaban salah terpopuler per soal di modal diagnostik.
- **Rapor semester** (Pro): rekap N-Gain per materi, asesmen, dan capaian mahasiswa siap cetak.

### 🔊 4. Web Audio API Sound Synthesizer Bawaan
- Efek suara audio synthesizer jernih langsung dari browser (tanpa aset file eksternal lambat): suara hitung mundur, nada jawaban benar, suara buzz salah, kombo streak, dan fanfare kemenangan podium. Dilengkapi tombol *Mute/Unmute*.

### 💎 5. Model Bisnis Komersial (SaaS Tiers)
- **Free Starter**: Untuk kelas kecil hingga 30 peserta.
- **Pro Creator**: Peserta tanpa batas, AI quiz generator, ekspor nilai CSV/Excel, proyektor host live.
- **Campus / Enterprise**: Multi-dosen, integrasi LMS Moodle/Canvas, SSO, domain kustom institusi.

---

## 🚀 Menjalankan Secara Lokal

```bash
# 1. Install dependencies
npm install

# 2. Jalankan server
npm start
```

Akses di browser:
- **Portal Pemain & Beranda Utama**: [http://localhost:3000](http://localhost:3000)
- **Studio Creator / Dosen**: [http://localhost:3000/creator.html](http://localhost:3000/creator.html)
  - *Default Login Creator*: `admin@quiztify.id` / `quiztify2026`

---

## 🛠️ Tech Stack
- **Backend**: Node.js (v22+ built-in `node:sqlite` DatabaseSync), Express.js, QR Code Generator.
- **Frontend**: Responsive Modern UI (HTML5, CSS3 Variables, Glassmorphism, Canvas Confetti, Web Audio API).
- **Database**: SQLite WAL Mode (ultra cepat, zero-config, persistent).

---

© 2026 Quiztify.id — Interactive Learning & Gamified Assessment Platform.
