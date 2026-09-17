/* ============================================================================
 * app.js — основная логика приложения «Раскраска по пикселям».
 *
 * Разделы:
 *   1. Константы, ссылки на DOM и состояние
 *   2. Хранилище (localStorage: настройки + прогресс)
 *   3. Реестр картинок и их загрузка (embedded / fetch из assets)
 *   4. Подготовка картинки: парсинг SVG, примеры, восстановление прогресса
 *   5. Раскладка канваса и слоёв отрисовки (база, числа, заливки)
 *   6. Рендер: сетка, числа, активная подсветка, анимации закраски
 *   7. Ввод: клик и протягивание (мышь/палец) по канвасу
 *   8. Панель цветов, прогресс, подсказки, тосты
 *   9. Печать (пустая раскраска и готовый вариант)
 *  10. Сброс, тема, звук, победный экран
 *  11. Инициализация
 *
 * Отладка: window.PixelApp содержит публичное API (используется в тестах).
 * ==========================================================================*/
(function () {
  'use strict';

  /* ==========================================================================
   * 1. Константы, ссылки на DOM и состояние
   * ========================================================================*/

  const SETTINGS_KEY = 'pixel-coloring:settings:v1';
  const PROGRESS_KEY_PREFIX = 'pixel-coloring:progress:v1:';

  // Параметры анимации закрашивания клетки.
  const PAINT_ANIM_MS = 200;
  const DENY_ANIM_MS = 320;

  const els = {
    board: document.getElementById('board'),
    paper: document.getElementById('paper'),
    canvasArea: document.getElementById('canvasArea'),
    pictureSelect: document.getElementById('pictureSelect'),
    palette: document.getElementById('paletteButtons'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    progressColors: document.getElementById('progressColors'),
    btnPrintBlank: document.getElementById('btnPrintBlank'),
    btnPrintFull: document.getElementById('btnPrintFull'),
    btnReset: document.getElementById('btnReset'),
    btnSound: document.getElementById('btnSound'),
    btnTheme: document.getElementById('btnTheme'),
    toast: document.getElementById('toast'),
    winOverlay: document.getElementById('winOverlay'),
    winText: document.getElementById('winText'),
    winPrint: document.getElementById('winPrint'),
    winChange: document.getElementById('winChange'),
    winClose: document.getElementById('winClose'),
    confetti: document.getElementById('confetti'),
    resetModal: document.getElementById('resetModal'),
    resetConfirm: document.getElementById('resetConfirm'),
    resetCancel: document.getElementById('resetCancel'),
    printFrame: document.getElementById('printFrame'),
  };

  const state = {
    /** Реестр картинок: [{file, title, svg|null}] */
    registry: [],
    /** Текущая картинка (см. loadPicture). */
    pic: null,
    /** Индекс активного цвета в pic.colors, -1 — ничего не выбрано. */
    activeIdx: -1,
    /** Идёт ли рисование протягиванием. */
    dragging: false,
    /** Последняя клетка жеста (для непрерывной линии при быстром движении). */
    lastCell: null,
    /** Сколько клеток закрашено в текущем жесте (для «лесенки» звука). */
    combo: 0,
    /** Настройки из localStorage. */
    settings: { sound: true, theme: 'light', lastFile: null },
  };

  /* ==========================================================================
   * 2. Хранилище: настройки и прогресс (с защитой от исключений)
   * ========================================================================*/

  const Store = {
    load(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
      } catch {
        return { ...fallback };
      }
    },
    save(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* приватный режим — просто работаем без сохранения */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };

  const progressKey = (file) => PROGRESS_KEY_PREFIX + file;

  /* ==========================================================================
   * 3. Реестр картинок и их загрузка
   * ========================================================================*/

  /**
   * Собирает реестр: за основу берутся встроенные копии (js/embedded-art.js),
   * а если страница открыта с сервера — подтягивается свежий assets/manifest.json,
   * чтобы увидеть картинки, добавленные в папку без перегенерации.
   */
  async function buildRegistry() {
    const embedded = (window.PIXEL_ART_DATA && window.PIXEL_ART_DATA.manifest) || [];
    const embeddedSvgs = (window.PIXEL_ART_DATA && window.PIXEL_ART_DATA.svgs) || {};
    const registry = embedded.map((item) => ({
      file: item.file,
      title: item.title,
      svg: embeddedSvgs[item.file] || null,
    }));

    if (location.protocol !== 'file:') {
      try {
        const resp = await fetch('assets/manifest.json', { cache: 'no-store' });
        if (resp.ok) {
          const manifest = await resp.json();
          const byFile = new Map(registry.map((r) => [r.file, r]));
          const merged = [];
          for (const item of manifest) {
            const known = byFile.get(item.file);
            if (known) {
              // Обновляем заголовок; текст SVG дозагрузим лениво при выборе.
              merged.push({ ...known, title: item.title || known.title });
              byFile.delete(item.file);
            } else {
              merged.push({ file: item.file, title: item.title || item.file, svg: null });
            }
          }
          registry.length = 0;
          registry.push(...merged, ...byFile.values());
        }
      } catch {
        /* нет манифеста или нет сети — остаёмся на встроенных копиях */
      }
    }
    state.registry = registry;
  }

  /** Возвращает текст SVG: встроенный или загруженный из assets (для новых картинок). */
  async function fetchSvgText(item) {
    if (item.svg) {
      if (location.protocol === 'file:') return item.svg; // file:// — только встроенная копия
      try {
        const resp = await fetch('assets/' + encodeURIComponent(item.file), { cache: 'no-store' });
        if (resp.ok) return await resp.text(); // свежая версия с сервера
      } catch {}
      return item.svg;
    }
    const resp = await fetch('assets/' + encodeURIComponent(item.file), { cache: 'no-store' });
    if (!resp.ok) throw new Error('Не удалось загрузить ' + item.file);
    return resp.text();
  }

  /* ==========================================================================
   * 4. Подготовка картинки
   * ========================================================================*/

  /** Тасовка Фишера—Йетса (на месте). */
  function shuffleArr(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Случайный порядок 0..n-1; при n ≥ 2 не допускаем исходного порядка. */
  function shuffledIndices(n) {
    const arr = Array.from({ length: n }, (_, i) => i);
    if (n < 2) return arr;
    const identity = arr.join(',');
    do {
      shuffleArr(arr);
    } while (arr.join(',') === identity);
    return arr;
  }

  /** Проверяет, что массив — перестановка чисел 0..n-1. */
  function isPermutation(arr, n) {
    if (!Array.isArray(arr) || arr.length !== n) return false;
    const seen = new Set();
    for (const v of arr) {
      if (!Number.isInteger(v) || v < 0 || v >= n || seen.has(v)) return false;
      seen.add(v);
    }
    return true;
  }

  /**
   * Загружает картинку: парсит SVG, назначает примеры цветам,
   * восстанавливает сохранённый прогресс и строит интерфейс.
   */
  async function loadPicture(file) {
    const item = state.registry.find((r) => r.file === file) || state.registry[0];
    if (!item) {
      showToast('Не найдено ни одной картинки 😔');
      return;
    }

    let svgText;
    try {
      svgText = await fetchSvgText(item);
    } catch (err) {
      showToast('Не удалось загрузить картинку: ' + item.title);
      console.error(err);
      return;
    }

    let model;
    try {
      model = SvgRasterizer.parse(svgText);
    } catch (err) {
      showToast('Не удалось разобрать ' + item.file + ': ' + err.message);
      console.error(err);
      return;
    }
    if (!model.colors.length) {
      showToast('В картинке нет раскрашиваемых цветов: ' + item.title);
      return;
    }

    // Сохранённый прогресс: закрашенные клетки + соответствие «цвет → пример».
    const saved = Store.load(progressKey(item.file), {});
    const savedMapping = typeof saved.mapping === 'object' && saved.mapping ? saved.mapping : null;
    const assignment = MathQuiz.assign(
      model.colors.map((c) => c.hex),
      savedMapping
    );

    const colors = model.colors.map((c) => ({
      hex: c.hex,
      total: c.count,
      expr: assignment[c.hex].expr,
      answer: assignment[c.hex].answer,
      paintedSet: new Set(),
      done: false,
    }));

    // Порядок кнопок в панели: цвета на картинке следуют сверху вниз, поэтому
    // «как есть» порядок выдавал бы подсказку. Тасуем; порядок сохраняем,
    // чтобы кнопки не менялись местами между сессиями.
    const savedOrder = Array.isArray(saved.order) ? saved.order : null;
    const buttonOrder =
      savedOrder && isPermutation(savedOrder, colors.length)
        ? savedOrder.slice()
        : shuffledIndices(colors.length);

    const pic = {
      file: item.file,
      title: item.title,
      model,
      colors,
      buttonOrder,
      paintedMask: new Uint8Array(model.cols * model.rows),
      totalPaintable: colors.reduce((s, c) => s + c.total, 0),
      paintedCount: 0,
      finished: false,
    };

    // Восстанавливаем закрашенные клетки (защита от изменившегося SVG).
    if (saved.painted && typeof saved.painted === 'object') {
      for (const color of colors) {
        const list = saved.painted[color.hex];
        if (!Array.isArray(list)) continue;
        for (const idx of list) {
          if (idx < 0 || idx >= pic.paintedMask.length) continue;
          const cellClass = model.cells[idx];
          if (cellClass < 2 || model.colors[cellClass - 2].hex !== color.hex) continue;
          if (pic.paintedMask[idx]) continue;
          pic.paintedMask[idx] = 1;
          color.paintedSet.add(idx);
        }
      }
      for (const color of colors) {
        if (color.paintedSet.size >= color.total) {
          color.done = true;
        }
      }
      pic.paintedCount = colors.reduce((s, c) => s + c.paintedSet.size, 0);
      pic.finished = pic.paintedCount >= pic.totalPaintable;
    }

    state.pic = pic;
    state.activeIdx = -1;

    // Мгновенно сохраняем актуальное соответствие примеров,
    // чтобы в следующей сессии числа на клетках не поменялись.
    persistProgress(true);

    buildPaletteUI();
    updateProgressUI();
    layout();
    render();

    state.settings.lastFile = item.file;
    Store.save(SETTINGS_KEY, state.settings);

    // Если всё было закрашено ранее — не показываем победный экран при загрузке.
    hideOverlay();
  }

  /* ==========================================================================
   * 5. Раскладка канваса и слоёв
   * ========================================================================*/

  // Слои рисуются в CSS-пикселях на канвасах с учётом devicePixelRatio.
  let layers = null; // {base, numbers, dpr, cssW, cssH, cell}

  /** Слой-канвас того же размера, что и основной. */
  function makeLayer(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /** Подбирает размер канваса под доступную область, сохраняя пропорции сетки. */
  function layout() {
    const pic = state.pic;
    if (!pic) return;
    const area = els.canvasArea.getBoundingClientRect();
    const availW = Math.max(80, area.width - 56); // поля + тень «листа»
    const availH = Math.max(80, area.height - 56);

    const { cols, rows } = pic.model;
    // Клетка не крупнее 46 CSS-px — маленькие картинки не растягиваем чрезмерно.
    const cell = Math.min(46, availW / cols, availH / rows);
    const cssW = Math.round(cell * cols);
    const cssH = Math.round(cell * rows);

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    els.board.style.width = cssW + 'px';
    els.board.style.height = cssH + 'px';
    els.board.width = Math.round(cssW * dpr);
    els.board.height = Math.round(cssH * dpr);

    layers = {
      base: makeLayer(els.board.width, els.board.height),
      numbers: makeLayer(els.board.width, els.board.height),
      dpr,
      cssW,
      cssH,
      cell: cssW / cols,
    };

    buildBaseLayer();
    buildNumbersLayer();
    setDirty();
  }

  /** Слой «база»: белый фон, чёрные клетки контура, светлая сетка. */
  function buildBaseLayer() {
    const { base } = layers;
    const ctx = base.getContext('2d');
    const { cssW, cssH, cell, dpr } = layers;
    const { cols, rows, cells } = state.pic.model;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    // Чёрные клетки.
    ctx.fillStyle = '#101216';
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (cells[y * cols + x] === 1) {
          ctx.fillRect(x * cell, y * cell, cell + 0.75, cell + 0.75);
        }
      }
    }

    // Сетка поверх — на чёрных клетках её не видно, это нормально.
    ctx.strokeStyle = getGridColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      const px = Math.round(x * cell) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
    }
    for (let y = 0; y <= rows; y++) {
      const py = Math.round(y * cell) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(cssW, py);
    }
    ctx.stroke();
  }

  function getGridColor() {
    return document.documentElement.dataset.theme === 'dark' ? '#c3cbd8' : '#c9d2de';
  }

  /** Слой «числа»: ответы примеров на всех ещё не закрашенных клетках. */
  function buildNumbersLayer() {
    const { numbers } = layers;
    const ctx = numbers.getContext('2d');
    const { cell, dpr } = layers;
    const { cols, rows, cells } = state.pic.model;
    const { colors } = state.pic;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, layers.cssW, layers.cssH);

    const fontSize = Math.max(7.5, cell * 0.42);
    ctx.font = `700 ${fontSize}px 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#3d4757';

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        const cls = cells[idx];
        if (cls < 2) continue; // фон или контур
        const color = colors[cls - 2];
        if (state.pic.paintedMask[idx]) continue; // закрашенные пропускаем
        ctx.fillText(String(color.answer), x * cell + cell / 2, y * cell + cell / 2 + 0.5);
      }
    }
  }

  /* ==========================================================================
   * 6. Рендер
   * ========================================================================*/

  let dirty = true;
  let anims = []; // закрашивания: {idx, colorHex, start}
  let denyAnims = []; // «не тот цвет»: {idx, start}
  let rafId = 0;
  let lastDenySound = 0;

  function setDirty() {
    dirty = true;
    if (!rafId) rafId = requestAnimationFrame(renderLoop);
  }

  function renderLoop(now) {
    rafId = 0;
    if (!state.pic || !layers) return;
    const hasAnims = anims.length || denyAnims.length;
    if (!dirty && !hasAnims) return;
    dirty = false;
    render(now || performance.now());
    if (anims.length || denyAnims.length) {
      rafId = requestAnimationFrame(renderLoop);
    }
  }

  function render(now) {
    const ctx = els.board.getContext('2d');
    const { cell, dpr, cssW, cssH, base, numbers } = layers;
    const { cols, rows, cells } = state.pic.model;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(base, 0, 0, cssW, cssH);

    // Числа (на закрашенных клетках они уже стёрты из слоя).
    // Никаких подсветок-подсказок: ребёнок сам решает пример и ищет ответ.
    ctx.drawImage(numbers, 0, 0, cssW, cssH);

    // Закрашенные клетки: статичные — сразу, анимируемые — с эффектом.
    const finished = new Set();
    for (let a = 0; a < anims.length; a++) {
      const anim = anims[a];
      const t = (now - anim.start) / PAINT_ANIM_MS;
      if (t >= 1) {
        finished.add(a);
        continue;
      }
      drawGrowingFill(ctx, anim, easeOutCubic(t), cell, cols);
    }
    if (finished.size) anims = anims.filter((_, i) => !finished.has(i));

    // Обычные закрашенные клетки (без активной анимации).
    for (let i = 0; i < state.pic.paintedMask.length; i++) {
      if (!state.pic.paintedMask[i]) continue;
      if (anims.some((an) => an.idx === i)) continue;
      const cls = cells[i];
      const color = state.pic.colors[cls - 2];
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      ctx.fillStyle = color.hex;
      ctx.fillRect(x, y, cell + 0.75, cell + 0.75);
    }

    // Красные «нельзя» — клетки не того цвета.
    const doneDeny = new Set();
    for (let a = 0; a < denyAnims.length; a++) {
      const anim = denyAnims[a];
      const t = (now - anim.start) / DENY_ANIM_MS;
      if (t >= 1) {
        doneDeny.add(a);
        continue;
      }
      const i = anim.idx;
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      ctx.strokeStyle = `rgba(229, 72, 77, ${0.9 * (1 - t)})`;
      ctx.lineWidth = Math.max(2, cell * 0.12);
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
    }
    if (doneDeny.size) denyAnims = denyAnims.filter((_, i) => !doneDeny.has(i));
  }

  /** Плавное «вырастание» заливки из центра клетки. */
  function drawGrowingFill(ctx, anim, t, cell, cols) {
    const i = anim.idx;
    const cx = (i % cols) * cell + cell / 2;
    const cy = Math.floor(i / cols) * cell + cell / 2;
    const size = cell * (0.35 + 0.65 * t);
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.6);
    ctx.beginPath();
    ctx.rect(cx - cell / 2, cy - cell / 2, cell, cell); // клип по клетке
    ctx.clip();
    ctx.fillStyle = anim.colorHex;
    // Лёгкий перехлёст в середине анимации — заполнение выглядит «живым».
    const s = size * (1 + 0.12 * Math.sin(Math.min(1, t) * Math.PI));
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
    ctx.restore();
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* ==========================================================================
   * 7. Ввод: мышь и палец
   * ========================================================================*/

  /** Координаты события → клетка сетки или null. */
  function eventToCell(e) {
    const rect = els.board.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    const { cols, rows } = state.pic.model;
    const col = Math.floor((x / rect.width) * cols);
    const row = Math.floor((y / rect.height) * rows);
    return { col: Math.min(cols - 1, col), row: Math.min(rows - 1, row) };
  }

  function cellIndex(cell) {
    return cell.row * state.pic.model.cols + cell.col;
  }

  function bindCanvasEvents() {
    els.board.addEventListener('pointerdown', (e) => {
      if (!state.pic) return;
      e.preventDefault();
      els.board.setPointerCapture(e.pointerId);
      state.dragging = true;
      state.lastCell = null;
      state.combo = 0;
      const cell = eventToCell(e);
      if (cell) {
        tryPaintCell(cellIndex(cell));
        state.lastCell = cell;
      }
    });

    els.board.addEventListener('pointermove', (e) => {
      if (!state.dragging || !state.pic) return;
      const cell = eventToCell(e);
      if (!cell) return;
      // Интерполяция линии между клетками — чтобы при быстром движении не было дыр.
      if (state.lastCell) {
        for (const point of bresenhamCells(state.lastCell, cell)) {
          tryPaintCell(cellIndex(point));
        }
      } else {
        tryPaintCell(cellIndex(cell));
      }
      state.lastCell = cell;
    });

    const stop = () => {
      state.dragging = false;
      state.lastCell = null;
    };
    els.board.addEventListener('pointerup', stop);
    els.board.addEventListener('pointercancel', stop);
    els.board.addEventListener('pointerleave', () => {
      if (state.dragging) state.lastCell = null;
    });
  }

  /** Путь между двумя клетками по сетке (алгоритм Брезенхэма). */
  function bresenhamCells(a, b) {
    const points = [];
    let x0 = a.col;
    let y0 = a.row;
    const x1 = b.col;
    const y1 = b.row;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      points.push({ col: x0, row: y0 });
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return points;
  }

  /** Пытается закрасить клетку; проверяет цвет, играет звуки, ведёт прогресс. */
  function tryPaintCell(idx) {
    const pic = state.pic;
    if (!pic || pic.finished) return;

    if (state.activeIdx < 0) {
      showToast('Сначала выбери пример справа 👉');
      return;
    }
    const cls = pic.model.cells[idx];
    if (cls < 2) return; // фон или контур — не трогаем

    const cellColorIdx = cls - 2;
    const active = pic.colors[state.activeIdx];

    if (cellColorIdx !== state.activeIdx) {
      // Не тот цвет: мягкая красная рамка и приглушённый звук (не чаще 250 мс).
      if (!denyAnims.some((a) => a.idx === idx)) {
        denyAnims.push({ idx, start: performance.now() });
        setDirty();
      }
      const now = performance.now();
      if (now - lastDenySound > 250) {
        lastDenySound = now;
        SoundKit.deny();
      }
      return;
    }
    if (pic.paintedMask[idx]) return; // уже закрашена

    // Закрашиваем.
    pic.paintedMask[idx] = 1;
    active.paintedSet.add(idx);
    pic.paintedCount++;
    state.combo++;

    // Число на клетке скрывается.
    const { cell, dpr } = layers;
    const { cols } = pic.model;
    const nctx = layers.numbers.getContext('2d');
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    nctx.clearRect((idx % cols) * cell, Math.floor(idx / cols) * cell, cell, cell);

    anims.push({ idx, colorHex: active.hex, start: performance.now() });
    setDirty();
    SoundKit.paint(state.combo);

    updateProgressUI();
    persistProgress();

    // Цвет завершён?
    if (active.paintedSet.size >= active.total && !active.done) {
      active.done = true;
      onColorDone(state.activeIdx);
    }
    // Картинка завершена?
    if (pic.paintedCount >= pic.totalPaintable && !pic.finished) {
      pic.finished = true;
      persistProgress(true);
      setTimeout(showWinOverlay, 450);
    }
  }

  /* ==========================================================================
   * 8. Панель цветов, прогресс, подсказки, тосты
   * ========================================================================*/

  /** Текст на кнопке: чёрный на светлых фонах, белый на тёмных. */
  function bestForeground(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1c2430' : '#ffffff';
  }

  function buildPaletteUI() {
    const pic = state.pic;
    els.palette.innerHTML = '';
    // Кнопки идут в перетасованном порядке: исходный порядок цветов
    // (сверху вниз по картинке) выдавал бы подсказку, где какой цвет.
    for (const i of pic.buttonOrder) {
      const color = pic.colors[i];
      const btn = document.createElement('button');
      btn.className = 'color-btn';
      btn.type = 'button';
      btn.setAttribute('role', 'option');
      btn.style.setProperty('--btn-bg', color.hex);
      btn.style.setProperty('--btn-fg', bestForeground(color.hex));
      btn.innerHTML =
        `<span class="color-btn__expr">${color.expr}</span>` +
        `<span class="color-btn__meta">` +
        `<span class="color-btn__count">${color.paintedSet.size}/${color.total}</span>` +
        `<span class="color-btn__check">✅</span>` +
        `</span>`;
      btn.addEventListener('click', () => selectColor(i));
      color.el = btn;
      els.palette.appendChild(btn);
    }
    syncPaletteUI();
  }

  function selectColor(idx) {
    const color = state.pic.colors[idx];
    if (color.done) {
      // Завершённый цвет можно выбрать для просмотра, но рисовать нечего.
      showToast('Этот цвет уже весь закрашен! ✅');
      return;
    }
    state.activeIdx = idx;
    SoundKit.select();
    syncPaletteUI();
  }

  /** Синхронизирует панель с состоянием (счётчики, галочки, активность). */
  function syncPaletteUI() {
    state.pic.colors.forEach((color, i) => {
      const btn = color.el;
      btn.classList.toggle('active', i === state.activeIdx);
      btn.classList.toggle('done', color.done);
      btn.querySelector('.color-btn__count').textContent = `${color.paintedSet.size}/${color.total}`;
      btn.setAttribute('aria-selected', i === state.activeIdx ? 'true' : 'false');
    });
  }

  function updateProgressUI() {
    const pic = state.pic;
    if (!pic) return;
    const percent = pic.totalPaintable
      ? Math.round((pic.paintedCount / pic.totalPaintable) * 100)
      : 0;
    els.progressFill.style.width = percent + '%';
    els.progressText.textContent = percent + '%';
    const doneColors = pic.colors.filter((c) => c.done).length;
    els.progressColors.textContent = `цвета ${doneColors} из ${pic.colors.length} · клеток ${pic.paintedCount}/${pic.totalPaintable}`;
    document.querySelector('.progress__bar')?.setAttribute('aria-valuenow', String(percent));
    syncPaletteUI();
  }

  function onColorDone(idx) {
    const pic = state.pic;
    SoundKit.colorDone();
    const color = pic.colors[idx];
    showToast(`Отлично! Пример ${color.expr} = ${color.answer} — цвет закрыт! ✅`);
    updateProgressUI();
    persistProgress(true);
    // Автоматически выбираем следующий незакрытый цвет — следующий по порядку кнопок.
    if (state.activeIdx === idx) {
      const order = pic.buttonOrder;
      const pos = order.indexOf(idx);
      let next = -1;
      for (let k = 1; k <= order.length; k++) {
        const cand = order[(pos + k) % order.length];
        if (!pic.colors[cand].done) {
          next = cand;
          break;
        }
      }
      if (next >= 0) {
        state.activeIdx = next;
        setTimeout(syncPaletteUI, 500);
      } else {
        state.activeIdx = -1;
        syncPaletteUI();
      }
    }
  }

  /* Тосты (небольшие всплывающие сообщения) */
  let toastTimer = 0;
  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.style.animation = 'none';
    void els.toast.offsetWidth; // перезапуск анимации
    els.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
  }

  /* ==========================================================================
   * 9. Печать
   * ========================================================================*/

  /** Рисует картинку на отдельном канвасе для печати. mode: 'blank' | 'full'. */
  function renderPrintCanvas(mode) {
    const pic = state.pic;
    const { cols, rows, cells } = pic.model;
    const px = Math.max(18, Math.min(48, Math.floor(1800 / Math.max(cols, rows))));
    const canvas = document.createElement('canvas');
    canvas.width = cols * px;
    canvas.height = rows * px;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cls = cells[y * cols + x];
        if (cls === 1) {
          ctx.fillStyle = '#101216';
          ctx.fillRect(x * px, y * px, px + 0.5, px + 0.5);
        } else if (cls >= 2 && mode === 'full') {
          ctx.fillStyle = pic.colors[cls - 2].hex;
          ctx.fillRect(x * px, y * px, px + 0.5, px + 0.5);
        }
      }
    }

    if (mode === 'blank') {
      // Сетка и числа — только для чистовой распечатки-раскраски.
      ctx.strokeStyle = '#9aa4b2';
      ctx.lineWidth = Math.max(1, px / 24);
      ctx.beginPath();
      for (let x = 0; x <= cols; x++) {
        ctx.moveTo(x * px + 0.5, 0);
        ctx.lineTo(x * px + 0.5, rows * px);
      }
      for (let y = 0; y <= rows; y++) {
        ctx.moveTo(0, y * px + 0.5);
        ctx.lineTo(cols * px, y * px + 0.5);
      }
      ctx.stroke();

      ctx.font = `700 ${Math.floor(px * 0.46)}px 'Segoe UI', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#2b3340';
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cls = cells[y * cols + x];
          if (cls >= 2) {
            ctx.fillText(String(pic.colors[cls - 2].answer), x * px + px / 2, y * px + px / 2 + 1);
          }
        }
      }
    }
    return canvas;
  }

  /** Готовит HTML документа для печати. */
  function buildPrintDoc(mode) {
    const pic = state.pic;
    const img = renderPrintCanvas(mode).toDataURL('image/png');
    const landscape = pic.model.cols > pic.model.rows * 1.2;

    // Цветные кнопки с примерами — как в приложении, в том же перетасованном
    // порядке. В чистой раскраске БЕЗ ответов (никаких подсказок — ребёнок
    // решает сам), в готовом варианте ответ добавляем для самопроверки.
    const legend = pic.buttonOrder
      .map((i) => pic.colors[i])
      .map((c) => {
        const fg = bestForeground(c.hex);
        const label = mode === 'blank' ? c.expr : `${c.expr} = ${c.answer}`;
        return `<span class="pbtn" style="background:${c.hex};color:${fg}">${label}</span>`;
      })
      .join('\n');

    const subtitle =
      mode === 'blank'
        ? 'Реши пример, найди клетки с ответом и раскрась их этим цветом'
        : 'Готовый вариант — проверь себя!';

    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Раскраска «${pic.title}»</title>
<style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 12mm; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #222; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  .sub { color: #555; font-size: 11pt; margin: 0 0 10pt; }
  img { width: 100%; max-height: 66vh; object-fit: contain; }
  .legend { display: flex; flex-wrap: wrap; gap: 8pt; margin-top: 12pt; }
  .pbtn {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 100pt; height: 34pt; padding: 0 18pt;
    border-radius: 9pt; border: 1.2pt solid rgba(0, 0, 0, 0.4);
    font-size: 17pt; font-weight: 700; letter-spacing: 0.5pt;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  footer { margin-top: 10pt; color: #888; font-size: 9pt; }
</style></head><body>
<h1>Раскраска «${pic.title}»${mode === 'full' ? ' — готовая' : ''}</h1>
<p class="sub">${subtitle}</p>
<img src="${img}" />
<div class="legend">${legend}</div>
<footer>Пиксельная раскраска с таблицей умножения</footer>
</body></html>`;
  }

  /** Печатает через скрытый iframe — без всплывающих окон. */
  function printPicture(mode) {
    if (!state.pic) return;
    SoundKit.click();
    const html = buildPrintDoc(mode);
    const frame = els.printFrame;
    frame.onload = () => {
      // Даём картинкам (data:) отрисоваться перед печатью.
      setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch (err) {
          console.error('Печать недоступна:', err);
          showToast('Печать заблокирована браузером 😕');
        }
      }, 60);
    };
    frame.srcdoc = html;
  }

  /* ==========================================================================
   * 10. Прогресс, сброс, победа, тема и звук
   * ========================================================================*/

  let saveTimer = 0;
  /** Сохраняет прогресс (с небольшим окольцеванием для производительности). */
  function persistProgress(immediate) {
    const pic = state.pic;
    if (!pic) return;
    const run = () => {
      const painted = {};
      const mapping = {};
      for (const color of pic.colors) {
        painted[color.hex] = [...color.paintedSet];
        mapping[color.hex] = color.expr;
      }
      // order — перетасованный порядок кнопок, чтобы не менялся между сессиями.
      Store.save(progressKey(pic.file), { painted, mapping, order: pic.buttonOrder });
    };
    clearTimeout(saveTimer);
    if (immediate) run();
    else saveTimer = setTimeout(run, 400);
  }

  function resetPicture() {
    const pic = state.pic;
    if (!pic) return;
    for (const color of pic.colors) {
      color.paintedSet.clear();
      color.done = false;
    }
    pic.paintedMask.fill(0);
    pic.paintedCount = 0;
    pic.finished = false;
    state.activeIdx = -1;
    state.combo = 0;
    anims = [];
    denyAnims = [];
    // Файл прогресса не удаляем, а перезаписываем пустым: так сохранятся
    // примеры и порядок кнопок — числа на клетках не поменяются после сброса.
    persistProgress(true);
    buildNumbersLayer();
    updateProgressUI();
    setDirty();
    showToast('Раскраска снова чистая! 🧼');
  }

  /* Победный экран с конфетти */
  function showWinOverlay() {
    const pic = state.pic;
    SoundKit.allDone();
    els.winText.textContent = `«${pic.title}» закрашена целиком: ${pic.colors.length} цветов и ${pic.totalPaintable} клеток!`;
    els.winOverlay.hidden = false;
    spawnConfetti();
  }

  function hideOverlay() {
    els.winOverlay.hidden = true;
    els.confetti.innerHTML = '';
  }

  function spawnConfetti() {
    const colors = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#f06292'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 70; i++) {
      const piece = document.createElement('i');
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = 2 + Math.random() * 1.6 + 's';
      piece.style.animationDelay = Math.random() * 0.8 + 's';
      piece.style.width = 8 + Math.random() * 8 + 'px';
      piece.style.height = 12 + Math.random() * 10 + 'px';
      frag.appendChild(piece);
    }
    els.confetti.innerHTML = '';
    els.confetti.appendChild(frag);
  }

  /* Тема */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    els.btnTheme.textContent = theme === 'dark' ? '☀️' : '🌙';
    state.settings.theme = theme;
    Store.save(SETTINGS_KEY, state.settings);
    if (state.pic) {
      buildBaseLayer(); // цвет сетки зависит от темы
      setDirty();
    }
  }

  /* Звук */
  function applySound(enabled) {
    SoundKit.enabled = enabled;
    els.btnSound.textContent = enabled ? '🔊' : '🔇';
    els.btnSound.setAttribute('aria-pressed', String(enabled));
    state.settings.sound = enabled;
    Store.save(SETTINGS_KEY, state.settings);
  }

  /* ==========================================================================
   * 11. Инициализация
   * ========================================================================*/

  function fillPictureSelect() {
    els.pictureSelect.innerHTML = '';
    for (const item of state.registry) {
      const opt = document.createElement('option');
      opt.value = item.file;
      opt.textContent = item.title;
      els.pictureSelect.appendChild(opt);
    }
  }

  function bindUI() {
    els.pictureSelect.addEventListener('change', () => {
      SoundKit.click();
      loadPicture(els.pictureSelect.value);
    });
    els.btnPrintBlank.addEventListener('click', () => printPicture('blank'));
    els.btnPrintFull.addEventListener('click', () => printPicture('full'));
    els.winPrint.addEventListener('click', () => printPicture('full'));

    els.btnReset.addEventListener('click', () => {
      SoundKit.click();
      if (state.pic && state.pic.paintedCount === 0) {
        showToast('Тут ещё нечего сбрасывать 😉');
        return;
      }
      els.resetModal.hidden = false;
    });
    els.resetCancel.addEventListener('click', () => (els.resetModal.hidden = true));
    els.resetConfirm.addEventListener('click', () => {
      els.resetModal.hidden = true;
      SoundKit.click();
      resetPicture();
    });

    els.btnSound.addEventListener('click', () => applySound(!SoundKit.enabled));
    els.btnTheme.addEventListener('click', () => {
      SoundKit.click();
      applyTheme(state.settings.theme === 'dark' ? 'light' : 'dark');
    });

    els.winClose.addEventListener('click', hideOverlay);
    els.winChange.addEventListener('click', () => {
      hideOverlay();
      // Переключаемся на следующую картинку в списке.
      const files = state.registry.map((r) => r.file);
      const next = files[(files.indexOf(state.pic.file) + 1) % files.length];
      els.pictureSelect.value = next;
      loadPicture(next);
    });

    // Esc закрывает диалоги.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        els.resetModal.hidden = true;
        hideOverlay();
      }
    });

    // Пересчёт раскладки при изменении размера окна/панели.
    let resizeTimer = 0;
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (state.pic) {
            layout();
          }
        }, 120);
      }).observe(els.canvasArea);
    } else {
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => state.pic && layout(), 120);
      });
    }

    bindCanvasEvents();
  }

  async function init() {
    state.settings = Store.load(SETTINGS_KEY, state.settings);
    applySound(state.settings.sound !== false);
    applyTheme(state.settings.theme === 'dark' ? 'dark' : 'light');

    await buildRegistry();
    fillPictureSelect();
    bindUI();

    const startFile =
      state.settings.lastFile && state.registry.some((r) => r.file === state.settings.lastFile)
        ? state.settings.lastFile
        : state.registry[0]?.file;
    if (startFile) {
      els.pictureSelect.value = startFile;
      await loadPicture(startFile);
    }
  }

  // Отладочное API (используется, в частности, в автотестах).
  window.PixelApp = {
    get state() {
      return state;
    },
    loadPicture,
    resetPicture,
    buildPrintDoc,
    renderPrintCanvas,
    selectColor,
    tryPaintCell,
    showToast,
    persistProgress: () => persistProgress(true),
  };

  init();
})();
