/**
 * Спрайт зубов из исходников в vendor/teeth.
 *
 * Исходный SVG зуба — это не картинка, а слоёный набор состояний: кариес по
 * поверхностям, четыре вида пломб, коронки, импланты, брекеты, трещины. Всё
 * это лежит скрытыми группами и весит 95% файла — 73 килобайта на один зуб,
 * два с половиной мегабайта на карту. Нам сегодня нужен силуэт, поэтому сборка
 * оставляет три группы: десну, постоянный зуб и молочный.
 *
 * Слои НЕ выброшены навсегда: исходники лежат рядом целиком. Появятся у нас
 * состояния зуба — здесь добавится строка в KEEP, а не поиск нового набора.
 *
 * Запуск: node apps/miniapp/scripts/build-teeth.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'vendor', 'teeth');
const out = join(here, '..', 'public', 'teeth.js');

/** Тип зуба → файл-образец. Половины челюсти зеркальны, типы повторяются. */
const TYPES = [
  { key: 'incisor', file: '11' },
  { key: 'canine', file: '13' },
  { key: 'premolar', file: '14' },
  { key: 'molar', file: '16' },
  { key: 'occl-premolar', file: '14_occl' },
  { key: 'occl-molar', file: '16_occl' },
];

/** Достать группу верхнего уровня по id вместе с содержимым. */
function group(svg, id) {
  const open = new RegExp(`<g[^>]*\\bid="${id}"[^>]*>`);
  const m = open.exec(svg);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const tag = /<(\/?)g\b/g;
  tag.lastIndex = i;
  let t;
  while ((t = tag.exec(svg))) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return { attrs: m[0], body: svg.slice(i, t.index), end: tag.lastIndex };
  }
  return null;
}

/**
 * Убрать кость и вернуть только десну.
 *
 * `bone-base` — бежевый прямоугольник челюсти. В ряду из шестнадцати зубов он
 * склеивается в сплошную полосу, за которой не видно самих зубов.
 */
const dropBone = (body) => body.replace(/<path[^>]*\bid="bone-base"[^>]*\/>/g, '');

/** Инлайновый display у молочного мешает показать его классом. */
const showable = (s) => s.replace(/style="display: ?none;?\s*"/g, '')
  .replace(/(style="[^"]*?)display: ?none;?\s*/g, '$1');

const symbols = [];
const defs = [];
for (const { key, file } of TYPES) {
  const svg = readFileSync(join(src, `${file}.svg`), 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(svg)[1];
  const gum = group(svg, 'base');
  const perm = group(svg, 'tooth');
  const milk = group(svg, 'milktooth');
  if (!gum || !perm) throw new Error(`${file}: нет группы base или tooth`);

  // Градиенты нужны вместе с зубом: без них заливка ссылается в пустоту и
  // зуб выходит чёрным. Идентификаторы разводим по файлам — они попадают в
  // один общий спрайт, а совпадение имён там значит чужую заливку.
  const tag = `s${key.replace(/[^a-z]/g, '')}`;
  const localise = (s) => s
    .replace(/\bid="([^"]+)"/g, (_, v) => `id="${tag}-${v}"`)
    .replace(/url\(#([^)]+)\)/g, (_, v) => `url(#${tag}-${v})`)
    .replace(/href="#([^"]+)"/g, (_, v) => `href="#${tag}-${v}"`);

  const source = readFileSync(join(src, `${file}.svg`), 'utf8');
  const defsBody = /<defs>([\s\S]*?)<\/defs>/.exec(source);

  const make = (id, toothBody) => `<symbol id="${id}" viewBox="${viewBox}">`
    + `<g>${localise(dropBone(gum.body))}</g><g>${localise(toothBody)}</g></symbol>`;

  if (defsBody) defs.push(localise(defsBody[1]));
  symbols.push(make(`t-${key}`, perm.body));
  // Молочные есть не у всех образцов: у моляра постоянный и молочный
  // силуэты в этом наборе не различаются, и подстановка постоянного —
  // честнее, чем пустое место на карте ребёнка.
  symbols.push(make(`t-milk-${key}`, milk ? showable(milk.body) : perm.body));
}

// Заливки, на которые ссылаются силуэты. Неиспользуемые выкидываем: в
// исходнике их сотня на каждое состояние, а состояний мы не берём.
const used = new Set([...symbols.join('').matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]));
const keptDefs = defs.join('').replace(
  /<(linearGradient|radialGradient|clipPath|mask)\b[^>]*\bid="([^"]+)"[\s\S]*?<\/\1>/g,
  (whole, _t, id) => (used.has(id) ? whole : ''));

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">`
  + `<defs>${keptDefs}</defs>` + symbols.join('') + '</svg>';

writeFileSync(out, `/* СОБРАНО скриптом scripts/build-teeth.mjs — не править руками.
 *
 * Рисунки зубов: React Advanced Odontogram, автор Zoltán Dul, лицензия MIT.
 * https://github.com/ZoliQua/React-Odontogram-Modul
 * Исходники и текст лицензии — в apps/miniapp/vendor/teeth.
 */
export const TEETH_SPRITE = ${JSON.stringify(sprite)};
`);

console.log(`${out}: ${sprite.length} байт, ${symbols.length} силуэтов`);
