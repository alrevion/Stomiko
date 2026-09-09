/**
 * Кнопка, которую никто не слушает.
 *
 * Нажатия в приложении ловит ОДИН обработчик на документе: он ищет
 * ближайшего предка с одним из перечисленных data-атрибутов. Атрибут,
 * забытый в этом перечне, делает кнопку мёртвой — она рисуется, нажимается
 * и не делает ничего. Ни один серверный набор такого не увидит: маршрут
 * работает, экран рисуется, а нажатие просто не доходит.
 *
 * Так однажды уехал в бой весь экран проверки лицензий: «Подтвердить»,
 * «Отклонить» и «Открыть реестр» не были в перечне, и заявку нельзя было
 * ни принять, ни отклонить. Нашлось только руками, в реальном Telegram.
 *
 *   node qa/clicks.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const selector = src.match(/e\.target\.closest\('([^']+)'\)/)?.[1];
if (!selector) {
  console.error('не найден делегированный обработчик нажатий');
  process.exit(1);
}
const слушаем = new Set([...selector.matchAll(/\[data-([a-z-]+)\]/g)].map((m) => m[1]));

// Нажимают на <button> и на строки-цели (.stockrow, .picker button).
// Атрибут на <input> — это поле формы, его читают по id, а не по нажатию.
const цели = new Map();
for (const m of src.matchAll(/<(button|div)\b[^>]*?\sdata-([a-z-]+)=/g)) {
  const [, тег, attr] = m;
  if (!цели.has(attr)) цели.set(attr, тег);
}

// Атрибут, который читают перебором (querySelectorAll('[data-x]')), — это
// не кнопка, а разметка формы: его собирают при сохранении, а не по нажатию.
const перебираем = new Set(
  [...src.matchAll(/querySelectorAll\('\[data-([a-z-]+)\]'\)/g)].map((m) => m[1]));

const мёртвые = [...цели.keys()]
  .filter((a) => !слушаем.has(a) && !перебираем.has(a));
if (мёртвые.length) {
  console.error('МЁРТВЫЕ КНОПКИ — атрибут есть в разметке, но не в обработчике:');
  for (const a of мёртвые) console.error(`  data-${a} (на <${цели.get(a)}>)`);
  console.error('\nДобавьте их в e.target.closest(...) в app.js.');
  process.exit(1);
}
console.log(`✓ все ${цели.size} нажимаемых атрибута слушаются (${слушаем.size} в перечне)`);
