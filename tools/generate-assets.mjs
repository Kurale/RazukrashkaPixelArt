#!/usr/bin/env node
/* ============================================================================
 * Генератор ассетов для приложения «Раскраска по пикселям».
 *
 * Запуск:  node tools/generate-assets.mjs
 *
 * Что делает:
 *   1. По ASCII-описаниям создаёт пиксельные SVG-рисунки в папке assets/
 *      (1 логический пиксель = 10×10 реальных пикселей SVG).
 *      Чёрный контур вокруг цветных пятен добавляется АВТОМАТИЧЕСКИ:
 *      любая белая клетка, соприкасающаяся с цветной (или чёрной),
 *      превращается в чёрную клетку контура.
 *   2. Собирает assets/manifest.json — список всех SVG в папке
 *      (приложение подхватывает его, когда запущено через локальный сервер).
 *   3. Создаёт js/embedded-art.js со встроенными копиями всех SVG —
 *      благодаря этому приложение работает даже при открытии index.html
 *      двойным кликом (протокол file://, где fetch недоступен).
 *
 * Как добавить свой рисунок: допишите очередной элемент в массив ARTS ниже
 * (строки одинаковой длины, буквы из палитры, '.' — белый фон,
 * 'K' — принудительно чёрная клетка) и перезапустите скрипт.
 * ==========================================================================*/

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, 'assets');
const JS_DIR = join(ROOT, 'js');

const BLACK = '#000000';

/* ---------------------------------------------------------------------------
 * Описания рисунков.
 * Каждый рисунок — сетка символов:
 *   '.' — белый фон (не раскрашивается),
 *   'K' — чёрная клетка (контур/деталь, не раскрашивается),
 *   буква из palette — цветная раскрашиваемая клетка.
 * -------------------------------------------------------------------------*/
