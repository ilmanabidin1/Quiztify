// Quiztify.id - Web Audio API Synthesizer (Zero External Dependencies)
// Suara jernih, responsif, dan hemat bandwidth ala game arcade & Quizizz

class QuizSoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('quiztify_muted') === 'true';
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('quiztify_muted', this.muted ? 'true' : 'false');
    return !this.muted;
  }

  isMuted() {
    return this.muted;
  }

  play(type) {
    if (this.muted) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;

      if (type === 'click') {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.05);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (type === 'tick') {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(900, now);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.04);
      } else if (type === 'correct') {
        // Melodi ceria C5 -> E5 -> G5 -> C6
        const freqs = [523.25, 659.25, 783.99, 1046.50];
        freqs.forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, now + i * 0.08);
          gain.gain.setValueAtTime(0.25, now + i * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * 0.08 + 0.12);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + i * 0.08);
          osc.stop(now + (i + 1) * 0.08 + 0.12);
        });
      } else if (type === 'wrong') {
        // Suara boing / buzz nada turun
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.25);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
      } else if (type === 'streak') {
        // Suara api kombo seru
        [440, 554.37, 659.25, 880, 1108.73].forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(f, now + i * 0.06);
          gain.gain.setValueAtTime(0.28, now + i * 0.06);
          gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * 0.06 + 0.15);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + i * 0.06);
          osc.stop(now + (i + 1) * 0.06 + 0.15);
        });
      } else if (type === 'podium' || type === 'victory') {
        // Fanfare kemenangan
        const notes = [
          { f: 523.25, d: 0.12 },
          { f: 523.25, d: 0.12 },
          { f: 523.25, d: 0.12 },
          { f: 659.25, d: 0.28 },
          { f: 783.99, d: 0.35 },
          { f: 1046.50, d: 0.55 }
        ];
        let offset = 0;
        notes.forEach((n) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(n.f, now + offset);
          gain.gain.setValueAtTime(0.3, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.001, now + offset + n.d);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + offset);
          osc.stop(now + offset + n.d);
          offset += n.d * 0.85;
        });
      }
    } catch (e) {
      // AudioContext mungkin diblokir sebelum interaksi pertama pengguna
    }
  }

  // Pitch-Escalating Combo Sound (Nada naik bertingkat saat streak bertambah)
  playCombo(streak = 1) {
    if (this.muted) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;

      // Tangga nada combo yang makin tinggi & berkilau
      const scales = [
        [523.25, 659.25, 783.99, 1046.50], // C5
        [587.33, 739.99, 880.00, 1174.66], // D5
        [659.25, 830.61, 987.77, 1318.51], // E5
        [698.46, 880.00, 1046.50, 1396.91], // F5
        [783.99, 987.77, 1174.66, 1567.98, 2093.00] // G5 Super Combo
      ];

      const scaleIdx = Math.min(scales.length - 1, Math.max(0, (streak || 1) - 1));
      const freqs = scales[scaleIdx];
      const noteDuration = streak >= 5 ? 0.055 : 0.07;

      freqs.forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = streak >= 3 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(f, now + i * noteDuration);
        
        gain.gain.setValueAtTime(0.28, now + i * noteDuration);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * noteDuration + 0.12);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + i * noteDuration);
        osc.stop(now + (i + 1) * noteDuration + 0.12);
      });
    } catch (e) {}
  }

  // Efek Suara Power-Up Arcade
  playPowerup(type) {
    if (this.muted) return;
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;

      if (type === 'fifty_fifty') {
        // Laser cut snipping sound
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(900, now);
        osc.frequency.exponentialRampToValueAtTime(240, now + 0.18);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.18);
      } else if (type === 'double_points') {
        // Retro 8-bit coin multiplier sound
        [587.33, 880, 1174.66, 1760].forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, now + i * 0.05);
          gain.gain.setValueAtTime(0.25, now + i * 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * 0.05 + 0.1);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + i * 0.05);
          osc.stop(now + (i + 1) * 0.05 + 0.1);
        });
      } else if (type === 'freeze_time') {
        // Ice crystal shimmer
        [1046.50, 1318.51, 1567.98, 2093.00].forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(f, now + i * 0.04);
          gain.gain.setValueAtTime(0.2, now + i * 0.04);
          gain.gain.exponentialRampToValueAtTime(0.001, now + (i + 1) * 0.04 + 0.25);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now + i * 0.04);
          osc.stop(now + (i + 1) * 0.04 + 0.25);
        });
      } else if (type === 'streak_shield') {
        // Metallic magic shield chime
        const freqs = [440, 880, 1320];
        freqs.forEach((f, i) => {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(f, now);
          gain.gain.setValueAtTime(0.25 / (i + 1), now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
          osc.connect(gain);
          gain.connect(this.ctx.destination);
          osc.start(now);
          osc.stop(now + 0.4);
        });
      }
    } catch (e) {}
  }
}

window.QuizSound = new QuizSoundEngine();
