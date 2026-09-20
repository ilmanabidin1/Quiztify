# Quiz Unisba

Platform pre & post test untuk dosen Unisba. Dosen membuat quiz pilihan ganda (pre/post test), mahasiswa masuk cukup dengan nama lengkap + NPM, dan sistem menghitung skor serta N-Gain pre vs post secara otomatis.

## Stack
Node.js + Express + better-sqlite3 (SQLite), frontend vanilla HTML/CSS/JS, tanpa build tools. Satu proses, mudah dideploy ke Railway.

## Jalan lokal
```
npm install
DOSEN_PASSWORD=rahasia npm start
```
- Mahasiswa: http://localhost:3000
- Panel dosen: http://localhost:3000/dosen.html (password default `unisba2026`, ganti via env `DOSEN_PASSWORD`)

## Konsep utama
- **Pair key**: isi string yang sama (misal `mnf-2026-3A`) di quiz Pre dan Post-nya. Begitu seorang mahasiswa menyelesaikan keduanya, N-Gain per mahasiswa dan rerata kelas dihitung otomatis.
- Submit ganda ditolak: satu NPM satu kali per quiz.
- Timer otomatis per durasi quiz, auto-submit saat habis.

## Deploy
Set `DOSEN_PASSWORD` di environment dan mount persistent disk di path DB (`DB_PATH`, default `quiz.db` di folder app) supaya data tidak hilang saat redeploy.
