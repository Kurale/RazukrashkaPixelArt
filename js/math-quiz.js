/* ============================================================================
 * math-quiz.js — генерация примеров из таблицы умножения и деления.
 *
 * Каждому цвету картинки назначается СВОЙ пример с УНИКАЛЬНЫМ ответом:
 * только так по числу на клетке можно однозначно понять, каким цветом
 * её закрашивать. Ответы берутся из таблицы умножения 2…9
 * (произведения от 4 до 81 — всего 31 различный ответ).
 * ==========================================================================*/
(function (global) {
  'use strict';

  /** Пул: ответ → список подходящих примеров (умножение и деление вперемешку). */
  function buildPool() {
    const byAnswer = new Map();
    const add = (answer, expr) => {
      if (!byAnswer.has(answer)) byAnswer.set(answer, []);
      byAnswer.get(answer).push({ expr, answer });
    };
    for (let a = 2; a <= 9; a++) {
      for (let b = 2; b <= 9; b++) {
        add(a * b, `${a} × ${b}`); // умножение: 4 × 8 = 32 → ответ 32
        add(a, `${a * b} ÷ ${b}`); // деление: 56 ÷ 7 = 8 → ответ 8 (частное!)
      }
    }
    return byAnswer;
  }

  const POOL = buildPool();
  // Обратный индекс: текст примера → его ответ (для проверки сохранённых).
  const EXPR_TO_ANSWER = new Map();
  for (const list of POOL.values()) {
    for (const item of list) EXPR_TO_ANSWER.set(item.expr, item.answer);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Назначает примеры списку цветов.
   * @param {string[]} hexes — цвета, которым нужны примеры (в порядке появления)
   * @param {Object|null} savedMapping — сохранённое соответствие {hex: "4 × 8"}
   *   (чтобы примеры не менялись между сессиями)
   * @returns {Object} { hex: {expr, answer} }
   */
  function assign(hexes, savedMapping) {
    const result = {};
    const usedAnswers = new Set();

    // 1. Переиспользуем сохранённые примеры, если ответы не конфликтуют.
    if (savedMapping) {
      for (const hex of hexes) {
        const expr = savedMapping[hex];
        const answer = expr && EXPR_TO_ANSWER.get(expr);
        if (answer !== undefined && !usedAnswers.has(answer)) {
          result[hex] = { expr, answer };
          usedAnswers.add(answer);
        }
      }
    }

    // 2. Остальным цветам раздаём случайные примеры с уникальными ответами.
    const freeAnswers = shuffle([...POOL.keys()].filter((a) => !usedAnswers.has(a)));
    for (const hex of hexes) {
      if (result[hex]) continue;
      const answer = freeAnswers.pop();
      if (answer === undefined) {
        // Экзотический случай: цветов больше, чем различных ответов (31).
        // Дублируем ответ — это крайний случай для очень пёстрых SVG.
        const any = [...POOL.keys()][Math.floor(Math.random() * POOL.size)];
        const variants = POOL.get(any);
        result[hex] = { ...variants[Math.floor(Math.random() * variants.length)] };
        continue;
      }
      const variants = POOL.get(answer);
      result[hex] = { ...variants[Math.floor(Math.random() * variants.length)] };
    }
    return result;
  }

  global.MathQuiz = { assign };
})(window);
