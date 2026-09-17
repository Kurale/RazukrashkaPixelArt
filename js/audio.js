/* ============================================================================
 * audio.js — звуковые эффекты на Web Audio API (без внешних файлов).
 *
 * Все звуки синтезируются на лету: выбор цвета, закрашивание клеток
 * (тона повышаются, если красить подряд — «лесенка»), ошибка,
 * завершение цвета и победная мелодия. Звук можно отключить кнопкой 🔊.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SoundKit = {
    enabled: true,
    ctx: null,
    broken: false, // звук недоступен в этом браузере — молча работаем без него

    /** Ленивая инициализация контекста — браузеры требуют жеста пользователя. */
    _ensure() {
      if (!this.enabled || this.broken) return false;
      try {
        if (!this.ctx || this.ctx.state === 'closed') {
          const AC = global.AudioContext || global.webkitAudioContext;
          if (!AC) {
            this.broken = true;
            return false;
          }
          this.ctx = new AC();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return true;
      } catch {
        // Аудиоустройство может отсутствовать (встраиваемые браузеры, VM):
        // ошибка звука никогда не должна ломать логику приложения.
        this.broken = true;
        return false;
      }
    },

    /**
     * Базовый тон. Любая ошибка подавляется — раскрашивание важнее звука.
     * @param {number} freq частота, Гц
     * @param {number} dur длительность, с
     * @param {object} opts {type, gain, delay, slideTo}
     */
    tone(freq, dur, opts = {}) {
      if (!this._ensure()) return;
      try {
        const { type = 'sine', gain = 0.12, delay = 0, slideTo = 0 } = opts;
        const ctx = this.ctx;
        const t0 = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        amp.gain.setValueAtTime(0, t0);
        amp.gain.linearRampToValueAtTime(gain, t0 + 0.012);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(amp).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
      } catch {
        this.broken = true;
      }
    },

    /** Выбор цвета в панели — дружелюбный «поп». */
    select() {
      this.tone(523, 0.09, { type: 'triangle', gain: 0.15 });
      this.tone(784, 0.12, { type: 'triangle', gain: 0.12, delay: 0.07 });
    },

    /**
     * Закрашивание клетки. При непрерывном рисовании тон ползёт вверх
     * (step — сколько клеток закрашено в текущем жесте подряд).
     */
    paint(step = 0) {
      const clamped = Math.min(step, 14);
      const freq = 440 * Math.pow(2, clamped / 12); // хроматическая лесенка
      this.tone(freq, 0.07, { type: 'square', gain: 0.05 });
    },

    /** Попытка закрасить клетку не тем цветом — мягкое «нельзя». */
    deny() {
      this.tone(196, 0.12, { type: 'sawtooth', gain: 0.06 });
    },

    /** Все клетки одного цвета закрашены — короткое «ура». */
    colorDone() {
      [523, 659, 784].forEach((f, i) =>
        this.tone(f, 0.14, { type: 'triangle', gain: 0.13, delay: i * 0.09 })
      );
    },

    /** Картинка закрашена целиком — фанфары. */
    allDone() {
      const notes = [523, 659, 784, 1047, 784, 1047, 1319];
      notes.forEach((f, i) =>
        this.tone(f, i === notes.length - 1 ? 0.5 : 0.16, {
          type: 'triangle',
          gain: 0.14,
          delay: i * 0.13,
        })
      );
    },

    /** Клик по кнопкам интерфейса. */
    click() {
      this.tone(660, 0.05, { type: 'sine', gain: 0.08 });
    },
  };

  global.SoundKit = SoundKit;
})(window);