const ARTS = [
  {
    file: 'domik.svg',
    title: 'Домик',
    palette: {
      R: '#e53935', // крыша
      C: '#ffe0b2', // стены
      B: '#64b5f6', // окна
      N: '#795548', // дверь
      G: '#7cb342', // трава
      Y: '#fdd835', // солнце
    },
    art: [
      '....................',
      '...............YYYY.',
      '.........RR....YYYY.',
      '.........RR....YYYY.',
      '........RRRR...YYYY.',
      '.......RRRRRR.......',
      '......RRRRRRRR......',
      '.....RRRRRRRRRR.....',
      '....RRRRRRRRRRRR....',
      '.....CCCCCCCCCC.....',
      '.....CBBCCCCBBC.....',
      '.....CBBCCCCBBC.....',
      '.....CBBCNNCBBC.....',
      '.....CCCCNNCCCC.....',
      '.....CCCCNNCCCC.....',
      '.....CCCCNNCCCC.....',
      '.GGGGGGGGGGGGGGGGGG.',
      '.GGGGGGGGGGGGGGGGGG.',
      '....................',
      '....................',
    ],
  },
  {
    file: 'kotik.svg',
    title: 'Котик',
    palette: {
      O: '#fb8c00', // шерсть
      D: '#e65100', // полоски
      E: '#388e3c', // глаза
      M: '#ffe0b2', // мордочка и грудка
      P: '#f48fb1', // внутренние ушки и носик
    },
    art: [
      '....................',
      '....................',
      '.....OO......OO.....',
      '....OPPO....OPPO....',
      '......OOOOOOOO......',
      '.....OOODDODDOO.....',
      '....OOOODDODDOOO....',
      '....OOOOOOOOOOOO....',
      '....OOOEEOOEEOOO....',
      '....OOOEEOOEEOOO....',
      '....OOOOOOOOOOOO....',
      '....OOOMMPPMMOOO....',
      '....OOOMMKKMMOOO....',
      '....OOOMMMMMMOOO....',
      '.....OOOOOOOOOO.....',
      '......OOOOOOOO......',
      '.....OOOMMMMOOO.....',
      '.....OOOMMMMOOO.....',
      '......OOMKMKMO......',
    ],
  },
  {
    file: 'cvetok.svg',
    title: 'Цветок',
    palette: {
      P: '#ec407a', // лепестки
      Y: '#fdd835', // серединка
      G: '#2e7d32', // стебель
      L: '#9ccc65', // листья
      T: '#d84315', // горшок
    },
    art: [
      '................',
      '................',
      '......PPPP......',
      '.....PPPPPP.....',
      '....PPYYYYPP....',
      '....PYYYYYYP....',
      '....PYYYYYYP....',
      '....PPYYYYPP....',
      '.....PPPPPP.....',
      '......PPPP......',
      '.......GG.......',
      '.......GGLLL....',
      '....LLLGGLLL....',
      '....TTTTTTTT....',
      '.....TTTTTT.....',
      '................',
    ],
  },
  {
    file: 'korablik.svg',
    title: 'Кораблик',
    palette: {
      R: '#e53935', // флажок
      C: '#e8dfc8', // большой парус
      O: '#fb8c00', // маленький парус
      N: '#6d4c41', // корпус
      B: '#64b5f6', // волны
      D: '#1e88e5', // глубокие волны
      Y: '#fdd835', // солнце
    },
    art: [
      '........................',
      '...........RRR.....YYY..',
      '...........KCC.....YYY..',
      '...........KCCC....YYY..',
      '......OOOOOKCCCC........',
      '.......OOOOKCCCCC.......',
      '........OOOKCCCCCC......',
      '.........OOKCCCCCCC.....',
      '.........OOKCCCCCCCC....',
      '...........KCCCCCCCCC...',
      '.....NNNNNNNNNNNNNN.....',
      '......NNNNNNNNNNNN......',
      'BBBBBBBBBBBBBBBBBBBBBBBB',
      'DDDDDDDDDDDDDDDDDDDDDDDD',
      'BBBBBBBBBBBBBBBBBBBBBBBB',
      'DDDDDDDDDDDDDDDDDDDDDDDD',
    ],
  },
  {
    file: 'babochka.svg',
    title: 'Бабочка',
    palette: {
      P: '#f06292', // верхние крылья
      U: '#7e57c2', // нижние крылья
      Y: '#fdd835', // пятнышки на верхних
      B: '#29b6f6', // пятнышки на нижних
      N: '#5d4037', // тельце
    },
    art: [
      '.......K....K.......',
      '........K..K........',
      '.........NN.........',
      '.....PPPPNNPPPP.....',
      '...PPPPPPNNPPPPPP...',
      '..PPYYPPPNNPPPYYPP..',
      '..PPYYPPPNNPPPYYPP..',
      '.PPPPPPPPNNPPPPPPPP.',
      '..PPPPPPPNNPPPPPPP..',
      '...UUUUU.NN.UUUUU...',
      '...UUBB..NN..BBUU...',
      '....UUU..NN..UUU....',
      '....UU...NN...UU....',
      '....................',
    ],
  },
  {
    file: 'grib.svg',
    title: 'Грибок',
    palette: {
      R: '#e53935', // шляпка
      C: '#ffe9a8', // точки на шляпке
      M: '#d7a86e', // ножка
      G: '#7cb342', // трава
      Y: '#fdd835', // цветочки
      P: '#f06292', // цветочки
    },
    art: [
      '................',
      '......RRRR......',
      '....RRRRRRRR....',
      '...RRCCRRCCRR...',
      '..RRRCCRRCCRRR..',
      '..RRCCRRRRRCCR..',
      '..RRCCRRRRRCCR..',
      '...RRRRRRRRRR...',
      '.....MMMMMM.....',
      '.....MMMMMM.....',
      '.....MMMMMM.....',
      '..Y..MMMMMM..Y..',
      '..P.MMMMMMMM.P..',
      '.GGGGGGGGGGGGGG.',
      '..GGGGGGGGGGGG..',
      '................',
    ],
  },
];

/* ---------------------------------------------------------------------------
 * Вспомогательные функции генерации.
 * -------------------------------------------------------------------------*/

/** Проверяет корректность ASCII-описания: длины строк и допустимые символы. */
function validateArt(artDef) {
  const width = artDef.art[0].length;
  const allowed = new Set([...Object.keys(artDef.palette), '.', 'K']);
  artDef.art.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`${artDef.file}: строка ${y} имеет длину ${row.length}, ожидается ${width}`);
    }
    for (const ch of row) {
      if (!allowed.has(ch)) throw new Error(`${artDef.file}: неизвестный символ «${ch}» в строке ${y}`);
    }
  });
}

