/* ============================================================================
 * svg-rasterizer.js — превращает пиксельный SVG в сетку логических пикселей.
 *
 * Зачем нужен свой растеризатор:
 *   • работает одинаково по http:// и file:// (не зависит от fetch/getImageData,
 *     которые блокируются для локальных файлов);
 *   • понимает разные способы рисования пиксель-арта: <rect>, простые контурные
 *     <path> (M/H/V/L/Z, кривые упрощаются), <circle>/<ellipse>/<polygon>,
 *     наложения фигур (порядок отрисовки учитывается), именованные цвета,
 *     fill="none", групповые transform.
 *
 * Результат разбора:
 *   { cols, rows, pixel, cells: Int16Array, colors: [{hex, count}] }
 *   где cells[i] — класс клетки: 0 = белый фон, 1 = чёрный контур,
 *   2 + k — цвет с индексом k из массива colors.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---------- Пороговые значения классификации цветов ---------- */

  // Почти белый (все каналы >= 246) считаем фоном, почти чёрный (все < 60) — контуром.
  const WHITE_THRESHOLD = 246;
  const BLACK_THRESHOLD = 60;

  /* ---------- Канвас-проба для нормализации любых CSS-цветов ---------- */

  const probeCtx = document.createElement('canvas').getContext('2d');

  /** Приводит любую запись цвета ('red', 'rgb(...)', '#abc'…) к '#rrggbb' или null. */
  function normalizeColor(str) {
    if (!str) return null;
    str = String(str).trim();
    if (!str || str === 'none' || str === 'transparent' || str.startsWith('url(')) return null;
    probeCtx.fillStyle = '#000';
    probeCtx.fillStyle = str;
    const value = probeCtx.fillStyle;
    if (value.startsWith('#')) {
      if (value.length === 4) {
        // #abc → #aabbcc
        return '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
      }
      return value.toLowerCase();
    }
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map(Number);
      if (parts.length >= 4 && parts[3] < 0.08) return null; // почти прозрачный
      return (
        '#' +
        parts
          .slice(0, 3)
          .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
          .join('')
      );
    }
    return null;
  }

  /** hex → {r, g, b}. */
  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }

  /* ---------- Матрицы аффинных преобразований ---------- */

  const IDENTITY = [1, 0, 0, 1, 0, 0];

  function mulMatrix(m, t) {
    return [
      m[0] * t[0] + m[2] * t[1],
      m[1] * t[0] + m[3] * t[1],
      m[0] * t[2] + m[2] * t[3],
      m[1] * t[2] + m[3] * t[3],
      m[0] * t[4] + m[2] * t[5] + m[4],
      m[1] * t[4] + m[3] * t[5] + m[5],
    ];
  }

  /** Разбирает атрибут transform (может содержать несколько операций). */
  function parseTransform(str) {
    let m = IDENTITY;
    if (!str) return m;
    const re = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]*)\)/g;
    let match;
    while ((match = re.exec(str))) {
      const a = match[2].trim().split(/[\s,]+/).map(Number);
      let t = IDENTITY;
      switch (match[1]) {
        case 'translate':
          t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
          break;
        case 'scale':
          t = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0];
          break;
        case 'rotate': {
          const rad = (a[0] * Math.PI) / 180;
          t = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
          if (a.length > 2) {
            // rotate(угол, cx, cy) = перенос → поворот → обратный перенос
            t = mulMatrix([1, 0, 0, 1, a[1], a[2]], mulMatrix(t, [1, 0, 0, 1, -a[1], -a[2]]));
          }
          break;
        }
        case 'matrix':
          t = [a[0], a[1], a[2], a[3], a[4], a[5]];
          break;
        case 'skewX':
          t = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0];
          break;
        case 'skewY':
          t = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0];
          break;
      }
      m = mulMatrix(m, t);
    }
    return m;
  }

  function applyMatrix(m, p) {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
  }

  /* ---------- Разбор path data (d="...") ---------- */

  const NUMBER_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/;
  const COMMAND_RE = /[MmLlHhVvCcSsQqTtAaZz]/;

  /**
   * Разбирает путь в список полигонов (в координатах, готовых к растеризации).
   * Кривые Безье и дуги упрощаются ломаными — для пиксель-арта этого достаточно.
   */
  function parsePathData(d, matrix) {
    const tokens = d.match(new RegExp(COMMAND_RE.source + '|' + NUMBER_RE.source, 'g'));
    if (!tokens) return [];

    const polys = [];
    let cur = null; // текущий полигон
    let curX = 0;
    let curY = 0;
    let startX = 0;
    let startY = 0;
    let lastCtrl = null; // последняя контрольная точка (для S/T)
    let cmd = null;

    const pushPoint = (x, y) => {
      cur.push({ x, y });
    };

    const startPoly = (x, y) => {
      if (cur && cur.length >= 3) polys.push(cur);
      cur = [{ x, y }];
    };

    // Кубическая кривая → ломаная из 12 сегментов.
    const cubicTo = (x1, y1, x2, y2, x, y) => {
      const STEPS = 12;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const mt = 1 - t;
        pushPoint(
          mt * mt * mt * curX + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
          mt * mt * mt * curY + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y
        );
      }
      curX = x;
      curY = y;
      lastCtrl = { x: x2, y: y2 };
    };

    // Квадратичная кривая → ломаная из 10 сегментов.
    const quadTo = (x1, y1, x, y) => {
      const STEPS = 10;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const mt = 1 - t;
        pushPoint(mt * mt * curX + 2 * mt * t * x1 + t * t * x, mt * mt * curY + 2 * mt * t * y1 + t * t * y);
      }
      curX = x;
      curY = y;
      lastCtrl = { x: x1, y: y1 };
    };

    let warnedArc = false;

    for (let i = 0; i < tokens.length; ) {
      const tok = tokens[i];
      if (COMMAND_RE.test(tok)) {
        cmd = tok;
        i++;
        // У Z нет параметров.
        if (cmd === 'Z' || cmd === 'z') {
          if (cur) {
            pushPoint(startX, startY);
            if (cur.length >= 3) polys.push(cur);
            cur = null;
          }
          curX = startX;
          curY = startY;
          lastCtrl = null;
        }
        continue;
      }
      // Токен — число: параметры текущей команды.
      const next = () => parseFloat(tokens[i++]);
      const rel = cmd === cmd.toLowerCase();
      switch (cmd.toUpperCase()) {
        case 'M': {
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          startX = x;
          startY = y;
          startPoly(x, y);
          curX = x;
          curY = y;
          lastCtrl = null;
          cmd = rel ? 'l' : 'L'; // последующие пары чисел = LineTo
          break;
        }
        case 'L': {
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          if (cur) pushPoint(x, y);
          curX = x;
          curY = y;
          lastCtrl = null;
          break;
        }
        case 'H': {
          const x = next() + (rel ? curX : 0);
          if (cur) pushPoint(x, curY);
          curX = x;
          break;
        }
        case 'V': {
          const y = next() + (rel ? curY : 0);
          if (cur) pushPoint(curX, y);
          curY = y;
          break;
        }
        case 'C': {
          const x1 = next() + (rel ? curX : 0);
          const y1 = next() + (rel ? curY : 0);
          const x2 = next() + (rel ? curX : 0);
          const y2 = next() + (rel ? curY : 0);
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          cubicTo(x1, y1, x2, y2, x, y);
          break;
        }
        case 'S': {
          const x2 = next() + (rel ? curX : 0);
          const y2 = next() + (rel ? curY : 0);
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          const refl = lastCtrl
            ? { x: 2 * curX - lastCtrl.x, y: 2 * curY - lastCtrl.y }
            : { x: curX, y: curY };
          cubicTo(refl.x, refl.y, x2, y2, x, y);
          break;
        }
        case 'Q': {
          const x1 = next() + (rel ? curX : 0);
          const y1 = next() + (rel ? curY : 0);
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          quadTo(x1, y1, x, y);
          break;
        }
        case 'T': {
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          const refl = lastCtrl
            ? { x: 2 * curX - lastCtrl.x, y: 2 * curY - lastCtrl.y }
            : { x: curX, y: curY };
          quadTo(refl.x, refl.y, x, y);
          break;
        }
        case 'A': {
          // Дуга эллипса: в пиксель-арте встречается редко — соединяем концы отрезком.
          next(); next(); next(); next(); next(); // rx ry rot largeArc sweep
          const x = next() + (rel ? curX : 0);
          const y = next() + (rel ? curY : 0);
          if (!warnedArc) {
            console.warn('SvgRasterizer: дуги (A) в path упрощаются отрезками');
            warnedArc = true;
          }
          if (cur) pushPoint(x, y);
          curX = x;
          curY = y;
          break;
        }
        default:
          i++; // неизвестная команда — пропускаем токен
      }
    }
    if (cur && cur.length >= 3) polys.push(cur);

    // Применяем трансформации и считаем bbox.
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) poly[i] = applyMatrix(matrix, poly[i]);
    }
    return polys;
  }

  /* ---------- Определение принадлежности точки полигону ---------- */

  /**
   * Луч с направлением +X, учитывается направление обхода (ненулевое правило)
   * или чётность (evenodd). Полигоны одного path обрабатываются совместно —
   * так корректно работают «дырки» в контурах.
   */
  function pointInPolys(px, py, polys, evenOdd) {
    let winding = 0;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const yi = poly[i].y;
        const yj = poly[j].y;
        if (yi > py !== yj > py) {
          const xCross = poly[j].x + ((py - poly[j].y) / (yi - yj)) * (poly[i].x - poly[j].x);
          if (px < xCross) winding += yi > yj ? 1 : -1;
        }
      }
    }
    return evenOdd ? winding % 2 !== 0 : winding !== 0;
  }

  /* ---------- Обход DOM-дерева SVG и сбор фигур ---------- */

  const SKIP_TAGS = new Set(['defs', 'clipPath', 'mask', 'marker', 'symbol', 'pattern', 'metadata', 'script', 'style']);

  /** Достаёт свойство из атрибута или из style="...". */
  function styleProp(el, name) {
    const style = el.getAttribute('style');
    if (style) {
      const m = style.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'i'));
      if (m) return m[1].trim();
    }
    return el.getAttribute(name);
  }

  /** Превращает элемент в массив полигонов (или null, если это не фигура с заливкой). */
  function elementToPolys(el, matrix) {
    const tag = el.nodeName.toLowerCase();
    const num = (name, def = 0) => parseFloat(el.getAttribute(name) ?? def) || def;
    if (tag === 'rect') {
      const x = num('x');
      const y = num('y');
      const w = num('width');
      const h = num('height');
      if (w <= 0 || h <= 0) return null;
      return [
        [applyMatrix(matrix, { x, y }), applyMatrix(matrix, { x: x + w, y }), applyMatrix(matrix, { x: x + w, y: y + h }), applyMatrix(matrix, { x, y: y + h })],
      ];
    }
    if (tag === 'circle' || tag === 'ellipse') {
      const cx = num('cx');
      const cy = num('cy');
      const rx = tag === 'circle' ? num('r') : num('rx');
      const ry = tag === 'circle' ? num('r') : num('ry');
      if (rx <= 0 || ry <= 0) return null;
      const pts = [];
      const N = 32;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        pts.push(applyMatrix(matrix, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }));
      }
      return [pts];
    }
    if (tag === 'polygon' || tag === 'polyline') {
      const raw = (el.getAttribute('points') || '').trim();
      if (!raw) return null;
      const nums = raw.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g).map(parseFloat);
      const pts = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(applyMatrix(matrix, { x: nums[i], y: nums[i + 1] }));
      return pts.length >= 3 ? [pts] : null;
    }
    if (tag === 'path') {
      const d = el.getAttribute('d');
      if (!d) return null;
      return parsePathData(d, matrix);
    }
    return null;
  }

  /** Рекурсивно собирает фигуры в порядке документа. */
  function collectShapes(el, inherited, out, coords) {
    for (const child of el.children) {
      const tag = child.nodeName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const matrix = mulMatrix(inherited.matrix, parseTransform(child.getAttribute('transform')));
      const fillRaw = styleProp(child, 'fill') ?? inherited.fill;
      const ruleRaw = styleProp(child, 'fill-rule') ?? inherited.rule;

      const polys = elementToPolys(child, matrix);
      if (polys && polys.length) {
        const fill = normalizeColor(fillRaw);
        if (fill) {
          // bbox фигуры — чтобы быстро пропускать клетки мимо неё
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const poly of polys) {
            for (const p of poly) {
              if (p.x < minX) minX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.x > maxX) maxX = p.x;
              if (p.y > maxY) maxY = p.y;
              coords.push(p.x, p.y);
            }
          }
          out.push({ polys, fill, evenOdd: ruleRaw === 'evenodd', minX, minY, maxX, maxY });
        }
      }
      if (child.children && child.children.length) {
        collectShapes(child, { matrix, fill: fillRaw, rule: ruleRaw }, out, coords);
      }
    }
  }

  /* ---------- Определение размера логического пикселя ---------- */

  /**
   * Ищем наибольший размер клетки, на который делится ≥90% всех координат.
   * Так поддерживаются и рисунки «1 логический пиксель = 10 SVG-пикселей»,
   * и другие масштабы (например, 20×20 у цыплёнка).
   */
  function detectPixelSize(coords, fallback) {
    if (!coords.length) return fallback || 10;
    const candidates = [100, 64, 50, 40, 32, 25, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
    for (const cand of candidates) {
      let ok = 0;
      for (const v of coords) {
        const q = v / cand;
        if (Math.abs(q - Math.round(q)) < 1e-6) ok++;
      }
      if (ok / coords.length >= 0.9) return cand;
    }
    return fallback || 10;
  }

  /* ---------- Главная функция ---------- */

  /**
   * Разбирает текст SVG в сетку логических пикселей.
   * @param {string} svgText — содержимое SVG-файла
   * @param {number} [expectedPixel] — ожидаемый размер клетки (подсказка, обычно 10)
   * @returns {{cols:number, rows:number, pixel:number, cells:Int16Array,
   *            colors:Array<{hex:string,count:number}>, width:number, height:number}}
   */
  function parse(svgText, expectedPixel) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Некорректный SVG: ' + doc.querySelector('parsererror').textContent.slice(0, 120));
    }
    const svg = doc.documentElement;

    // Размеры: viewBox имеет приоритет над width/height.
    let minX = 0;
    let minY = 0;
    let width = 0;
    let height = 0;
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
    if (vb.length === 4 && vb.every((n) => !isNaN(n))) {
      [minX, minY, width, height] = vb;
    } else {
      width = parseFloat(svg.getAttribute('width')) || 0;
      height = parseFloat(svg.getAttribute('height')) || 0;
    }
    if (!width || !height) throw new Error('У SVG не указан размер (viewBox/width/height)');

    // Собираем фигуры.
    const shapes = [];
    const coords = [width + minX, height + minY];
    collectShapes(svg, { matrix: IDENTITY, fill: 'black', rule: 'nonzero' }, shapes, coords);

    // Определяем сетку.
    const pixel = detectPixelSize(coords, expectedPixel);
    const cols = Math.max(1, Math.round(width / pixel));
    const rows = Math.max(1, Math.round(height / pixel));

    // Классифицируем каждую клетку по цвету фигуры, верхней в точке её центра.
    const cells = new Int16Array(cols * rows); // 0 = фон
    const colorIndex = new Map(); // hex → код класса (2, 3, …)
    const colorCounts = [];
    const order = []; // порядок появления цветов (для стабильной палитры)

    for (let row = 0; row < rows; row++) {
      const py = minY + row * pixel + pixel / 2;
      for (let col = 0; col < cols; col++) {
        const px = minX + col * pixel + pixel / 2;
        let hex = null;
        // Идём с последней фигуры (верхней) к первой.
        for (let s = shapes.length - 1; s >= 0; s--) {
          const sh = shapes[s];
          if (px < sh.minX || px > sh.maxX || py < sh.minY || py > sh.maxY) continue;
          if (pointInPolys(px, py, sh.polys, sh.evenOdd)) {
            hex = sh.fill;
            break;
          }
        }
        if (!hex) continue;
        const { r, g, b } = hexToRgb(hex);
        if (r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD) continue; // фон
        if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) {
          cells[row * cols + col] = 1; // чёрный контур
          continue;
        }
        let idx = colorIndex.get(hex);
        if (idx === undefined) {
          idx = 2 + order.length;
          colorIndex.set(hex, idx);
          order.push(hex);
          colorCounts.push(0);
        }
        cells[row * cols + col] = idx;
        colorCounts[idx - 2]++;
      }
    }

    const colors = order.map((hex, i) => ({ hex, count: colorCounts[i] }));
    return { cols, rows, pixel, cells, colors, width, height };
  }

  global.SvgRasterizer = { parse, normalizeColor, hexToRgb };
})(window);