/** Добавляет чёрный контур: белые клетки, соседние с заполненными, становятся 'K'. */
function addOutline(art) {
  const grid = art.map((row) => row.split(''));
  const rows = grid.length;
  const cols = grid[0].length;
  const filled = (ch) => ch !== '.';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[y][x] !== '.') continue;
      const near =
        (x > 0 && filled(art[y][x - 1])) ||
        (x < cols - 1 && filled(art[y][x + 1])) ||
        (y > 0 && filled(art[y - 1][x])) ||
        (y < rows - 1 && filled(art[y + 1][x]));
      if (near) grid[y][x] = 'K';
    }
  }
  return grid;
}

/** Собирает SVG: горизонтальные полосы одного цвета объединяются в один rect. */
function gridToSvg(title, grid, palette) {
  const rows = grid.length;
  const cols = grid[0].length;
  const W = cols * 10;
  const H = rows * 10;
  const hexOf = (ch) => (ch === 'K' ? BLACK : palette[ch]);

  const rects = [];
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      const ch = grid[y][x];
      if (ch === '.') {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < cols && grid[y][x + w] === ch) w++;
      rects.push(`<rect x="${x * 10}" y="${y * 10}" width="${w * 10}" height="10" fill="${hexOf(ch)}"/>`);
      x += w;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">\n` +
    `<!-- ${title} -->\n` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>\n` +
    rects.join('\n') +
    `\n</svg>\n`
  );
}

/* ---------------------------------------------------------------------------
 * Основной сценарий.
 * -------------------------------------------------------------------------*/

mkdirSync(ASSETS, { recursive: true });
mkdirSync(JS_DIR, { recursive: true });

// 1. Генерируем наши SVG-рисунки.
for (const artDef of ARTS) {
  validateArt(artDef);
  const grid = addOutline(artDef.art);
  const svg = gridToSvg(artDef.title, grid, artDef.palette);
  writeFileSync(join(ASSETS, artDef.file), svg, 'utf8');
  console.log(`✓ assets/${artDef.file} (${grid[0].length}×${grid.length} клеток) — «${artDef.title}»`);
}

// 2. Читаем ВСЕ svg из assets (включая исходные файлы пользователя).
const KNOWN_TITLES = {
  'morojenoe.svg': 'Мороженое',
  'tchupa.svg': 'Чупа-чупс',
  'tsipleonok.svg': 'Цыплёнок',
  ...Object.fromEntries(ARTS.map((a) => [a.file, a.title])),
};
// Порядок: сначала исходные рисунки пользователя, затем сгенерированные.
const ORDER = ['morojenoe.svg', 'tchupa.svg', 'tsipleonok.svg', ...ARTS.map((a) => a.file)];

const allFiles = readdirSync(ASSETS).filter((f) => f.toLowerCase().endsWith('.svg'));
const ordered = [
  ...ORDER.filter((f) => allFiles.includes(f)),
  ...allFiles.filter((f) => !ORDER.includes(f)).sort(),
];

const manifest = ordered.map((file) => ({
  file,
  title: KNOWN_TITLES[file] ?? file.replace(/\.svg$/i, ''),
}));
writeFileSync(join(ASSETS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`✓ assets/manifest.json (${manifest.length} рисунков)`);

// 3. Встроенная копия для работы по file://.
const svgs = Object.fromEntries(ordered.map((f) => [f, readFileSync(join(ASSETS, f), 'utf8')]));
const embedded =
  '/* Автоматически сгенерировано tools/generate-assets.mjs — не редактируйте вручную. */\n' +
  '/* Встроенные копии картинок: приложение работает даже по file://, без сервера. */\n' +
  'window.PIXEL_ART_DATA = ' +
  JSON.stringify({ manifest, svgs }) +
  ';\n';
writeFileSync(join(JS_DIR, 'embedded-art.js'), embedded, 'utf8');
console.log(`✓ js/embedded-art.js (встроено ${ordered.length} SVG)`);
