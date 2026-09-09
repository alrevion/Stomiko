/**
 * Stomiko Mini App.
 *
 * Одно приложение — две роли. Роль приходит с сервера, а не из ссылки.
 *
 * Системных диалогов (prompt/confirm) здесь нет: они выглядят чужеродно
 * внутри Telegram, не поддаются стилизации, не показывают контекст и не
 * дают проверить ввод до отправки.
 *
 * Порядок работы со складом жёсткий: материал заводится и приходуется на
 * складе, и только потом попадает в техкарту. Нормировать расход того, чего
 * на складе нет, — значит гарантированно получить строку недостачи вместо
 * себестоимости.
 */

import { TEETH_SPRITE } from './teeth.js';

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

/* ── Клавиатура ──────────────────────────────────────────────────────────
   На телефоне поле в фокусе поднимает клавиатуру, и окно на мгновение
   сжимается до полоски над ней. Главная кнопка закреплена у низа окна — и
   за это мгновение она подпрыгивала на середину экрана, накрывая то самое
   поле, в которое человек только что нажал. Пока он печатает, кнопка ему не
   нужна: прячем её (см. body.typing в app.css) и возвращаем, когда поле
   отпустили. Только для пальца: на десктопе клавиатуры нет, и спрятанная
   кнопка была бы уже дефектом.
   ponytail: на Android «назад» закрывает клавиатуру, не снимая фокус, —
   кнопка вернётся по нажатию в любое место экрана; следить за высотой
   visualViewport, если это станет жалобой. */
/**
 * Флаг выводится из того, где фокус СЕЙЧАС, а не запоминается по событиям.
 *
 * Запоминание сломалось на первом же реальном пути: человек печатал имя,
 * нажал «Поделиться номером», экран перерисовался — и поле с фокусом
 * просто исчезло из документа. Удаление элемента не даёт focusout, флаг
 * остался поднятым, и кнопка «Сохранить и продолжить» пропала насовсем.
 * Проверка по document.activeElement такого состояния не имеет: после
 * перерисовки фокус на body, значит, никто не печатает.
 *
 * Палец проверяется в момент нажатия, а не при загрузке: Telegram Desktop с
 * подключённым тачскрином меняет это на ходу.
 */
function syncTyping() {
  const on = Boolean(document.activeElement?.matches?.('input, textarea, select'))
    && matchMedia('(pointer: coarse)').matches;
  document.body.classList.toggle('typing', on);
}
{
  document.addEventListener('focusin', syncTyping);
  document.addEventListener('focusout', () => setTimeout(syncTyping, 0));
  // Галочка на клавиатуре — это Enter. Вне формы браузер на него ничего не
  // делает: клавиатура остаётся, человек жмёт снова и снова. Однострочное
  // поле на Enter отпускаем — клавиатура уходит, кнопка возвращается.
  // Свои обработчики Enter (поиск) успевают сработать раньше: слушаем на
  // документе, куда событие всплывает последним.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target?.matches?.('input')) e.target.blur();
  });
}

// Тема пришла от клиента — значит своими тёмными значениями подменять её
// нельзя ни в одном поле: получится смесь из двух палитр.
if (tg?.themeParams?.bg_color) document.documentElement.dataset.tg = 'on';
tg?.onEvent?.('themeChanged', () => {
  document.documentElement.dataset.tg = tg.themeParams?.bg_color ? 'on' : 'off';
});

const root = document.getElementById('root');
const toastEl = document.getElementById('toast');
const TZ = 'Asia/Tashkent';

const money = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(n)));
const qtyFmt = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
const hhmm = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayNum = (d) => Number(d.slice(8, 10));
const dateLabel = (d, opts = { day: 'numeric', month: 'long' }) =>
  new Date(`${d}T12:00:00+05:00`).toLocaleDateString('ru-RU', { ...opts, timeZone: TZ });
/** «21 запись», «22 записи», «25 записей» — правило по последним цифрам. */
const plural = (n, one, few, many) => {
  const a = Math.abs(Number(n)) % 100;
  if (a % 10 === 0 || a % 10 > 4 || (a >= 11 && a <= 14)) return many;
  return a % 10 === 1 ? one : few;
};
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const localDate = (off = 0) => new Date(Date.now() + off * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (d, n) => {
  const x = new Date(`${d}T12:00:00+05:00`);
  x.setDate(x.getDate() + n);
  return x.toLocaleDateString('en-CA', { timeZone: TZ });
};

/**
 * Короткое сообщение сверху экрана.
 *
 * Сверху, а не снизу: низ занят главной кнопкой и клавиатурой, и сообщение
 * там либо накрывало кнопку, либо пряталось за клавиатурой. Значок слева
 * говорит, беда это или подтверждение, раньше, чем прочитан текст; при двух
 * строках он стоит между ними по центру, при одной — в её ряд.
 */
const TOAST_ICON = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  bad: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
};
function toast(text, bad = false) {
  toastEl.innerHTML = `<div class="pill">${svg(TOAST_ICON[bad ? 'bad' : 'ok'])}<span>${esc(text)}</span></div>`;
  toastEl.className = 'toast ' + (bad ? 'bad' : 'ok');
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 4000);
}
const haptic = (t = 'light') => tg?.HapticFeedback?.impactOccurred?.(t);
const val = (id) => document.getElementById(id)?.value.trim() ?? '';

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData ?? '',
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { body, status: res.status });
  return body;
}

/**
 * Отрисовка экрана.
 *
 * Два правила, из которых складывается ощущение отзывчивости:
 *
 * Первое — если разметка не изменилась, DOM не трогаем вовсе. Фоновое
 * обновление раздела чаще всего приносит те же самые данные, и переписывать
 * ради этого всю страницу значит потерять прокрутку, фокус и выделение
 * впустую. Именно это читалось как «подлагивает».
 *
 * Второе — прокрутку в начало сбрасывает только СМЕНА экрана. Раньше любая
 * перерисовка дёргала человека наверх посреди чтения.
 */
let drawn = { key: null, html: null };
const render = (html) => {
  const top = S.stack[S.stack.length - 1];
  const key = top ? `${top[0].name}:${JSON.stringify(top[1])}` : 'root';
  if (drawn.key === key && drawn.html === html) return;
  const sameScreen = drawn.key === key;
  drawn = { key, html };
  root.innerHTML = html;
  if (!sameScreen) { root.scrollTop = 0; window.scrollTo(0, 0); }
  syncChrome();
  syncTyping();
};
const S = { stack: [], d: {}, tab: 0 };

/**
 * Данные раздела.
 *
 * Каждое переключение вкладки било в сеть: замер по боевому адресу —
 * 156–231 мс на раздел, а «Кабинет» делал два запроса сразу. Всё это время
 * экран был пустым, и переключение читалось как подтормаживание.
 *
 * Теперь показываем последнее известное сразу, а свежее подтягиваем в фоне
 * и перерисовываем ТОЛЬКО если что-то действительно изменилось — иначе
 * экран дёргался бы под рукой на каждом заходе.
 */
const CACHE = new Map();

async function tabData(key, load, spin) {
  const hit = CACHE.get(key);
  if (hit) {
    // Свежую копию не тянем чаще раза в две секунды: перерисовка сама
    // вызывает tabData заново, и без этого порога вышел бы цикл.
    if (Date.now() - hit.at > 2000) {
      load().then((data) => {
        const changed = JSON.stringify(data) !== JSON.stringify(CACHE.get(key)?.data);
        CACHE.set(key, { at: Date.now(), data });
        if (changed && S.stack.length === 1 && TABS[S.tab]?.k === key) TABS[S.tab].fn();
      }).catch(() => {});
    }
    return hit.data;
  }
  if (spin) spinner(spin);
  const data = await load();
  CACHE.set(key, { at: Date.now(), data });
  return data;
}

const dropCache = (...keys) => {
  if (keys.length) keys.forEach((k) => CACHE.delete(k));
  else CACHE.clear();
};

/** Расписание изменилось — кэш недели и разделов больше не годится. */
const dropCalendar = () => { S.d.cal = null; dropCache('patients', 'cabinet'); };

/**
 * Пациент тронул свои записи — помнить прежние нельзя.
 *
 * Раздел «Запись» тоже: занятое время в нём считается по тем же приёмам, и
 * человек, отменивший запись, должен сразу увидеть освободившееся окно.
 */
const dropMine = () => dropCache('my', 'book');

/* ── Нижняя навигация ──────────────────────────────────────────────────
   Разделы верхнего уровня стоят внизу постоянно, а не прячутся за кнопкой
   «Кабинет»: до склада и базы пациентов должно быть одно касание из любого
   корневого экрана. Иконки нарисованы контуром одной толщины — свой набор,
   а не эмодзи: эмодзи рисуются шрифтом системы, у каждой ОС по-своему,
   и не поддаются ни теме, ни размеру.

   Панель живёт ВНЕ #root: render() переписывает корень целиком, и панель
   внутри него перерисовывалась бы на каждом экране, теряя анимацию. */
const navEl = document.createElement('nav');
navEl.className = 'nav';
navEl.hidden = true;
document.body.appendChild(navEl);

const ICON = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  patients: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2"/><path d="M17 11.2a2.6 2.6 0 1 0 0-5.2M17.5 19.6c0-2.2-.7-3.6-1.8-4.6"/>',
  stock: '<path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z"/><path d="M4 8.5 12 13l8-4.5M12 13v7"/>',
  cabinet: '<path d="M4 20V9.5L12 4l8 5.5V20"/><path d="M9.5 20v-5.5h5V20"/>',
  book: '<path d="M12 4v16M4 12h16"/><circle cx="12" cy="12" r="9"/>',
  my: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m8.5 15 2.2 2.2L15.5 13"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  card: '<path d="M12 3.2c-1.2 0-1.9.6-3 .6-2 0-3.5 1.5-3.5 4 0 3 1 4.6 1.6 7 .4 1.6.7 3 1.9 3 1.4 0 1.3-2.4 3-2.4s1.6 2.4 3 2.4c1.2 0 1.5-1.4 1.9-3 .6-2.4 1.6-4 1.6-7 0-2.5-1.5-4-3.5-4-1.1 0-1.8-.6-3-.6z"/>',
};
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

let TABS = [];
function setTabs(role) {
  TABS = role === 'doctor'
    ? [{ k: 'calendar', label: 'Календарь', fn: docWeek },
       { k: 'patients', label: 'Пациенты', fn: docPatients },
       { k: 'stock', label: 'Склад', fn: docStock },
       { k: 'cabinet', label: 'Кабинет', fn: docMenu }]
    : [{ k: 'book', label: 'Запись', fn: patBook },
       { k: 'my', label: 'Мои записи', fn: patMy },
       // Карта — не подраздел записей: она принадлежит человеку, а не
       // кабинету, и переживает уход от врача. Раздел первого уровня.
       { k: 'card', label: 'Моя карта', fn: patRecord },
       // «Ещё» — единственное место, где человек переключается в кабинет,
       // меняет активного стоматолога и видит свой номер. Раньше всё это
       // жило на экране поиска, куда пациент с кабинетом не заходил вовсе.
       { k: 'more', label: 'Ещё', fn: patMore }];
  navEl.style.setProperty('--n', TABS.length);
  navEl.innerHTML = '<div class="nav-ind"></div>' + TABS.map((t, i) =>
    `<button data-tab="${i}" aria-label="${t.label}">${svg(ICON[t.k])}<span>${t.label}</span></button>`).join('');
}

/**
 * Панель показывается только на корне раздела.
 *
 * Вглубь ведёт кнопка «назад» Telegram, а низ там занят главным действием
 * экрана. Панель под кнопкой «Сохранить» — два ряда органов управления
 * друг на друге и промахи вместо навигации.
 */
function syncChrome() {
  const root_ = S.stack.length <= 1;
  tg?.BackButton?.[root_ ? 'hide' : 'show']();
  navEl.hidden = !root_ || !TABS.length;
  document.body.classList.toggle('has-cta', !!root.querySelector('.primary'));
  document.body.classList.toggle('has-nav', !navEl.hidden);
  if (navEl.hidden) return;
  navEl.querySelector('.nav-ind').style.transform = `translateX(${S.tab * 100}%)`;
  navEl.querySelectorAll('[data-tab]').forEach((b, i) =>
    b.classList.toggle('on', i === S.tab));
}

function goTab(i) {
  if (i === S.tab && S.stack.length <= 1) return;
  S.tab = i;
  S.stack = [];
  haptic('soft');
  return go(TABS[i].fn);
}

/* ── Кнопка «назад» ────────────────────────────────────────────────────
   На Android человек жмёт системную кнопку не задумываясь. Пока история
   браузера не связана со стеком экранов, это движение закрывает Mini App
   целиком: вместо шага назад пропадает всё приложение, и вернуться можно
   только через чат с ботом.

   Поэтому на каждый экран кладётся запись в историю, а СМЕНУ экрана делает
   единственный обработчик popstate. Тогда системная кнопка, жест «назад» от
   края и кнопка Telegram — это один и тот же путь, а не три разных. */

function go(fn, ...args) {
  S.stack.push([fn, args]);
  history.pushState({ depth: S.stack.length }, '');
  return fn(...args);
}

/**
 * Запомнить набранное перед перерисовкой.
 *
 * Человек пишет ФИО и по дороге жмёт «Поделиться номером». Экран после
 * этого рисуется заново — и без этого стирал бы то, что он только что
 * набрал, на середине знакомства.
 */
function keepTyped() {
  const n = val('myname');
  // Черновик живёт отдельно от ответа сервера. Раньше он подкладывался в
  // S.d.me — и первый же ответ сервера, где ФИО ещё пустое, затирал его:
  // человек отправлял место и получал «Как вас записывать в карту?».
  if (n) S.d.draftName = n;
}

/** Перерисовать текущий экран на месте, не заводя лишний шаг в истории. */
function refresh() {
  const [fn, args] = S.stack[S.stack.length - 1] ?? [];
  return fn ? fn(...args) : undefined;
}

function back(levels = 1) {
  if (S.stack.length <= 1) return;
  // Лишние уровни снимаем сами, последний шаг делает история: так на каждый
  // вызов приходится ровно одно событие popstate, без гонки счётчиков.
  for (let i = 1; i < levels && S.stack.length > 1; i += 1) S.stack.pop();
  history.back();
}

window.addEventListener('popstate', () => {
  // На корне раздела «назад» закрывает приложение — так ведёт себя всё
  // остальное на телефоне, и притворяться исключением не нужно.
  if (S.stack.length <= 1) return void tg?.close?.();
  S.stack.pop();
  const [fn, args] = S.stack[S.stack.length - 1] ?? [];
  if (fn) fn(...args);
  syncChrome();
});

tg?.BackButton?.onClick(() => back());
// Корневой экран получает свою запись в истории: без неё первый же «назад»
// уходит за пределы приложения, не дав нам ничего сделать.
history.replaceState({ depth: 1 }, '');

/**
 * Модальное окно с вопросом.
 *
 * Единственный случай, ради которого оно заведено, — необратимое действие.
 * Отдельный экран тут не годится: к экрану привыкают и проходят его не
 * читая, а окно перебивает и требует решения здесь.
 *
 * «Отмена» стоит СПРАВА — под большим пальцем правой руки, и промах по краю
 * попадает в неё, а не в необратимое. Касание по подложке тоже отменяет.
 * Возвращает true только на явное подтверждение.
 */
function ask({ title, body, confirm = 'Подтверждаю', cancel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>${esc(title)}</h2>
          <button class="modal-x stay" aria-label="Закрыть">${
            svg('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        </div>
        <div class="modal-body"><div class="note">${body}</div></div>
        <div class="modal-actions${danger ? ' careful' : ''}">
          <button class="go">${esc(confirm)}</button>
          <button class="stay">${esc(cancel)}</button>
        </div>
      </div>`;
    const close = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    scrim.querySelector('.go').onclick = () => close(true);
    // Крестик и «Отмена» — одно и то же действие: отказ. Обе кнопки помечены
    // классом .stay, поэтому обработчик один на обе.
    scrim.querySelectorAll('.stay').forEach((b) => { b.onclick = () => close(false); });
    // Промах мимо окна закрывает, а не подтверждает.
    scrim.onclick = (e) => { if (e.target === scrim) close(false); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    // Фокус на отмене: случайный Enter не удалит кабинет.
    setTimeout(() => scrim.querySelector('.stay').focus(), 40);
  });
}

const spinner = (t = 'Загрузка…') => render(`<div class="loading">${t}</div>`);

/**
 * Отметить, что раздел открыт.
 *
 * Обучение не спрашивает «вы посмотрели?» — оно видит. Галочки, которые
 * человек ставит себе сам, ничего не значат: их ставят не глядя.
 */
function markSeen(screen) {
  const ob = S.d.me?.onboarding;
  if (!ob?.active || (ob.seen ?? []).includes(screen)) return;
  ob.seen = [...(ob.seen ?? []), screen];
  api('/onboarding/seen', { method: 'POST', body: JSON.stringify({ screen }) }).catch(() => {});
}
const humanMins = (m) => (m < 60 ? `${m} мин`
  : m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${Math.floor(m / 60)} ч`);

/* ══════════════════════════════════════════════════════════════════════════
   ЛИЧНОСТЬ И РЕЖИМЫ

   Человек не «пациент» или «врач» — он и то и другое, а режим выбирает сам.
   Стоматолог тоже лечит зубы у коллеги: раньше членство навсегда делало его
   врачом, и записаться он не мог.

   По умолчанию все — пациенты. Спрашивать роль на входе значило задавать
   вопрос, ответ на который у девяноста девяти человек из ста одинаков, и
   ставить его ПЕРЕД тем, зачем человек пришёл. Кабинет заводится из «Ещё»:
   врач делает это однажды, пациент записывается каждый раз.
   ══════════════════════════════════════════════════════════════════════════ */


/**
 * Место человека.
 *
 * В новых клиентах точку отдаёт сам Telegram, в старых — браузер. Отказ не
 * ошибка: поиск работает и без места, просто без слова «ближайшие».
 */
function askLocation() {
  const lm = tg?.LocationManager;
  return new Promise((resolve) => {
    if (lm?.getLocation) {
      const get = () => lm.getLocation((l) => resolve(
        l?.latitude != null ? { lat: l.latitude, lon: l.longitude }
          // Отказ и «в этом клиенте нельзя» — разные беды: первую человек
          // чинит в настройках, вторую не чинит никак, и предлагать ему
          // настройки во втором случае значит гонять его впустую.
          : lm.isLocationAvailable === false ? 'нет' : 'запрещено'));
      return lm.isInited ? get() : lm.init(get);
    }
    if (!navigator.geolocation) return resolve('нет');
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => resolve(e.code === 1 ? 'запрещено' : 'нет'),
      { timeout: 10000, maximumAge: 300000 });
  });
}

/**
 * Номер от Telegram.
 *
 * Новые клиенты спрашивают прямо из приложения и честно отвечают, нажал ли
 * человек «Поделиться» или «Отмена». Старые такого не умеют — там остаётся
 * кнопка в чате с ботом. Оба пути кончаются одним и тем же служебным
 * сообщением боту, поэтому дальше поведение общее.
 */
function askContact() {
  return new Promise((resolve) => {
    if (typeof tg?.requestContact !== 'function') return resolve('нельзя');
    try { tg.requestContact((ok) => resolve(ok ? 'отправлен' : 'отказ')); }
    catch { resolve('нельзя'); }
  });
}

/**
 * Кто вы и где вы.
 *
 * Три вещи, которые платформа спрашивает один раз за всё время: имя, номер и
 * место. Имя — потому что в Telegram у человека ник («Yakov», «ᅠ»), а врачу
 * в карточке нужно, кого звать в кресло; раньше ФИО вводилось заново при
 * каждой записи в каждый кабинет. Номер — куда звонить, если приём сдвинулся.
 * Место — чтобы «найти стоматолога» отвечало «ближайшие», а не «какие-нибудь».
 *
 * Экран один и тот же на первом входе и в профиле: где человек однажды
 * заполнил, там же он потом и ищет.
 */
function profileScreen(first = false) {
  const me = S.d.me ?? {};
  render(`
    <header><h1>${first ? 'Давайте познакомимся' : 'Ваши данные'}</h1>
      </header>
    <main>
      <div class="card">
        <label class="fieldlabel">Фамилия и имя</label>
        <input class="field" id="myname" autocomplete="name" enterkeyhint="done"
          placeholder="Каримов Азиз" value="${esc(S.d.draftName ?? me.fullName ?? '')}">
        <div class="note">Так вас запишут в карту. Имя из Telegram сюда не
        подставляем: там ник, а не ФИО.</div>
      </div>

      <div class="card" id="phonecard">
        <div class="row"><span class="muted">Телефон</span>
          <span class="name mono">${me.phone ? esc(me.phone) : 'не подтверждён'}</span></div>
        <div class="note">${me.phone
          ? 'Его видит только тот кабинет, в который вы записываетесь. Номер приходит от Telegram — подделать его нельзя.'
          : 'Без номера в системе не зарегистрироваться: врач должен знать, куда звонить, если приём придётся перенести. Telegram пришлёт его сам, вводить ничего не нужно.'}</div>
        <button class="ghost" data-act="sharephone">${
          me.phone ? 'Отправить другой номер' : 'Поделиться номером'}</button>
      </div>

      ${first ? '' : placeCard()}
    </main>
    <button class="primary" data-act="saveprofile" data-first="${first ? 1 : 0}">${
      first ? 'Дальше' : 'Сохранить'}</button>
  `);
}

/**
 * Карточка места. Одна и та же в профиле и на шаге знакомства: человек
 * читает про геопозицию ровно один текст, где бы её ни включал.
 */
function placeCard() {
  const placed = S.d.me?.lat != null;
  return `
      <div class="card">
        <div class="row"><span class="muted">Где вы находитесь</span>
          <span class="name">${placed ? 'определено' : 'не отправлено'}</span></div>
        <div class="note">${
          S.d.geo === 'запрещено'
            ? 'Telegram не дал нам ваше место. Разрешите геопозицию в его настройках — или продолжайте без неё, всё остальное работает.'
            : S.d.geo === 'нет'
              ? 'Этот Telegram не умеет отдавать место. Не беда: кабинеты ищутся по городу и адресу, просто без слова «ближайшие».'
              : placed
                ? 'По этой точке в поиске считается, кто к вам ближе. Переехали или ищете рядом с работой — отправьте другую.'
                : 'Нужно ровно для одного: показать в поиске ближайшие к вам кабинеты. Без него тоже можно — просто кабинеты будут в общем порядке.'}</div>
        ${S.d.geo === 'нет' ? '' : `<button class="ghost" data-act="${
          S.d.geo === 'запрещено' ? 'geosettings' : 'myplace'}">${
          S.d.geo === 'запрещено' ? 'Открыть настройки Telegram'
            : placed ? 'Отправить другое место' : 'Отправить своё место'}</button>`}
      </div>`;
}

/**
 * Кем человек пришёл.
 *
 * Вопрос задаётся ПОСЛЕ имени и номера, а не вместо них: раньше он стоял
 * первым экраном платформы, и человек с рекламы, пришедший записаться к
 * стоматологу, начинал знакомство с выбора профессии.
 *
 * Ответ ничего не запирает: пациент в любой момент заводит кабинет из «Ещё»,
 * врач смотрит на себя как на пациента из «Кабинета». Он лишь решает, что
 * спросить следующим — место (пациенту, чтобы найти ближних) или кабинет
 * (врачу, которому место ни к чему: у кабинета свой адрес).
 */
function roleScreen() {
  render(`
    <header><h1>Кем вы пришли?</h1>
      </header>
    <main>
      <div class="picker">
        <button data-act="aspatient"><div class="name">Я пациент</div>
          <div class="price">найти стоматолога, записаться, вести свою зубную карту</div></button>
        <button data-act="asdoctor"><div class="name">Я врач</div>
          <div class="price">завести свой кабинет или войти по приглашению коллеги</div></button>
      </div>
      <div class="card">
        <div class="note" style="margin:0">Врач — тоже чей-то пациент. Оба раздела
        останутся при вас, вопрос только в том, с чего начать.</div>
      </div>
    </main>
  `);
}

/**
 * Где человек находится. Отдельный шаг и только для пациента: врачу место
 * ни к чему — у кабинета есть свой адрес, который он укажет сам.
 */
function placeScreen() {
  render(`
    <header><h1>Где вы находитесь?</h1>
      </header>
    <main>
      ${placeCard()}
      <div class="card">
        <div class="note" style="margin:0">Точка нужна только поиску. Адрес не
        сохраняется и никому не показывается, а врач видит его, только когда
        вы к нему записались.</div>
        <button class="mini" data-act="skipplace">Пропустить</button>
      </div>
    </main>
  `);
}

/** Название специализации по коду: словарь приезжает вместе с выдачей. */
const specName = (code) =>
  (S.d.find?.specialties ?? []).find((x) => x.code === code)?.nameRu ?? code;

/**
 * Поиск стоматолога.
 *
 * Заменяет собой тупик «нужна ссылка врача». Человек с рекламы приходит без
 * ссылки — и до этого экрана ему нечего было здесь делать.
 *
 * Порядок — по ближайшему свободному времени, без «рекомендуем» и платных
 * мест: как только платформа начинает советовать, она отвечает за выбор
 * врача, а отвечать ей нечем.
 */
async function needLink(city = '', query = '') {
  const load = () => api(`/find?city=${encodeURIComponent(city)}&q=${encodeURIComponent(query)}`);
  // Корень раздела помнится, как и остальные разделы; поиск по конкретному
  // запросу всегда свежий — человек только что его набрал и ждёт ответа.
  const { cabinets, cities, specialties } = (city || query)
    ? await (spinner('Ищем кабинеты…'), load())
    : await tabData('book', load, 'Ищем кабинеты…');
  S.d.find = { city, query, cities, specialties };

  const when = (iso) => (iso
    ? `${dateLabel(iso.slice(0, 10), { day: 'numeric', month: 'short' })}, ${hhmm(iso)}`
    : 'времени пока нет');

  render(`
    <header><h1>Найти стоматолога</h1></header>
    <main>
      <div class="card">
        <input class="field" id="findq" placeholder="Название, улица или ориентир"
          value="${esc(query)}" inputmode="search" enterkeyhint="search" autocomplete="off">
        ${cities.length > 1 ? `<div class="chips" style="margin-top:10px">
          <button data-city="" class="${city ? '' : 'on'}">Везде</button>
          ${cities.map((c) => `<button data-city="${esc(c.city)}"
            class="${city === c.city ? 'on' : ''}">${esc(c.city)} · ${c.cabinets}</button>`).join('')}
        </div>` : ''}
      </div>

      ${cabinets.length ? cabinets.map((c) => `
      <div class="stockrow" data-pick-cab="${c.tenantId}">
        <div class="body">
          <div class="name">${esc(c.name)}</div>
          <div class="muted">${c.doctor ? `${esc(c.doctor)} · ` : ''}${esc(c.city ?? '')}${
            c.landmark ? `, ${esc(c.landmark)}` : c.address ? `, ${esc(c.address)}` : ''}</div>
          ${(c.specialties ?? []).length ? `<div class="muted">${
            c.specialties.map((code) => esc(specName(code))).join(' · ')}</div>` : ''}
          <div class="muted">${c.distanceKm != null
            ? `${c.distanceKm < 1 ? 'меньше километра' : `${c.distanceKm} км от вас`} · ` : ''
            }Ближайшее время: ${when(c.nextSlot)}</div>
        </div>
        <div class="qty-val mono">${c.consultPrice != null ? money(c.consultPrice) : '—'}<small>приём</small></div>
      </div>`).join('')
      : `<div class="card">
          <div class="note" style="margin:0">${query || city
            ? 'По этому запросу ничего не нашлось. Попробуйте другой город или название.'
            : 'Пока ни один кабинет не открыл запись через поиск. Если вам дали ссылку врача — откройте её, и всё настроится само.'}</div>
        </div>`}

      ${S.d.me?.lat == null && cabinets.length ? `<div class="card">
        <div class="note">Отправьте своё место — и кабинеты встанут по
        расстоянию, ближайшие сверху.</div>
        <button class="ghost" data-act="myplace">Показать ближайшие</button>
      </div>` : ''}

      <div class="card">
        <div class="note" style="margin:0">Если стоматолог прислал вам ссылку —
        просто откройте её. Она приведёт прямо к нему, искать не нужно.</div>
      </div>
    </main>
  `);
  setTimeout(() => {
    const el = document.getElementById('findq');
    if (!el) return;
    el.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = el.value.trim();
      const top = S.stack[S.stack.length - 1];
      if (top?.[0] === needLink) S.stack[S.stack.length - 1] = [needLink, [city, q]];
      needLink(city, q);
    };
  }, 60);
}

/**
 * Вход врача. Создание кабинета появится отдельно; сегодня врач попадает
 * внутрь по одноразовому приглашению — и это же поле примет код регистрации,
 * когда она заработает.
 */
function doctorEntry() {
  render(`
    <header><h1>Вход для врача</h1></header>
    <main>
      <div class="picker">
        <button data-act="newcabinet"><div class="name">Создать свой кабинет</div>
          <div class="price">справочник, техкарты и цены — уже внутри</div></button>
      </div>
      <div class="sectiontitle">Меня пригласили</div>
      <div class="card">
        <div class="note" style="margin:0 0 12px">Если вас позвали работать в чужой
        кабинет, просто откройте присланную ссылку — она всё настроит сама.</div>
        <label class="fieldlabel">Ссылка или код приглашения</label>
        <input class="field" id="invcode" placeholder="inv_…" autocapitalize="off" autocomplete="off">
        <button class="mini" data-act="useinvite">Войти по приглашению</button>
      </div>
    </main>
  `);
}

/**
 * Показ кабинета в поиске.
 *
 * Публикация выносит наружу имя врача и телефон, поэтому решение его, а не
 * платформы, и рядом — предпросмотр: ровно то, что увидят посторонние.
 */
async function docListing() {
  spinner('Загрузка…');
  const d = await api('/doctor/listing');
  // Множество, а не массив: отметки ставятся и снимаются по одной, и
  // хранить их списком значит каждый раз искать в нём индекс.
  d.specSet = new Set(d.specialties ?? []);
  S.d.listing = d;

  const draw = () => {
    const l = S.d.listing;
    const ready = l.city && l.address && l.phone;
    render(`
      <header><h1>Показ в поиске</h1></header>
      <main>
        <div class="card">
          <div class="note" style="margin:0">Пациент, пришедший без вашей ссылки,
          ищет стоматолога в приложении. Здесь вы решаете, показывать ли ему
          свой кабинет. Порядок в списке — по ближайшему свободному времени;
          платных мест нет.</div>
        </div>

        ${licenseCard(l)}

        <div class="sectiontitle">Чем вы занимаетесь</div>
        <div class="card">
          <div class="chips">
            ${(l.specialtyList ?? []).map((x) => `<button data-spec="${x.code}"
              class="${l.specSet.has(x.code) ? 'on' : ''}">${esc(x.nameRu)}</button>`).join('')}
          </div>
          <div class="note">Пациент ищет по этому, а не по названию кабинета.
          Отмечайте всё, что делаете.</div>
          <label class="fieldlabel">Имя врача — его увидят пациенты</label>
          <input class="field" id="ldoctor" value="${esc(l.doctor ?? '')}"
            placeholder="Каримов А.А." autocomplete="name">
        </div>
        <div class="card">
          <label class="fieldlabel">Город</label>
          <input class="field" id="lcity" value="${esc(l.city ?? '')}" placeholder="Ташкент">
          <label class="fieldlabel">Адрес</label>
          <input class="field" id="laddr" value="${esc(l.address ?? '')}" placeholder="ул. Амира Темура, 12">
          <label class="fieldlabel">Ориентир — необязательно</label>
          <input class="field" id="lland" value="${esc(l.landmark ?? '')}" placeholder="напротив Чорсу">
          <label class="fieldlabel">Телефон для пациентов</label>
          <input class="field" id="lphone" value="${esc(l.phone ?? '')}" placeholder="+998 __ ___ __ __" inputmode="tel">
          <div class="note">Без города, адреса и телефона показать кабинет нельзя:
          такая карточка не отвечает ни на один вопрос пациента.</div>
        </div>

        <div class="card">
          <div class="row"><span class="muted">Точка на карте</span>
            <span class="name">${l.lat != null ? 'отмечена' : 'не отмечена'}</span></div>
          <div class="note">Пациент ищет «кто ко мне ближе». Нажмите это,
          стоя в кабинете, — и он увидит расстояние до вас. ${l.lat != null
            ? 'Переехали — отметьте заново.'
            : 'Без точки кабинет всё равно найдётся по городу и адресу, просто не попадёт в ближайшие.'}</div>
          <button class="ghost" data-act="cabplace">${
            l.lat != null ? 'Отметить заново' : 'Кабинет здесь'}</button>
        </div>

        <div class="sectiontitle">Так вас увидят</div>
        <div class="stockrow" id="lpreview">${listingPreview()}</div>
      </main>
      <button class="primary ${l.listed ? 'danger' : ''}" data-act="savelisting"
        data-listed="${l.listed ? '0' : '1'}"
        ${!l.listed && (!ready || l.licenseStatus !== 'verified') ? 'disabled' : ''}>
        ${l.listed ? 'Убрать из поиска'
          : l.licenseStatus !== 'verified' ? 'Нужна проверенная лицензия'
          : ready ? 'Показывать в поиске' : 'Заполните город, адрес и телефон'}</button>
    `);
    // Ввод не вызывает перерисовку — иначе поле теряло бы фокус на каждой
    // букве. Поэтому состояние читается на каждый ввод, а меняются ровно две
    // вещи: подпись кнопки и предпросмотр. Без этого врач заполнял поля, а
    // кнопка оставалась «заполните город, адрес и телефон» навсегда.
    for (const id of ['lcity', 'laddr', 'lland', 'lphone']) {
      const el = document.getElementById(id);
      if (el) el.oninput = syncListing;
    }
  };
  S.d.redraw = () => { readListingForm(); draw(); };
  S.d.listing.specSet = d.specSet;
  draw();
}

/**
 * Лицензия.
 *
 * Стоит выше адреса и телефона намеренно: без неё остальное не имеет
 * смысла — кабинет в поиск всё равно не попадёт. Проверка сегодня ручная,
 * и врачу об этом сказано прямо: обещать мгновенный ответ, а отвечать через
 * час — худший из вариантов.
 */
function licenseCard(l) {
  const st = l.licenseStatus ?? 'none';
  const label = { none: 'не указана', pending: 'на проверке',
    verified: 'проверена', rejected: 'не подтверждена' }[st];
  return `
        <div class="card ${st === 'rejected' ? 'warn' : ''}">
          <div class="row"><span class="muted">Лицензия</span>
            <span class="name">${label}</span></div>
          ${st === 'verified' ? `<div class="row"><span class="muted">Номер</span>
            <span class="mono">${esc(l.licenseNumber ?? '')}</span></div>
            ${l.licenseValidUntil ? `<div class="row"><span class="muted">Действует до</span>
              <span class="mono">${dateLabel(l.licenseValidUntil)}</span></div>` : ''}` : ''}
          <div class="note">${
            st === 'verified'
              ? 'Мы сверили номер с реестром Минюста. Пациенты видят отметку «документы проверены» — это главный довод в вашу пользу против безымянных объявлений.'
              : st === 'pending'
                ? `Номер ${esc(l.licenseNumber ?? '')} принят и ждёт сверки с реестром. Обычно это занимает несколько часов; ответ придёт сюда, в чат.`
                : st === 'rejected'
                  ? esc(l.licenseNote || 'Номер не нашёлся в реестре. Проверьте и пришлите заново.')
                  : 'Чтобы попасть в поиск, назовите номер лицензии на медицинскую деятельность. Мы сверим его с реестром Минюста. Без поиска кабинет работает как обычно — по вашей ссылке.'}</div>
          ${st === 'verified' ? '' : `
          <label class="fieldlabel">Номер лицензии</label>
          <input class="field" id="licnum" value="${esc(l.licenseNumber ?? '')}"
            placeholder="47895138" inputmode="text" autocomplete="off">
          <label class="fieldlabel">СТИР или ЖШШИР — необязательно</label>
          <input class="field" id="lictin" value="${esc(l.licenseTin ?? '')}"
            placeholder="304638816" inputmode="numeric" autocomplete="off">
          <div class="note">СТИР ускоряет сверку: по нему запись в реестре
          находится, даже если номер записан иначе.</div>
          <button class="mini" data-act="sendlicense">${
            st === 'pending' ? 'Прислать другой номер' : 'Отправить на проверку'}</button>`}
        </div>`;
}

/**
 * Очередь проверки лицензий — экран владельца платформы.
 *
 * Ссылка ведёт в реестр Минюста с уже подставленным номером: решение
 * принимается по официальному источнику, а не по нашему списку. Программно
 * реестр закрыт (Turnstile), и обходить это нельзя — поэтому глазами.
 * Когда появится официальный доступ, экран останется, а сверка станет
 * автоматической.
 */
async function adminLicenses() {
  spinner('Загрузка…');
  const { pending } = await api('/admin/licenses');
  S.d.pending = pending;
  render(`
    <header><h1>Проверка лицензий</h1></header>
    <main>
      ${pending.length ? pending.map((x) => `
        <div class="card">
          <div class="row"><span class="name">${esc(x.name)}</span>
            <span class="muted">${dateLabel(String(x.submittedAt).slice(0, 10))}</span></div>
          <div class="row"><span class="muted">Врач</span>
            <span>${esc(x.doctor ?? '—')}</span></div>
          <div class="row"><span class="muted">Адрес</span>
            <span>${esc([x.city, x.address].filter(Boolean).join(', ') || '—')}</span></div>
          <div class="row"><span class="muted">Телефон</span>
            <span class="mono">${esc(x.phone ?? '—')}</span></div>
          <div class="row"><span class="muted">Лицензия</span>
            <span class="mono name">${esc(x.licenseNumber)}</span></div>
          ${x.licenseTin ? `<div class="row"><span class="muted">СТИР</span>
            <span class="mono">${esc(x.licenseTin)}</span></div>` : ''}
          <div class="note">Откройте реестр, найдите запись и посмотрите три вещи:
          вид деятельности — медицинская, состояние — действующая, срок — не истёк.</div>
          <button class="mini" data-open-registry="${esc(x.licenseNumber)}">Открыть реестр</button>
          <label class="fieldlabel">Действует до</label>
          <input class="field" type="date" id="lic-until-${x.tenantId}">
          <div class="picker" style="margin-top:12px">
            <button data-verdict="verified" data-tenant="${x.tenantId}">
              <div class="name">Подтвердить</div>
              <div class="price">кабинет сможет показываться в поиске</div></button>
            <button data-verdict="rejected" data-tenant="${x.tenantId}">
              <div class="name">Отклонить</div>
              <div class="price">спросим причину — врач её прочитает</div></button>
          </div>
        </div>`).join('')
      : `<div class="card"><div class="note" style="margin:0">Никто не ждёт проверки.
          Заявки появляются здесь, как только врач называет номер лицензии на
          экране «Показ в поиске».</div></div>`}
    </main>
  `);
}

/** Предпросмотр карточки: ровно то, что увидят посторонние. */
function listingPreview() {
  const l = S.d.listing ?? {};
  const place = [l.city, l.landmark || l.address].filter(Boolean).join(', ');
  return `<div class="body">
      <div class="name">${esc(l.name ?? 'Кабинет')}</div>
      <div class="muted">${esc(place || 'город и адрес не указаны')}</div>
      <div class="muted">Ближайшее время подставится само</div>
    </div>
    <div class="qty-val mono">${esc(l.phone || '—')}<small>телефон</small></div>`;
}

/** Кнопка и предпросмотр догоняют то, что уже набрано в полях. */
function syncListing() {
  readListingForm();
  const l = S.d.listing;
  const ready = Boolean(l.city && l.address && l.phone);
  const btn = document.querySelector('.primary[data-act="savelisting"]');
  if (btn) {
    btn.disabled = !ready && !l.listed;
    btn.textContent = l.listed ? 'Убрать из поиска'
      : ready ? 'Показывать в поиске' : 'Заполните город, адрес и телефон';
  }
  const prev = document.getElementById('lpreview');
  if (prev) prev.innerHTML = listingPreview();
}

function readListingForm() {
  const l = S.d.listing;
  if (!l) return;
  l.city = val('lcity'); l.address = val('laddr');
  l.landmark = val('lland'); l.phone = val('lphone');
  if (document.getElementById('ldoctor')) l.doctor = val('ldoctor');
  if (document.getElementById('licnum')) {
    l.licenseNumber = val('licnum'); l.licenseTin = val('lictin');
  }
}

/**
 * Создание кабинета.
 *
 * Спрашиваем ровно то, без чего нельзя начать: как называется кабинет и
 * какая специализация. Всё остальное — часы, услуги, цены — врач правит
 * потом, увидев уже работающий кабинет, а не заполняя анкету вслепую.
 */
async function newCabinet() {
  spinner('Загрузка…');
  const { templates, specialties } = await api('/onboarding/templates');
  // Специализаций может быть несколько; справочник один. Раньше это была
  // одна кнопка, и врач, ставящий коронки, записывался терапевтом только
  // потому, что с этого справочника начинал.
  S.d.reg = {
    template: templates[0]?.code ?? 'therapist',
    specialties: new Set([templates[0]?.specialty ?? 'therapist']),
    specList: specialties ?? [],
    templates,
  };

  const draw = () => render(`
    <header><h1>Новый кабинет</h1></header>
    <main>
      <div class="card">
        <label class="fieldlabel">Название кабинета</label>
        <input class="field" id="cabname" placeholder="Стоматология на Амира Темура"
          autocomplete="organization" maxlength="80">
        <div class="note">Имя врача для пациентов возьмём из вашего профиля:
        ${esc(S.d.me?.fullName || 'вы его уже указали')}. Поменять можно в
        «Показе в поиске».</div>
      </div>

      <div class="sectiontitle">Чем вы занимаетесь</div>
      <div class="card">
        <div class="chips">
          ${(S.d.reg.specList).map((x) => `<button data-spec="${x.code}"
            class="${S.d.reg.specialties.has(x.code) ? 'on' : ''}">${esc(x.name_ru)}</button>`).join('')}
        </div>
        <div class="note">Отмечайте всё, что делаете — пациент ищет по этому.
        Список правится когда угодно.</div>
      </div>

      ${templates.length > 1 ? `<div class="sectiontitle">С какого справочника начать</div>
      <div class="card">
        <div class="chips">
          ${templates.map((t) => `<button data-tpl="${t.code}"
            class="${S.d.reg.template === t.code ? 'on' : ''}">${esc(t.name_ru)}</button>`).join('')}
        </div>
        <div class="note">Справочник — это материалы, техкарты и стартовые
        цены. Всё это потом правится под себя: норм расхода «как у всех»
        не бывает.</div>
      </div>` : `<div class="card">
        <div class="note" style="margin:0">Справочник материалов, техкарт и
        стартовых цен подставим терапевтический — он общий для большинства
        приёмов. Всё в нём правится под себя, а недостающее вы добавите:
        норм расхода «как у всех» не бывает.</div>
      </div>`}

      <div class="card">
        <div class="note" style="margin:0">Сначала покажем кабинет на выдуманных
        приёмах, чтобы было понятно, где что. Когда закончите знакомство,
        выдуманное сотрётся, а справочник останется.</div>
      </div>
    </main>
    <button class="primary" data-act="docreate">Создать кабинет</button>
  `);
  S.d.redraw = draw;
  draw();
  setTimeout(() => document.getElementById('cabname')?.focus(), 80);
}

/* ── Знакомство с кабинетом ────────────────────────────────────────────
   Не всплывающие подсказки поверх экранов — они ломаются от любой правки
   вёрстки и мешают работать. Список шагов: что посмотреть и зачем. */

const TOUR = [
  { k: 'calendar',  name: 'Календарь',  why: 'занятое и свободное время одной лентой' },
  { k: 'visit',     name: 'Приём',      why: 'откройте любой прошлый — там себестоимость' },
  { k: 'stock',     name: 'Склад',      why: 'списание идёт само, кнопки «списать» нет' },
  { k: 'techcards', name: 'Техкарты',   why: 'нормы расхода, которые вы правите под себя' },
  { k: 'margin',    name: 'Сверх материалов', why: 'какая услуга съедает расходники' },
  { k: 'link',      name: 'Ссылка для пациентов', why: 'по ней записываются сами' },
  { k: 'record',    name: 'Карта пациента', why: 'лечение уходит вместе с человеком — этого нет ни у кого' },
];

/**
 * Открыть раздел, о котором идёт шаг.
 *
 * Раньше знакомство только называло разделы, а искать их врач должен был сам:
 * нажал «что дальше» — получил тот же список из шести пунктов, и всё. Список
 * дел вместо показа. Теперь каждый шаг — кнопка, которая ведёт куда сказано.
 */
async function tourGo(key) {
  const tab = (k) => TABS.findIndex((t) => t.k === k);
  if (key === 'calendar') return goTab(tab('calendar'));
  if (key === 'stock') return goTab(tab('stock'));
  if (key === 'techcards') return go(docTechcards);
  if (key === 'margin') return go(docMargin);
  if (key === 'link') return go(docLink);
  if (key === 'record') {
    // Карта открыта, пока пациент записан или приём не закрыт, — значит и
    // показывать её на знакомстве надо на том, у кого запись есть.
    spinner('Ищем пациента…');
    const { patients } = await api('/doctor/patients');
    for (const who of patients ?? []) {
      const card = await api(`/doctor/patients/${who.id}`);
      const open = card.visits.some((v) => v.status === 'open')
        || card.appointments.some((a) => a.status === 'scheduled'
          && new Date(a.startsAt).getTime() > Date.now() - 864e5);
      if (!open) continue;
      S.d.patient = { ...card, id: who.id };
      return go(docRecord, who.id);
    }
    return toast('Карта открывается, когда пациент записан. Запишите кого-нибудь — и вернитесь', true);
  }
  if (key === 'visit') {
    // «Откройте любой прошлый приём» — открываем сами: на знакомстве врач не
    // обязан догадываться, что приёмы лежат внутри карточки пациента.
    spinner('Ищем приём…');
    const { patients } = await api('/doctor/patients');
    const who = (patients ?? []).find((x) => x.visits > 0);
    if (!who) return toast('Закрытых приёмов пока нет — этот шаг будет позже', true);
    const card = await api(`/doctor/patients/${who.id}`);
    const v = (card.visits ?? []).find((x) => x.status === 'closed') ?? (card.visits ?? [])[0];
    if (!v) return toast('У пациента нет приёмов', true);
    return go(docVisit, v.id);
  }
}

function tourCard() {
  const ob = S.d.me?.onboarding;
  if (!ob?.active) return '';
  const seen = new Set(ob.seen ?? []);
  const next = TOUR.find((t) => !seen.has(t.k));
  const done = TOUR.length - TOUR.filter((t) => !seen.has(t.k)).length;
  return `<div class="card warn">
    <div class="row"><span class="name">Знакомство с кабинетом</span>
      <span class="mono">${done} из ${TOUR.length}</span></div>
    ${next
      ? `<div class="note" style="margin-top:6px"><b>${esc(next.name)}</b> — ${esc(next.why)}</div>`
      : `<div class="note" style="margin-top:6px">Вы посмотрели всё. Можно убирать
         выдуманные приёмы и заводить свои цены.</div>`}
    ${next
      ? `<button class="mini" data-tourgo="${next.k}">Открыть «${esc(next.name)}»</button>
         <button class="mini" data-act="tour">Все шаги</button>`
      : `<button class="mini" data-act="tour">Завершить знакомство</button>`}
  </div>`;
}

function tourScreen() {
  const ob = S.d.me?.onboarding ?? { seen: [] };
  const seen = new Set(ob.seen ?? []);
  const left = TOUR.filter((t) => !seen.has(t.k));
  render(`
    <header><h1>Знакомство</h1>
      </header>
    <main>
      <div class="picker">
        ${TOUR.map((t) => `<button data-tourgo="${t.k}">
          <div class="name">${seen.has(t.k) ? '✓ ' : ''}${esc(t.name)}</div>
          <div class="price">${esc(t.why)}</div>
        </button>`).join('')}
      </div>
      ${left.length ? `<div class="card">
        <div class="note" style="margin:0">Пройдите разделы — приложение отметит
        их само, когда вы их откроете.</div>
      </div>` : ''}
      <div class="card warn">
        <div class="name">Что произойдёт по кнопке ниже</div>
        <div class="note" style="margin-top:6px">Выдуманные пациенты, записи, приёмы
        и партии на складе будут стёрты — все сразу и без возврата. Справочник,
        техкарты и цены останутся: их вы дальше сверите со своими.${left.length
          ? '<br><br>Вы ещё не смотрели: ' + left.map((t) => esc(t.name)).join(', ')
            + '. После стирания показывать их будет не на чем — склад и календарь опустеют.'
          : ''}</div>
      </div>
    </main>
    <button class="primary danger" data-act="finishtour">
      Стереть выдуманное и начать работу</button>
  `);
}

/** Экран после очистки: что проверить, прежде чем звать пациентов. */
function afterTour(wiped) {
  render(`
    <header><h1>Кабинет ваш</h1></header>
    <main>
      <div class="card ok">
        <div class="note" style="margin:0">Стёрто: ${wiped.visits} приёмов,
        ${wiped.appointments} записей, ${wiped.patients} пациентов, ${wiped.batches} партий.
        Материалы, техкарты и услуги остались.</div>
      </div>
      <div class="sectiontitle">Что проверить до первого пациента</div>
      <div class="picker">
        <button data-act="stock"><div class="name">Закупочные цены материалов</div>
          <div class="price">без них себестоимость будет приблизительной</div></button>
        <button data-act="techcards"><div class="name">Нормы расхода</div>
          <div class="price">у каждого врача свои — стартовые снятые с практики</div></button>
        <button data-act="schedule"><div class="name">Рабочие часы</div>
          <div class="price">сейчас будни 09–13 и 14–18</div></button>
      </div>
      <div class="card">
        <div class="note" style="margin:0">Склад пуст: оприходуйте то, что реально
        лежит в кабинете. Пока материала нет, приём закроется, но покажет
        недостачу вместо себестоимости.</div>
      </div>
    </main>
    <button class="primary" data-act="reviewed">Я всё сверил</button>
  `);
}


/** Переключатель: показывается только тому, у кого есть членство. */
function switcher() {
  const me = S.d.me;
  render(`
    <header><h1>Режим</h1></header>
    <main>
      <div class="picker">
        <button data-mode="patient" class="${me.mode === 'patient' ? 'on' : ''}">
          <div class="name">Я пациент</div>
          <div class="price">${me.patientOf.length
            ? `записи в ${me.patientOf.length === 1 ? 'кабинете' : `${me.patientOf.length} кабинетах`}`
            : 'записаться к врачу'}</div></button>
        ${me.staffOf.map((c) => `<button data-mode="doctor" data-tenant="${c.tenantId}"
          class="${me.mode === 'doctor' && me.tenantId === c.tenantId ? 'on' : ''}">
          <div class="name">${esc(c.name)}</div>
          <div class="price">${c.role === 'owner' ? 'мой кабинет' : 'я здесь работаю'}</div></button>`).join('')}
      </div>
    </main>
  `);
}

/* ══════════════════════════════════════════════════════════════════════════
   ВРАЧ — календарь
   ══════════════════════════════════════════════════════════════════════════ */

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/**
 * Неделя врача.
 *
 * Данные недели приезжают ОДИН раз. Раньше выбор дня заново дёргал сервер и
 * перерисовывал весь экран через заставку «Загрузка расписания…» — на экране
 * рывком менялось всё, включая шапку и полосу дней, по которой только что
 * ткнули пальцем. Неделя уже лежит в памяти: смена дня — это выбор из
 * загруженного, а не новый запрос.
 */
async function docWeek(weekStart) {
  const start = weekStart ?? S.d.weekStart ?? localDate();
  if (!S.d.cal || S.d.weekStart !== start) {
    S.d.weekStart = start;
    spinner('Загрузка расписания…');
    S.d.cal = await api(`/doctor/calendar?from=${start}&to=${addDays(start, 6)}`);
    S.d.selectedDay = null;
  }
  // Если сегодня выходной — открываем ближайший рабочий день, а не пустой
  // экран с надписью «выходной». Врач, создавший кабинет в субботу, первым
  // делом видел пустоту и решал, что кабинет не работает.
  if (!S.d.selectedDay) {
    const today = localDate();
    for (let i = 0; i < 7; i += 1) {
      const day = addDays(start, i);
      if (day < today) continue;
      if (!dayInfo(day).closed) { S.d.selectedDay = day; break; }
    }
  }
  drawWeek();
}

/** Что известно про день: выходной или рабочие интервалы. */
function dayInfo(date) {
  const cal = S.d.cal;
  const ov = cal.overrides.find((o) => o.on_date === date);
  if (ov?.is_closed) return { closed: true, label: ov.reason || 'выходной' };
  if (ov) return { closed: false, hours: [{ starts_at: ov.starts_at, ends_at: ov.ends_at }] };
  const wd = new Date(`${date}T12:00:00+05:00`).getDay();
  const hrs = cal.workingHours.filter((h) => h.weekday === wd);
  return hrs.length ? { closed: false, hours: hrs } : { closed: true, label: 'выходной' };
}

const dayAppts = (date) => S.d.cal.appointments
  .filter((a) => a.startsAt.slice(0, 10) === date && a.status !== 'cancelled')
  .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

/**
 * Свободные окна дня. «Когда я свободен» — вопрос при каждом звонке;
 * считать это в уме по списку занятого времени врач не должен.
 */
function dayGaps(date, info) {
  if (info.closed || date < localDate()) return [];
  const ms = (t) => new Date(`${date}T${t.slice(0, 5)}:00+05:00`).getTime();
  // Окно короче самой короткой услуги занять нечем — показывать его значит
  // засорять ленту тем, с чем всё равно ничего не сделать.
  const minGap = (S.d.cal.minServiceMinutes ?? 20) * 60000;
  const busy = dayAppts(date)
    .filter((a) => a.status !== 'no_show')
    .map((a) => [new Date(a.startsAt).getTime(), new Date(a.endsAt).getTime()])
    .sort((x, y) => x[0] - y[0]);
  const gaps = [];
  for (const h of info.hours) {
    let cursor = Math.max(ms(h.starts_at), date === localDate() ? Date.now() : 0);
    const end = ms(h.ends_at);
    for (const [bs, be] of busy) {
      if (be <= cursor || bs >= end) continue;
      if (bs - cursor >= minGap) gaps.push([cursor, bs]);
      cursor = Math.max(cursor, be);
    }
    if (end - cursor >= minGap) gaps.push([cursor, end]);
  }
  return gaps;
}

/** Лента дня: занятое и свободное одной хронологией, а не двумя списками. */
function dayListHtml(date) {
  const info = dayInfo(date);
  const entries = [
    ...dayAppts(date).map((a) => ({ at: new Date(a.startsAt).getTime(), appt: a })),
    ...dayGaps(date, info).map(([from, to]) => ({ at: from, gap: [from, to] })),
  ].sort((x, y) => x.at - y.at);

  if (!entries.length) {
    // «Выходной» уже стоит подзаголовком дня — второй раз в теле это не
    // сообщение, а эхо. Здесь говорим то, чего наверху нет.
    return `<div class="empty">${info.closed
      ? 'В этот день вы не принимаете. Можно открыть его разово в рабочих часах.'
      : 'На этот день записей нет'}</div>`;
  }

  return entries.map((e) => {
    if (e.gap) {
      const [from, to] = e.gap;
      return `<div class="slot free" data-free="${new Date(from).toISOString()}">
        <div class="time mono">${hhmm(new Date(from).toISOString())}<small>${hhmm(new Date(to).toISOString())}</small></div>
        <div class="body"><div class="name">Свободно</div>
          <div class="muted">${humanMins(Math.round((to - from) / 60000))}</div></div>
        <div class="mark">+</div>
      </div>`;
    }
    const a = e.appt;
    const blocked = a.patient === '— занято —';
    const past = new Date(a.endsAt).getTime() < Date.now();
    const unresolved = past && a.status === 'scheduled' && !a.visitId && !blocked;
    // Молчание засчитываем только тем, кого спрашивали. Напоминание уходит
    // за сутки, поэтому раньше чем за 23 часа отметки быть не может, а тому,
    // у кого нет бота, её негде и нажать.
    const silent = !past && !blocked && a.status === 'scheduled' && a.reachable && !a.confirmed
      && new Date(a.startsAt).getTime() - Date.now() < 23 * 3600e3;
    return `<div class="slot ${blocked ? 'blocked' : ''} ${a.visitStatus === 'closed' ? 'done' : ''} ${
      a.status === 'no_show' ? 'noshow' : ''} ${a.source === 'patient_link' ? 'mine' : ''}" data-appt="${a.id}">
      <div class="time mono">${hhmm(a.startsAt)}<small>${hhmm(a.endsAt)}</small></div>
      <div class="body">
        <div class="name">${esc(blocked ? (a.note || 'Занято') : a.patient)}</div>
        <div class="muted">${esc(a.service ?? (blocked ? 'время недоступно' : 'услуга не выбрана'))}${
          a.source === 'patient_link' ? ' · записался сам' : ''}${
          a.status === 'no_show' ? ' · не пришёл' : ''}${
          unresolved ? ' · <b>не отмечен</b>' : ''}${
          a.confirmed ? ' · придёт' : silent ? ' · <b>не подтвердил</b>' : ''}</div>
      </div>
      <div class="mark ${unresolved ? 'todo' : ''}">${
        a.visitStatus === 'closed' ? '✓' : a.visitId ? '·' : unresolved ? '!' : ''}</div>
    </div>`;
  }).join('');
}

function dayHeadHtml(date) {
  const info = dayInfo(date);
  const free = dayGaps(date, info).reduce((s, [a, b]) => s + (b - a), 0) / 60000;
  return `${info.closed ? esc(info.label)
    : info.hours.map((h) => `${h.starts_at.slice(0, 5)}–${h.ends_at.slice(0, 5)}`).join(' · ')}${
    free ? ` · свободно ${humanMins(Math.round(free))}` : ''}`;
}

function dayChipsHtml(days, sel) {
  return days.map((d) => {
    const n = dayAppts(d).length;
    const off = dayInfo(d).closed;
    return `<button class="daychip ${d === sel ? 'on' : ''} ${off ? 'off' : ''} ${d === localDate() ? 'today' : ''}"
      data-day="${d}" aria-pressed="${d === sel}" aria-label="${esc(dateLabel(d))}">
      <span class="dw">${WEEKDAYS[new Date(`${d}T12:00:00+05:00`).getDay()]}</span>
      <span class="dn">${dayNum(d)}</span>
      <span class="dd">${off ? '·' : n || ''}</span>
    </button>`;
  }).join('');
}

function drawWeek() {
  markSeen('calendar');
  const start = S.d.weekStart;
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  if (!days.includes(S.d.selectedDay)) {
    S.d.selectedDay = days.includes(localDate()) ? localDate() : days[0];
  }
  const sel = S.d.selectedDay;

  render(`
    <header>
      <h1 id="daytitle">${dateLabel(sel, { day: 'numeric', month: 'long', weekday: 'long' })}</h1>
      <div class="acts">
        <button class="mini" data-act="block">Занять время</button>
        <button class="mini" data-act="walkin">Без записи</button>
      </div>
    </header>
    <div class="weeknav">
      <button data-week="-7" aria-label="Предыдущая неделя">‹</button>
      <span class="label">${dateLabel(start, { day: 'numeric', month: 'short' })} — ${dateLabel(addDays(start, 6), { day: 'numeric', month: 'short' })}</span>
      <button data-week="7" aria-label="Следующая неделя">›</button>
    </div>
    <div class="weekstrip" id="daystrip">${dayChipsHtml(days, sel)}</div>
    <div class="dayhead" id="dayhead">${dayHeadHtml(sel)}</div>
    <main id="daylist">${tourCard()}${dayListHtml(sel)}</main>
  `);
}

/**
 * Выбор дня без запроса и без перерисовки экрана.
 *
 * Меняются только полоса дней и лента; заголовок переписывается на месте.
 * Лента въезжает со стороны, в которую двинулись, — направление говорит,
 * вперёд по календарю мы пошли или назад.
 */
function selectDay(day) {
  const list = document.getElementById('daylist');
  const prev = S.d.selectedDay;
  S.d.selectedDay = day;
  if (!list) return drawWeek();

  const days = Array.from({ length: 7 }, (_, i) => addDays(S.d.weekStart, i));
  document.getElementById('daystrip').innerHTML = dayChipsHtml(days, day);
  document.getElementById('daytitle').textContent =
    dateLabel(day, { day: 'numeric', month: 'long', weekday: 'long' });
  document.getElementById('dayhead').innerHTML = dayHeadHtml(day);

  list.className = day > prev ? 'slide-l' : day < prev ? 'slide-r' : '';
  list.innerHTML = dayListHtml(day);
}

/* ── Занять время: экран с проверкой конфликтов ──────────────────────── */

async function docBlock() {
  const day = S.d.selectedDay ?? localDate();
  S.d.block = { date: day, from: '13:00', to: '14:00', reason: '', conflicts: null };

  const draw = () => {
    const b = S.d.block;
    const conflictBlock = b.conflicts === null ? '' : b.conflicts.length === 0
      ? '<div class="card ok"><div class="name">Время свободно</div><div class="muted">Никого отменять не придётся.</div></div>'
      : `<div class="card warn">
          <div class="name">На это время записаны ${b.conflicts.length}</div>
          ${b.conflicts.map((c) => `<div class="row">
            <span>${esc(c.patient)}<br><span class="muted">${esc(c.service ?? 'без услуги')} · ${hhmm(c.startsAt)}</span></span>
            <span class="badge ${c.notifiable ? 'open' : 'warn'}">${c.notifiable ? 'напишем' : 'позвонить'}</span>
          </div>`).join('')}
          <label class="fieldlabel">Причина отмены — её увидит пациент</label>
          <textarea class="field" id="creason" placeholder="Например: врач заболел, переносим на завтра">${esc(b.reason)}</textarea>
          <div class="note">Пациенту уйдёт сообщение с причиной. Тем, кто записывался
          не через Telegram, придётся позвонить — их телефоны показаны выше.</div>
        </div>`;

    render(`
      <header><h1>Занять время</h1></header>
      <main>
        <div class="card">
          <label class="fieldlabel">Дата</label>
          <input class="field" type="date" id="bdate" value="${b.date}" min="${localDate()}">
          <label class="fieldlabel">С</label>
          <input class="field" type="time" id="bfrom" value="${b.from}" step="900">
          <label class="fieldlabel">До</label>
          <input class="field" type="time" id="bto" value="${b.to}" step="900">
          <label class="fieldlabel">Пометка для себя</label>
          <input class="field" id="bnote" placeholder="Обед" value="${esc(b.note ?? '')}">
        </div>
        ${conflictBlock}
      </main>
      <button class="primary" data-act="${b.conflicts === null ? 'checkblock' : 'doblock'}">
        ${b.conflicts === null ? 'Проверить время' : b.conflicts.length ? 'Отменить записи и занять' : 'Занять время'}
      </button>
    `);
  };
  S.d.redraw = draw;
  draw();
}

function readBlockForm() {
  const b = S.d.block;
  b.date = val('bdate') || b.date;
  b.from = val('bfrom') || b.from;
  b.to = val('bto') || b.to;
  b.note = val('bnote');
  const r = document.getElementById('creason');
  if (r) b.reason = r.value.trim();
  return b;
}

/* ── Приём без записи ────────────────────────────────────────────────── */

async function docWalkIn() {
  const { services } = await api('/doctor/services');
  S.d.walkin = { serviceId: null };
  const draw = () => render(`
    <header><h1>Приём без записи</h1></header>
    <main>
      <div class="card">
        <label class="fieldlabel">Имя пациента</label>
        <input class="field" id="wname" placeholder="Как зовут" autocomplete="name">
        <label class="fieldlabel">Телефон — необязательно</label>
        <input class="field" id="wphone" placeholder="+998 __ ___ __ __" inputmode="tel" autocomplete="tel">
        <div class="note">Телефон нужен, чтобы при следующем визите не заводить
        карточку заново и чтобы было куда позвонить.</div>
      </div>
      <div class="sectiontitle">Услуга — можно выбрать позже</div>
      <div class="chips">
        ${services.map((s) => `<button data-wsvc="${s.id}" class="${S.d.walkin.serviceId === s.id ? 'on' : ''}">${esc(s.name_ru)}</button>`).join('')}
      </div>
    </main>
    <button class="primary" data-act="dowalkin">Начать приём</button>
  `);
  S.d.redraw = draw;
  draw();
  setTimeout(() => document.getElementById('wname')?.focus(), 80);
}

/* ── Запись и её отмена ──────────────────────────────────────────────── */

function docAppointment(apptId) {
  const a = (S.d.cal?.appointments ?? []).find((x) => x.id === apptId);
  if (!a) return docWeek();
  if (a.visitId) return docVisit(a.visitId);
  S.d.appt = a;

  const blocked = a.patient === '— занято —';
  const past = new Date(a.endsAt).getTime() < Date.now();
  render(`
    <header><h1>${esc(blocked ? 'Занятое время' : a.patient)}</h1>
      </header>
    <main>
      <div class="card">
        ${a.service ? `<div class="row"><span class="muted">Записан на</span><span class="name">${esc(a.service)}</span></div>` : ''}
        ${a.price ? `<div class="row"><span class="muted">Стоимость</span><span class="mono">${money(a.price)} сум</span></div>` : ''}
        ${a.phone ? `<div class="row"><span class="muted">Телефон</span><a href="tel:${esc(a.phone)}" class="tel">${esc(a.phone)}</a></div>` : ''}
        ${a.note ? `<div class="row"><span class="muted">${blocked ? 'Пометка' : 'Повод'}</span><span>${esc(a.note)}</span></div>` : ''}
        ${a.source === 'patient_link' ? '<div class="badge open" style="margin-top:8px">записался сам через ссылку</div>' : ''}
      </div>
      <div class="picker">
        ${blocked ? '' : `<button data-act="startvisit"><div class="name">Начать приём</div>
          <div class="price">создать визит и подставить услугу</div></button>
        ${past ? `<button data-act="noshow"><div class="name">Не пришёл</div>
          <div class="price">время освободится, отмена пациенту не уйдёт</div></button>`
        : `<button data-act="remind"><div class="name">Напомнить сейчас</div>
          <div class="price">автоматически напомним за сутки и за два часа</div></button>`}
        <button data-patient="${a.patientId}"><div class="name">Карточка пациента</div>
          <div class="price">что делали раньше, телефон, заметки</div></button>`}
        <button data-act="tocancel"><div class="name">${blocked ? 'Освободить время' : 'Отменить запись'}</div>
          <div class="price">${blocked ? 'слот снова станет доступен' : 'пациент получит сообщение с причиной'}</div></button>
      </div>
    </main>
  `);
}

function docCancel() {
  const a = S.d.appt;
  const blocked = a.patient === '— занято —';
  render(`
    <header><h1>${blocked ? 'Освободить время' : 'Отмена записи'}</h1>
      </header>
    <main>
      <div class="card">
        <label class="fieldlabel">Причина${blocked ? '' : ' — её увидит пациент'}</label>
        <textarea class="field" id="xreason" placeholder="${blocked ? 'Освобождаю' : 'Например: заболел, переношу на другой день'}"></textarea>
        ${blocked ? '' : `<div class="chips">
          ${['Врач заболел', 'Срочная замена', 'Перенос по просьбе пациента', 'Оборудование не работает']
            .map((r) => `<button data-reason="${esc(r)}">${esc(r)}</button>`).join('')}
        </div>`}
        ${blocked ? '' : `<div class="note">Сообщение уйдёт в Telegram сразу после отмены.
        Если пациент записывался не через бота, приложение покажет его телефон — позвоните.</div>`}
      </div>
    </main>
    <button class="primary" data-act="docancel">${blocked ? 'Освободить' : 'Отменить запись'}</button>
  `);
}

/* ── Приём и себестоимость ───────────────────────────────────────────── */

async function docVisit(visitId) {
  spinner('Загрузка приёма…');
  // Приём берётся по идентификатору, а не выискивается в ленте дня: иначе
  // вчерашний приём открыть нельзя, а именно его чаще всего и открывают.
  const [{ visit: v }, { services }] = await Promise.all([
    api(`/doctor/visits/${visitId}`), api('/doctor/services'),
  ]);
  if (v.status === 'closed') return docBreakdown(visitId, v);
  S.d.services = services;
  S.d.visitId = visitId;
  S.d.visit = v;

  render(`
    <header><h1>${esc(v.patient)}</h1></header>
    <main>
      ${v.services.length ? `<div class="card">
        ${v.services.map((s) => `<div class="service-line">
          <span>${esc(s.name)}${s.quantity > 1 ? ` × ${s.quantity}` : ''}
            <button class="mini tooth-chip" data-vsvc="${s.id}">${
              (s.teeth ?? []).length
                ? `${(s.teeth ?? []).length > 1 ? 'зубы' : 'зуб'} ${esc((s.teeth ?? []).join(', '))}`
                : '+ зуб'}</button></span>
          <span class="mono">${money(s.price)}</span></div>`).join('')}
        <div class="row" style="margin-top:8px"><span class="muted">Выручка</span><span class="mono name">${money(v.revenue)}</span></div>
      </div>` : '<div class="sectiontitle">Что делали</div>'}
      <div class="picker">
        ${services.map((s) => `<button data-service="${s.id}">
          <div class="name">${esc(s.name_ru)}</div>
          <div class="price">${money(s.price)} сум${s.unit_of_norm === 'canal' ? ' · за канал' : s.unit_of_norm === 'surface' ? ' · за поверхность' : ''}</div>
        </button>`).join('')}
      </div>
    </main>
    ${v.services.length ? '<button class="primary" data-act="close">Готово</button>' : ''}
  `);
}

/**
 * Внести оказанную услугу и вернуться к приёму.
 *
 * Одна функция на все три пути (без зуба, один зуб, несколько): раньше
 * каждый путь сам считал, сколько экранов снять со стека, — и ошибиться
 * там было проще, чем заметить.
 */
async function addVisitService(service, quantity, teeth) {
  await api(`/doctor/visits/${S.d.visitId}/services`, {
    method: 'POST',
    body: JSON.stringify({ serviceId: service.id, quantity: Math.max(1, quantity), teeth }),
  });
  // Снимаем со стека всё, что открывали ради этой услуги, и возвращаемся
  // к приёму: количество и карта зубов позади, шага «назад» к ним нет.
  while (S.stack.length > 1 && S.stack[S.stack.length - 1][0] !== docVisit) S.stack.pop();
  return docVisit(S.d.visitId);
}

function docQuantity(service) {
  S.d.picked = service;
  S.d.quantity = 1;
  const words = { canal: 'каналов', surface: 'поверхностей', tooth: 'зубов', jaw: 'челюстей', session: 'сеансов' };
  const draw = () => render(`
    <header><h1>${esc(service.name_ru)}</h1></header>
    <main><div class="card">
      <div class="qty">
        <button data-q="-" aria-label="Меньше">−</button>
        <span class="val mono">${S.d.quantity}</span>
        <button data-q="+" aria-label="Больше">+</button>
      </div>
      <div class="row" style="margin-top:16px"><span class="muted">К оплате</span>
        <span class="mono name">${money(service.price * S.d.quantity)} сум</span></div>
      ${service.unit_of_norm === 'canal' ? `<div class="note">Расходники канала считаются на каждый канал.
      Анестезия, перчатки и изоляция — один раз на приём, сколько бы каналов ни было.</div>` : ''}
    </div></main>
    <button class="primary" data-act="addservice">Добавить</button>
  `);
  S.d.redraw = draw;
  draw();
}

async function docBreakdown(visitId, known) {
  markSeen('visit');
  spinner('Считаем себестоимость…');
  const [{ lines, snapshot, reconciles }, detail] = await Promise.all([
    api(`/doctor/visits/${visitId}/cost-breakdown`),
    known ? Promise.resolve({ visit: known }) : api(`/doctor/visits/${visitId}`),
  ]);
  const v = detail.visit;
  const cost = snapshot ? Number(snapshot.materials_total) : 0;
  const margin = v.revenue - cost;
  render(`
    <header><h1>${esc(v.patient)}</h1>
      </header>
    <main>
      ${v.services?.length ? `<div class="card">
        ${v.services.map((s) => `<div class="service-line"><span>${esc(s.name)}${
          (s.teeth ?? []).length ? ` · ${(s.teeth ?? []).length > 1 ? 'зубы' : 'зуб'} ${esc((s.teeth ?? []).join(', '))}` : ''}${
          s.quantity > 1 ? ` × ${s.quantity}` : ''}</span><span class="mono">${money(s.price)}</span></div>`).join('')}
      </div>` : ''}
      <div class="card">
        <div class="row"><span class="muted">Выручка</span><span class="mono">${money(v.revenue)}</span></div>
        <div class="row"><span class="muted">Материалы</span><span class="mono">${money(cost)}</span></div>
        <div class="row" style="margin-top:8px"><span class="name">Сверх материалов</span>
          <span class="mono ${margin >= 0 ? 'margin-pos' : 'margin-neg'}" style="font-size:21px">${money(margin)}</span></div>
        ${snapshot?.has_unpriced ? `<div class="badge warn" style="margin-top:10px">не полностью: ${snapshot.unpriced_lines_count} позиций без цены</div>` : ''}
        ${reconciles === false ? '<div class="badge overdue" style="margin-top:10px">расхождение с движениями</div>' : ''}
        <div class="note">Не включены зарплата, аренда, амортизация и налоги.</div>
      </div>
      <div class="sectiontitle">Из чего сложилась</div>
      <div class="card"><table>
        <thead><tr><th>Материал</th><th>Кол-во</th><th>Сумма</th></tr></thead>
        <tbody>${lines.map((l) => `<tr>
          <td>${esc(l.material)}${l.kind === 'shortfall' ? ' <span class="badge warn">нет на складе</span>' : ''}</td>
          <td class="mono">${qtyFmt(l.qty)}</td>
          <td class="mono">${l.unpriced ? '<span class="muted">нет цены</span>' : money(l.cost)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="picker" style="margin-top:8px">
        <button data-patient="${v.patientId}"><div class="name">Карточка пациента</div>
          <div class="price">история приёмов, телефон, заметки</div></button>
      </div>
    </main>
  `);
}

/* ══════════════════════════════════════════════════════════════════════════
   ВРАЧ — пациенты
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * База пациентов. Самый частый вопрос стоматолога — не «сколько я заработал»,
 * а «кто это и что я ему делал в прошлый раз». Без этого экрана приложение
 * остаётся калькулятором себестоимости, а не рабочим местом.
 */
async function docPatients(query = '') {
  // Кэшируется только пустой запрос: результаты поиска живут одно нажатие.
  const { patients } = query
    ? await api(`/doctor/patients?q=${encodeURIComponent(query)}`)
    : await tabData('patients', () => api('/doctor/patients'), 'Загрузка пациентов…');
  S.d.pquery = query;

  const draw = () => render(`
    <header><h1>Пациенты</h1></header>
    <main>
      ${query ? '' : tourCard()}
      <div class="card">
        <input class="field" id="psearch" placeholder="Имя или телефон" value="${esc(query)}"
          inputmode="search" enterkeyhint="search" autocomplete="off">
      </div>
      ${patients.length ? `<div class="card">${patients.map((p) => `
        <div class="stockrow" data-patient="${p.id}">
          <div class="body">
            <div class="name">${esc(p.name)}</div>
            <div class="muted">${p.nextAt
              ? `<b>записан ${dateLabel(p.nextAt.slice(0, 10), { day: 'numeric', month: 'short' })}, ${hhmm(p.nextAt)}</b>`
              : p.lastVisit ? `был ${dateLabel(p.lastVisit)}` : 'ещё не приходил'}${
              p.visits > 1 ? ` · ${p.visits} приёма` : ''}
              ${/* Тёзки в базе — обычное дело, различает их телефон. */ ''}
              ${p.phone ? `<br>${esc(p.phone)}` : '<br>телефона нет'}</div>
          </div>
          ${p.visits ? `<div class="qty-val mono">${money(p.totalRevenue)}<small>сум</small></div>`
            : '<div class="qty-val mono"><small>новый</small></div>'}
        </div>`).join('')}</div>`
      : `<div class="empty">${query ? 'Никого не нашлось.' : 'Пациентов пока нет.'}</div>`}
    </main>
  `);
  draw();

  const input = document.getElementById('psearch');
  let t;
  input?.addEventListener('input', () => {
    clearTimeout(t);
    // Поиск по мере ввода, но не на каждую букву: с телефона это десяток
    // лишних запросов на одно имя.
    t = setTimeout(() => {
      const q = input.value.trim();
      if (q !== S.d.pquery) { S.stack[S.stack.length - 1] = [docPatients, [q]]; docPatients(q); }
    }, 350);
  });
}

async function docPatient(patientId) {
  spinner('Загрузка карточки…');
  // План и деньги — тем же заходом: врач смотрит на них вместе с историей,
  // а не отдельным путешествием по разделам.
  // Имя переменной НЕ money: так называется форматтер чисел, и локальная
  // переменная перекрыла бы его внутри всей функции.
  const [p, fin] = await Promise.all([
    api(`/doctor/patients/${patientId}`),
    api(`/doctor/patients/${patientId}/plans`).catch(() => ({ plans: [], balance: { debt: 0, billed: 0, paid: 0 }, payments: [] })),
  ]);
  S.d.patient = { ...p, id: patientId };
  S.d.money = fin;

  const upcoming = p.appointments.filter((a) => a.status === 'scheduled' && new Date(a.startsAt) >= new Date());
  // То же правило, что и в базе: карта открыта, пока пациент записан или приём
  // не закрыт. Кнопку, которая заведомо упрётся в отказ, лучше не показывать.
  // Сутки назад, а не «с этой минуты»: приём в 10:00, к которому врач подошёл
  // в 10:20, ещё не начат — но карта ему уже нужна.
  const hasAccess = p.visits.some((v) => v.status === 'open')
    || p.appointments.some((a) => a.status === 'scheduled'
      && new Date(a.startsAt).getTime() > Date.now() - 864e5);
  const spent = p.visits.reduce((s, v) => s + Number(v.revenue), 0);

  render(`
    <header><h1>${esc(p.name)}</h1>
      </header>
    <main>
      <div class="card">
        ${p.phone ? `<div class="row"><span class="muted">Телефон</span>
          <a href="tel:${esc(p.phone)}" class="tel">${esc(p.phone)}</a></div>`
        : `<div class="row"><span class="muted">Телефон</span><span>не записан</span></div>`}
        <div class="row"><span class="muted">Уведомления</span>
          <span>${p.inTelegram ? 'приходят в Telegram' : 'нет — только звонок'}</span></div>
        ${!p.phone && !p.inTelegram ? `<div class="note">Связаться с этим пациентом нечем:
        ни телефона, ни чата с ботом. Если приём придётся перенести, предупредить
        его не получится — спросите номер на приёме.</div>` : ''}
        ${p.phone ? `<label class="fieldlabel">Телефон</label>
        <input class="field" id="pphonefix" value="${esc(p.phone)}" inputmode="tel">`
        : `<label class="fieldlabel">Записать телефон</label>
        <input class="field" id="pphonefix" placeholder="+998 __ ___ __ __" inputmode="tel">`}
        <label class="fieldlabel">Заметка — аллергия, особенности, договорённости</label>
        <textarea class="field" id="pnotes" placeholder="Аллергия на лидокаин">${esc(p.notes ?? '')}</textarea>
        <button class="mini" data-act="savenotes">Сохранить заметку и телефон</button>
      </div>

      ${upcoming.length ? `<div class="sectiontitle">Впереди</div>
      <div class="card ok">${upcoming.map((a) => `<div class="row">
        <span>${esc(a.service ?? 'без услуги')}${a.note ? `<br><span class="muted">${esc(a.note)}</span>` : ''}</span>
        <span class="mono">${dateLabel(a.startsAt.slice(0, 10), { day: 'numeric', month: 'short' })}, ${hhmm(a.startsAt)}</span>
      </div>`).join('')}</div>` : ''}

      <div class="sectiontitle">Лечение и деньги</div>
      <div class="card ${S.d.money.balance.debt > 0 ? 'warn' : ''}">
        <div class="row"><span class="muted">Оказано услуг на</span>
          <span class="mono">${money(S.d.money.balance.billed)} сум</span></div>
        <div class="row"><span class="muted">Внесено</span>
          <span class="mono">${money(S.d.money.balance.paid)} сум</span></div>
        <div class="row"><span class="name">Долг</span>
          <span class="mono name">${money(S.d.money.balance.debt)} сум</span></div>
        <button class="mini" data-act="pay">Принять оплату</button>
      </div>

      ${S.d.money.plans.length ? `<div class="card">${S.d.money.plans.map((pl) => `
        <div class="stockrow" data-tplan="${pl.id}">
          <div class="body">
            <div class="name">${esc(pl.title)}</div>
            <div class="muted">${pl.done} из ${pl.items} · ${
              pl.status === 'draft' ? 'черновик' : pl.status === 'active' ? 'у пациента'
              : pl.status === 'done' ? 'выполнен' : 'отменён'} · ваша часть ${money(pl.margin)}</div>
          </div>
          <div class="qty-val mono">${money(pl.revenue)}<small>сум</small></div>
        </div>`).join('')}</div>` : ''}
      <button class="mini" data-act="newplan">+ Новый план лечения</button>

      ${S.d.money.payments.length ? `<div class="sectiontitle">Платежи</div>
      <div class="card">${S.d.money.payments.slice(0, 8).map((x) => `<div class="row">
        <span>${({ cash: 'наличные', card: 'карта', transfer: 'перевод', other: 'иначе' })[x.method] ?? x.method}${
          x.note ? `<br><span class="muted">${esc(x.note)}</span>` : ''}</span>
        <span class="mono">${money(x.amount)} · ${dateLabel(String(x.at).slice(0, 10), { day: 'numeric', month: 'short' })}</span>
      </div>`).join('')}</div>` : ''}

      <div class="sectiontitle">Карта пациента</div>
      <div class="card">
        <div class="note" style="margin:0 0 10px">${!p.inTelegram
          ? `Карта человека привязана к его Telegram. Этот пациент заведён вручную,
             своей карты у него нет — здесь только приёмы в вашем кабинете.`
          : hasAccess
          ? `Что этому человеку лечили — в том числе в других кабинетах. Карта
             принадлежит ему; вам она открыта, пока он записан или приём не закрыт.
             Каждое открытие записывается в журнал.`
          : `Карта принадлежит пациенту, и сейчас она закрыта: он не записан и приёма
             нет. Откроется сама, как только он запишется, — и закроется, когда вы
             закроете приём. Уточнить запись можно только в это время.`}</div>
        ${hasAccess ? `<button class="mini" data-act="teeth">Зубы: кариес, пломбы, коронки</button>` : ''}
        ${p.inTelegram && hasAccess ? '<button class="mini" data-act="record">Что лечили</button>' : ''}
      </div>

      <div class="sectiontitle">История приёмов</div>
      ${p.visits.length ? `<div class="card">${p.visits.map((v) => `
        <div class="stockrow" data-visit="${v.id}">
          <div class="body">
            <div class="name">${esc((v.services ?? []).join(', ') || 'без услуг')}</div>
            <div class="muted">${dateLabel(v.date)}${v.status === 'open' ? ' · <b>не закрыт</b>' : ''}${
              v.cost != null ? ` · материалы ${money(v.cost)}` : ''}</div>
          </div>
          <div class="qty-val mono">${money(v.revenue)}<small>сум</small></div>
        </div>`).join('')}</div>`
      : '<div class="empty">Приёмов ещё не было.</div>'}

      ${(p.accessLog ?? []).length ? `
      <div class="sectiontitle">Кто открывал карту</div>
      <div class="card">
        ${p.accessLog.map((l) => `<div class="row">
          <span>${esc(l.subject)}<br><span class="muted">${
            l.action === 'patient_card' ? 'смотрел карту'
            : l.action === 'visit' ? 'открывал приём'
            : l.action === 'patient_edit' ? `правил: ${esc(l.detail ?? '')}`
            : esc(l.action)}</span></span>
          <span class="muted mono">${dateLabel(String(l.at).slice(0, 10), { day: 'numeric', month: 'short' })}, ${hhmm(l.at)}</span>
        </div>`).join('')}
        <div class="note">Записывается каждое обращение к личным данным.
        При споре это единственное доказательство того, кто и когда их видел.</div>
      </div>` : ''}

      ${p.appointments.some((a) => a.status === 'cancelled' || a.status === 'no_show') ? `
      <div class="sectiontitle">Отменённые и неявки</div>
      <div class="card">${p.appointments.filter((a) => a.status === 'cancelled' || a.status === 'no_show')
        .map((a) => `<div class="row">
          <span>${dateLabel(a.startsAt.slice(0, 10), { day: 'numeric', month: 'short' })}, ${hhmm(a.startsAt)}
            ${a.cancelReason ? `<br><span class="muted">${esc(a.cancelReason)}</span>` : ''}</span>
          <span class="badge ${a.status === 'no_show' ? 'warn' : 'overdue'}">${
            a.status === 'no_show' ? 'не пришёл' : 'отменена'}</span>
        </div>`).join('')}</div>` : ''}
    </main>
  `);
}

/**
 * Карта человека глазами врача.
 *
 * Ровно тот же список, что видит пациент: врачу нельзя показывать больше,
 * чем видит владелец карты. Разница одна — кнопка уточнения: изменить чужую
 * запись нельзя никому, а дополнить может тот, у кого пациент лечится сейчас.
 *
 * Отказ показываем текстом из базы, а не «нет доступа»: врач должен понимать,
 * что сделать — записать пациента или открыть приём.
 */
async function docRecord(patientId) {
  markSeen('record');
  spinner('Открываем карту…');
  let data;
  try {
    data = await api(`/doctor/patients/${patientId}/record`);
  } catch (err) {
    return render(`
      <header><h1>Карта закрыта</h1></header>
      <main><div class="card warn">
        <div class="note" style="margin:0">${esc(err.message)}</div>
      </div>
      <div class="card"><div class="note" style="margin:0">Карта принадлежит пациенту.
      Она открывается вам с той минуты, как он к вам записан, и остаётся открытой,
      пока приём не закрыт.</div></div></main>
    `);
  }

  S.d.record = { patientId, entries: data.entries ?? [], noTelegram: data.noTelegram };
  return drawDocRecord();
}

/**
 * Отрисовка карты у врача из уже полученного.
 *
 * Отдельно от загрузки: выбор зуба перерисовывает экран, а не открывает
 * карту заново. Иначе каждое нажатие на зуб уходило бы в журнал доступа
 * отдельной строкой, и журнал перестал бы отвечать на вопрос «сколько раз
 * её открывали».
 */
function drawDocRecord() {
  const { entries, noTelegram } = S.d.record;
  const roots = entries.filter((e) => !e.amends);
  const tooth = S.d.recTooth;
  const shown = tooth
    ? entries.filter((e) => e.tooth === tooth || entries.some(
        (o) => o.id === e.amends && o.tooth === tooth))
    : entries;

  render(`
    <header><h1>Карта: ${esc(S.d.patient?.name ?? '')}</h1></header>
    <main>
      ${noTelegram ? `<div class="card"><div class="note" style="margin:0">
        У этого пациента нет Telegram, значит нет и своей карты.</div></div>` : ''}
      ${roots.length ? `${chartCard({
        marks: toothMarks(entries), selected: tooth ? [tooth] : [], milk: S.d.recMilk,
        note: 'Закрашенный зуб уже лечили. Нажмите — останутся записи только по нему.',
      })}
      ${tooth ? `<div class="card ok"><div class="row">
        <span class="name">Зуб ${esc(tooth)}</span>
        <button class="mini" data-act="alltooth">Все зубы</button></div></div>` : ''}
      ${shown.length ? recordList(shown, { amendable: true })
        : '<div class="empty">На этом зубе записей нет.</div>'}`
        : `<div class="card"><div class="note" style="margin:0">Записей ещё нет. Первая
           появится, когда вы закроете приём: по каждой оказанной услуге — своя строка.</div></div>`}
      <div class="card">
        <div class="note" style="margin:0">Запись нельзя изменить и нельзя удалить —
        ни вам, ни автору. Ошибка исправляется дополнением: исходный текст остаётся,
        уточнение встаёт рядом, и следующий врач видит оба.</div>
      </div>
    </main>
  `);
}

/* ── Отметки состояний ─────────────────────────────────────────────────
   Кариес, пломба, коронка и остальное, что врач видит во рту. Хранится не
   как «услуга», а как СОСТОЯНИЕ: услуга говорит, что пломбу ставили, а
   отметка — что она сейчас стоит. Через два года это разные вопросы. */

const MARK_GROUPS = [
  { key: 'state', name: 'Состояние зуба' },
  { key: 'lesion', name: 'Поражения' },
  { key: 'perio', name: 'Пародонт' },
  { key: 'endo', name: 'Эндодонтия' },
  { key: 'build', name: 'Конструкции' },
];

/** Отметки по зубам: с сервера приходит плоский список. */
const byTooth = (marks) => (marks ?? []).reduce(
  (m, x) => ({ ...m, [x.tooth]: [...(m[x.tooth] ?? []), x] }), {});

/**
 * Зубная карта у врача.
 *
 * Порядок действий тот же, что в любой карте: выбрать отметку, нажать зуб.
 * Обратный порядок — «нажать зуб, потом выбрать» — требует всплывающего окна
 * на каждое касание, а врач ставит десяток отметок подряд.
 */
async function docTeeth(patientId) {
  spinner('Открываем зубы…');
  let data;
  try {
    data = await api(`/doctor/patients/${patientId}/teeth`);
  } catch (err) {
    return render(`
      <header><h1>Зубы закрыты</h1></header>
      <main><div class="card warn"><div class="note" style="margin:0">${esc(err.message)}</div></div>
      <div class="card"><div class="note" style="margin:0">Зубная карта принадлежит пациенту.
      Она открывается вам с той минуты, как он к вам записан, и остаётся открытой,
      пока приём не закрыт.</div></div></main>
    `);
  }
  S.d.teeth = {
    patientId,
    marks: data.marks ?? [],
    history: data.history ?? [],
    palette: data.palette ?? [],
    pick: S.d.teeth?.patientId === patientId ? S.d.teeth.pick : null,
    last: null,
    open: S.d.teeth?.patientId === patientId ? S.d.teeth.open : 'lesion',
    milk: S.d.teeth?.patientId === patientId ? S.d.teeth.milk : false,
    tooth: null,
  };
  drawDocTeeth();
}

function drawDocTeeth() {
  const d = S.d.teeth;
  const states = byTooth(d.marks);
  const picked = d.palette.find((x) => x.code === d.pick);
  const focus = d.tooth ? (states[d.tooth] ?? []) : [];

  render(`
    <header><h1>Зубы: ${esc(S.d.patient?.name ?? '')}</h1></header>
    <main>
      ${chartCard({
        states, selected: d.tooth ? [d.tooth] : [], milk: d.milk, wide: true,
        note: d.last
          ? `<b>${esc(d.last.name)}</b> → зуб <b>${esc(d.last.tooth)}</b>.${
              picked ? ' Нажимайте дальше — отметка та же.' : ''}`
          : picked
          ? `Выбрано: <b>${esc(picked.name)}</b>. Нажимайте зубы — отметка встанет на каждый.`
          : 'Выберите отметку внизу и нажмите зуб. Нажатие без отметки покажет, что на зубе уже есть.',
      })}

      ${d.tooth ? `<div class="card ok">
        <div class="row"><span class="name">Зуб ${esc(d.tooth)}</span>
          <button class="mini" data-act="unfocus">Закрыть</button></div>
        ${focus.length ? focus.map((m) => `<div class="row">
          <span><i class="swatch" style="background:${m.color}"></i>${esc(m.name)}
            <br><span class="muted">${esc(m.cabinet)}${m.doctor ? `, ${esc(m.doctor)}` : ''} · ${
              dateLabel(m.notedOn, { day: 'numeric', month: 'short' })}</span></span>
          <button class="mini" data-clearmark="${m.category}">Снять</button>
        </div>`).join('')
        : '<div class="note" style="margin:0">На этом зубе отметок нет.</div>'}
      </div>` : ''}

      ${MARK_GROUPS.map((g) => {
        const items = d.palette.filter((x) => x.category === g.key);
        if (!items.length) return '';
        const open = d.open === g.key;
        return `<div class="card">
          <div class="row" data-markgroup="${g.key}">
            <span class="name">${g.name}</span>
            <span class="muted">${open ? '▾' : '▸'}</span>
          </div>
          ${open ? `<div class="marks">${items.map((x) => `
            <button class="markbtn${d.pick === x.code ? ' on' : ''}" data-markcode="${x.code}">
              <i class="swatch" style="background:${x.color}"></i>${esc(x.name)}
            </button>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}

      ${d.history.length ? `<div class="sectiontitle">Что менялось</div>
      <div class="card">${d.history.slice(0, 12).map((h) => `<div class="row">
        <span>${h.code
          ? `<i class="swatch" style="background:${h.color}"></i>${esc(h.name)}`
          : '<i class="swatch off"></i>снято'} · зуб ${esc(h.tooth)}
          <br><span class="muted">${esc(h.cabinet)}${h.doctor ? `, ${esc(h.doctor)}` : ''}</span></span>
        <span class="muted mono">${dateLabel(h.notedOn, { day: 'numeric', month: 'short' })}</span>
      </div>`).join('')}
        <div class="note">Отметки не переписываются: новая вытесняет прежнюю, а прежняя
        остаётся здесь. Видно, что на зубе сначала был кариес, а потом пломба.</div>
      </div>` : ''}
    </main>
    ${picked ? `<button class="primary" data-act="dropmark">Отложить «${esc(picked.name)}»</button>` : ''}
  `);
}

/** Дополнение к записи: отдельный экран, потому что это текст, а не «да/нет». */
function docAmend(entryId) {
  const e = (S.d.record?.entries ?? []).find((x) => x.id === entryId);
  if (!e) return back();
  render(`
    <header><h1>Уточнение</h1>
      </header>
    <main>
      <div class="card">
        <div class="row"><span class="name">${esc(e.service)}${
          e.tooth ? ` · зуб ${esc(e.tooth)}` : ''}<br>
          <span class="muted">${esc(e.cabinet)}${e.doctor ? `, ${esc(e.doctor)}` : ''}</span></span></div>
        ${e.note ? `<div class="note" style="margin:2px 0 0">${esc(e.note)}</div>` : ''}
      </div>
      <div class="card">
        <label class="fieldlabel">Что уточняете</label>
        <textarea class="field" id="amendnote"
          placeholder="Лечили 36, а не 35 — по снимку от 12.03"></textarea>
        <div class="note">Исходная запись останется как есть: её нельзя изменить
        и нельзя удалить. Ваше уточнение встанет рядом, с вашим именем и датой.</div>
      </div>
    </main>
    <button class="primary" data-act="saveamend" data-id="${entryId}">Добавить уточнение</button>
  `);
  setTimeout(() => document.getElementById('amendnote')?.focus(), 80);
}

/* ── План лечения ──────────────────────────────────────────────────────
   Смысл не в списке услуг с ценами — такой список есть у всех. Смысл во
   второй колонке: у каждой услуги есть техкарта, у техкарты нормы расхода,
   значит план суммируется и в затраты тоже. Врач видит, сколько заработает,
   ДО того как предложит план пациенту. */

const itemCost = (i) => (i.costBase ?? 0) + (i.costPerUnit ?? 0) * (i.quantity ?? 1);

/** Набранное в полях втягиваем ДО перерисовки, иначе правки теряются молча. */
function readPlanForm() {
  const t = S.d.tplan;
  if (!t) return;
  t.title = document.getElementById('plantitle')?.value ?? t.title;
  document.querySelectorAll('[data-titem]').forEach((el) => {
    const i = t.items[Number(el.dataset.titem)];
    if (!i || i.status === 'done') return;
    // Зуб больше не поле ввода: он выбирается на карте и уже лежит в
    // состоянии позиции. Читать отсюда нечего — иначе перерисовка обнулила бы
    // только что выбранный зуб.
    const price = el.querySelector('.tprice')?.value ?? '';
    if (price !== '') i.price = Math.max(0, Number(price.replace(/\s/g, '')) || 0);
  });
}

async function docPlanEdit(planId) {
  // Возврат с выбора услуги или зуба — это ВОЗВРАТ в редактор, а не открытие
  // его заново. Без этой проверки экран перечитывал план с сервера и стирал
  // всё, что врач успел набрать: добавленная услуга исчезала молча, и план
  // нельзя было собрать вообще. Точки входа ниже обнуляют S.d.tplan сами.
  if (S.d.tplan && S.d.tplan.planId === (planId ?? null)) return drawPlanEdit();
  spinner('Загрузка прайса…');
  const [{ services }, plan] = await Promise.all([
    api('/doctor/services?withCost=1'),
    planId ? api(`/doctor/plans/${planId}`) : Promise.resolve(null),
  ]);
  const byId = new Map(services.map((s) => [s.id, s]));

  S.d.tplan = {
    planId: planId ?? null,
    patientId: plan?.patient?.id ?? S.d.patient?.id,
    patientName: plan?.patient?.name ?? S.d.patient?.name ?? '',
    title: plan?.title ?? 'План лечения',
    status: plan?.status ?? 'draft',
    services,
    items: (plan?.items ?? []).map((i) => ({
      serviceId: i.serviceId, service: i.service, unit: i.unit,
      tooth: i.tooth ?? '', quantity: i.quantity, price: Number(i.price),
      stage: i.stage, status: i.status,
      costBase: byId.get(i.serviceId)?.costBase ?? 0,
      costPerUnit: byId.get(i.serviceId)?.costPerUnit ?? 0,
    })),
  };
  drawPlanEdit();
}

function drawPlanEdit() {
  const t = S.d.tplan;
  const live = t.items.filter((i) => i.status !== 'cancelled');
  const revenue = live.reduce((s, i) => s + i.price, 0);
  const cost = live.reduce((s, i) => s + itemCost(i), 0);
  const stages = [...new Set(live.map((i) => i.stage))].sort((a, b) => a - b);

  render(`
    <header><h1>${t.planId ? 'Правка плана' : 'Новый план'}</h1>
      </header>
    <main>
      <div class="card">
        <label class="fieldlabel">Название плана</label>
        <input class="field" id="plantitle" value="${esc(t.title)}" placeholder="Лечение 26 зуба">
      </div>

      ${stages.map((st) => `
        <div class="sectiontitle">Этап ${st}${st === 1 ? ' — сейчас' : ''}</div>
        ${live.map((i, idx) => [i, idx]).filter(([i]) => i.stage === st).map(([i, idx]) => `
        <div class="card ${i.status === 'done' ? 'ok' : ''}" data-titem="${idx}">
          <div class="row">
            <span class="name">${esc(i.service)}</span>
            <span class="mono">${money(i.price)}</span>
          </div>
          ${i.status === 'done' ? `
            <div class="note" style="margin:6px 0 0">Уже выполнено — правке не подлежит.</div>`
          : `
          <div class="planrow">
            <label class="fieldlabel">Зуб</label>
            <button class="field pickfield" data-toothitem="${idx}">${
              i.tooth ? `Зуб ${esc(i.tooth)}` : 'Выбрать на карте'}</button>
            <label class="fieldlabel">Цена</label>
            <input class="field tprice" value="${i.price}" inputmode="numeric">
          </div>
          <div class="row">
            <span class="muted">${i.unit === 'canal' ? 'Каналов' : i.unit === 'surface' ? 'Поверхностей'
              : i.unit === 'tooth' ? 'Зубов' : 'Количество'}</span>
            <span class="qty">
              <button class="mini" data-tq="${idx}:-">−</button>
              <span class="qty-val mono">${i.quantity}</span>
              <button class="mini" data-tq="${idx}:+">+</button>
            </span>
          </div>
          <div class="row">
            <span class="muted">Себестоимость</span>
            <span class="mono">${money(itemCost(i))} сум</span>
          </div>
          <div class="row">
            <button class="mini" data-tstage="${idx}:-">← этап</button>
            <button class="mini" data-tstage="${idx}:+">этап →</button>
            <button class="mini danger" data-trm="${idx}">Убрать</button>
          </div>`}
        </div>`).join('')}`).join('')}

      ${live.length ? '' : '<div class="empty">Добавьте услуги из прайса.</div>'}
      <button class="mini" data-act="addplanitem">+ Добавить услугу</button>

      <div class="sectiontitle">Итог плана</div>
      <div class="card">
        <div class="row"><span class="muted">Пациент заплатит</span>
          <span class="mono">${money(revenue)} сум</span></div>
        <div class="row"><span class="muted">Материалы</span>
          <span class="mono">${money(cost)} сум</span></div>
        <div class="row"><span class="name">Останется вам</span>
          <span class="mono name">${money(revenue - cost)} сум${
            revenue ? ` · ${Math.round(100 * (revenue - cost) / revenue)}%` : ''}</span></div>
        <div class="note">Материалы посчитаны по техкартам и сегодняшним ценам закупки.
        Это прогноз: при списании цифра уточнится по реально израсходованным партиям.</div>
      </div>
    </main>
    <button class="primary" data-act="saveplan">Сохранить</button>
  `);
  S.d.redraw = () => { readPlanForm(); drawPlanEdit(); };
}

/** Выбор услуги из прайса — тот же приём, что и подбор материала в техкарту. */
async function docPlanPicker() {
  const t = S.d.tplan;
  render(`
    <header><h1>Услуга из прайса</h1></header>
    <main><div class="picker">
      ${t.services.map((s) => `<button data-psvc="${s.id}">
        <div class="name">${esc(s.name_ru)}</div>
        <div class="price">${money(s.price)} сум · материалы ${money(s.costBase + s.costPerUnit)}${
          s.unpricedLines ? ' · <b>есть материалы без цены</b>' : ''}</div>
      </button>`).join('')}
    </div></main>
  `);
}

async function docPlan(planId) {
  spinner('Загрузка плана…');
  const p = await api(`/doctor/plans/${planId}`);
  S.d.tplanView = p;
  const t = p.totals;
  const stages = [...new Set(p.items.map((i) => i.stage))].sort((a, b) => a - b);

  render(`
    <header><h1>${esc(p.title)}</h1>
      </header>
    <main>
      ${stages.map((st) => `
        <div class="sectiontitle">Этап ${st}</div>
        <div class="card">${p.items.filter((i) => i.stage === st).map((i) => `
          <div class="row">
            <span>${i.status === 'done' ? '✓ ' : ''}${esc(i.service)}${
              i.tooth ? ` · зуб ${esc(i.tooth)}` : ''}${
              i.quantity > 1 ? ` · ×${i.quantity}` : ''}</span>
            <span class="mono">${money(i.price)}</span>
          </div>`).join('')}</div>`).join('')}

      <div class="sectiontitle">Деньги</div>
      <div class="card">
        <div class="row"><span class="muted">Пациент заплатит</span>
          <span class="mono">${money(t.revenue)} сум</span></div>
        <div class="row"><span class="muted">Материалы по техкартам</span>
          <span class="mono">${money(t.cost)} сум</span></div>
        <div class="row"><span class="name">Останется вам</span>
          <span class="mono name">${money(t.margin)} сум${
            Number(t.revenue) ? ` · ${Math.round(100 * t.margin / t.revenue)}%` : ''}</span></div>
        ${Number(t.unpricedLines) ? `<div class="note">В техкартах ${t.unpricedLines} строк
        без цены — реальная себестоимость выше показанной. Проставьте цены на складе.</div>` : ''}
        <div class="row"><span class="muted">Уже выполнено</span>
          <span class="mono">${money(t.doneRevenue)} сум</span></div>
        <div class="row"><span class="muted">Осталось сделать</span>
          <span class="mono">${money(t.leftRevenue)} сум</span></div>
      </div>

      <div class="picker">
        <button data-act="editplan"><div class="name">Изменить состав</div>
          <div class="price">выполненное останется как есть</div></button>
        ${p.status === 'draft' ? `<button data-act="activateplan">
          <div class="name">Показать пациенту</div>
          <div class="price">придёт сообщение в Telegram</div></button>` : ''}
        ${p.status === 'active' ? `<button data-act="closeplan">
          <div class="name">Закрыть план</div>
          <div class="price">лечение завершено</div></button>` : ''}
      </div>
      ${p.items.some((i) => i.status === 'done') ? '' : `
      <button class="mini danger" data-act="delplan">Удалить план</button>`}
    </main>
  `);
}

/** Оплата. Счетов нет: долг — это оказанное минус внесённое. */
function docPayment(patientId) {
  const b = S.d.money?.balance ?? { debt: 0 };
  render(`
    <header><h1>Оплата</h1></header>
    <main>
      <div class="card ${b.debt > 0 ? 'warn' : 'ok'}">
        <div class="row"><span class="muted">Долг сейчас</span>
          <span class="mono name">${money(b.debt)} сум</span></div>
      </div>
      <div class="card">
        <label class="fieldlabel">Сумма</label>
        <input class="field" id="payamount" inputmode="numeric" placeholder="${b.debt > 0 ? b.debt : ''}">
        <label class="fieldlabel">Чем платят</label>
        <div class="picker row-picker">
          ${[['cash','Наличные'],['card','Карта'],['transfer','Перевод'],['other','Иначе']]
            .map(([k, label]) => `<button class="mini ${(S.d.payMethod ?? 'cash') === k ? 'on' : ''}"
              data-pmethod="${k}">${label}</button>`).join('')}
        </div>
        <label class="fieldlabel">Комментарий — необязательно</label>
        <input class="field" id="paynote" placeholder="аванс за первый этап">
      </div>
    </main>
    <button class="primary" data-act="dopay" data-id="${patientId}">Принять оплату</button>
  `);
  setTimeout(() => document.getElementById('payamount')?.focus(), 80);
}

/* ══════════════════════════════════════════════════════════════════════════
   ВРАЧ — кабинет
   ══════════════════════════════════════════════════════════════════════════ */

async function docMenu() {
  const { totals } = await tabData('cabinet',
    () => api('/doctor/reports/margin').catch(() => ({ totals: null })), 'Загрузка…');

  render(`
    <header><h1>Кабинет</h1></header>
    <main>
      ${tourCard()}
      ${!S.d.me?.onboarding?.active && !S.d.me?.catalogReviewed ? `<div class="card warn">
        <div class="name">Сверьте справочник</div>
        <div class="note" style="margin-top:6px">Цены материалов и нормы расхода пока
        стартовые. Пока они не ваши, себестоимость приблизительная.</div>
        <button class="mini" data-act="reviewhint">Что проверить</button>
      </div>` : ''}
      ${totals ? `<div class="card">
        <div class="row"><span class="muted">Выручка за 30 дней</span><span class="mono">${money(totals.revenue)}</span></div>
        <div class="row"><span class="muted">Материалы</span><span class="mono">${money(totals.cost)}</span></div>
        <div class="row"><span class="name">Сверх материалов</span><span class="mono margin-pos">${money(totals.margin)}</span></div>
      </div>` : ''}
      <div class="picker">
        <button data-act="techcards"><div class="name">Техкарты</div>
          <div class="price">нормы расхода на услугу</div></button>
        <button data-act="margin"><div class="name">Сверх материалов по услугам</div>
          <div class="price">какая услуга съедает расходники</div></button>
        <button data-act="schedule"><div class="name">Рабочие часы</div>
          <div class="price">дни, обед, выходные</div></button>
        <button data-act="link"><div class="name">Ссылка для пациентов</div>
          <div class="price">чтобы записывались сами</div></button>
        <button data-act="listing"><div class="name">Показ в поиске</div>
          <div class="price">${S.d.listingOn ? 'кабинет виден пациентам' : 'чтобы нашли без ссылки'}</div></button>
        <button data-act="invite"><div class="name">Пригласить в кабинет</div>
          <div class="price">одноразовая ссылка на сутки</div></button>
        <button data-act="billing"><div class="name">Подписка</div>
          <div class="price">срок и продление</div></button>
      </div>

      ${S.d.me?.isPlatformOwner ? `<div class="sectiontitle">Платформа</div>
      <div class="picker">
        <button data-act="adminlic"><div class="name">Проверка лицензий</div>
          <div class="price">кабинеты, которые просятся в поиск</div></button>
      </div>` : ''}

      <div class="sectiontitle">Кто вы сейчас</div>
      <div class="picker">
        <button data-act="switcher"><div class="name">Вы в кабинете как врач</div>
          <div class="price">перейти к себе-пациенту: свои записи, зубная карта,
          поиск стоматолога</div></button>
      </div>

      <div class="danger-zone">
        <div class="sectiontitle">Опасная зона</div>
        <div class="card">
          <div class="note" style="margin:0 0 10px">${S.d.me?.staffOf?.find((x) => x.tenantId === S.d.me.tenantId)?.role === 'owner'
            ? `Удаление кабинета стирает его записи, приёмы, планы, склад и расчёты.
               Восстановить их будет нечем. Медицинские карты остаются у самих
               пациентов — их удалить нельзя.`
            : 'Вы перестанете видеть этот кабинет. Данные кабинета останутся у его владельца.'}</div>
          <button class="mini danger" data-act="dangerzone">${
            S.d.me?.staffOf?.find((x) => x.tenantId === S.d.me.tenantId)?.role === 'owner'
              ? 'Удалить кабинет' : 'Выйти из кабинета'}</button>
        </div>
      </div>
    </main>
  `);
}

async function docMargin() {
  markSeen('margin');
  spinner('Считаем…');
  const { from, to, rows, totals } = await api('/doctor/reports/margin');
  if (!rows.length) {
    return render(`<header><h1>Сверх материалов</h1></header><div class="empty">Нет закрытых приёмов за период.</div>`);
  }
  render(`
    <header><h1>Сверх материалов</h1></header>
    <main><div class="card">
      <table>
        <thead><tr><th>Услуга</th><th>Кол-во</th><th>Выручка</th><th>Сверх</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r.name)}${r.shortfallShare > 20 ? ` <span class="badge warn">${r.shortfallShare}% недостач</span>` : ''}${r.hasUnpriced ? ' <span class="badge warn">без цены</span>' : ''}</td>
          <td class="mono">${r.count}</td>
          <td class="mono">${money(r.revenue)}</td>
          <td class="mono ${r.margin >= 0 ? 'margin-pos' : 'margin-neg'}">${money(r.margin)}<br><span class="muted">${r.marginPct}%</span></td>
        </tr>`).join('')}</tbody>
      </table>
      <div class="totals row"><span class="name">Итого</span><span class="mono margin-pos">${money(totals.margin)}</span></div>
      <div class="row muted"><span>выручка ${money(totals.revenue)}</span><span>материалы ${money(totals.cost)}</span></div>
      <div class="note">Это выручка минус <b>материалы</b>, а не прибыль: зарплата, аренда,
      амортизация и налоги сюда не входят.</div>
    </div></main>
  `);
}

/* ── Склад: единственное место, где живут материалы ──────────────────── */

async function docStock() {
  markSeen('stock');
  const data = await tabData('stock', () => api('/doctor/stock'), 'Загрузка склада…');
  S.d.stock = data;

  const byCat = new Map();
  for (const m of data.materials) {
    const k = m.category ?? 'прочее';
    byCat.set(k, [...(byCat.get(k) ?? []), m]);
  }

  const CAT = { base: 'Базовый набор', anesthesia: 'Анестезия', isolation: 'Изоляция',
    xray: 'Рентген', resto: 'Реставрация', endo: 'Эндодонтия', hygiene: 'Гигиена', 'прочее': 'Прочее' };

  render(`
    <header><h1>Склад</h1></header>
    <main>
      ${tourCard()}
      <div class="statgrid">
        <div class="stat"><div class="v mono">${money(data.summary.value)}</div><div class="k">стоимость остатков</div></div>
        <div class="stat"><div class="v mono">${data.summary.total}</div><div class="k">материалов</div></div>
        <div class="stat ${data.summary.outOfStock ? 'bad' : ''}"><div class="v mono">${data.summary.outOfStock}</div><div class="k">закончились</div></div>
        <div class="stat ${data.summary.needsPrice ? 'warn' : ''}"><div class="v mono">${data.summary.needsPrice}</div><div class="k">без цены</div></div>
      </div>
      ${data.summary.needsPrice ? `<div class="card warn" style="margin-top:8px">
        <div class="name">${data.summary.needsPrice} материалов без цены</div>
        <div class="note">Приёмы с такими материалами дадут неполную себестоимость,
        а маржа покажется завышенной. Проставьте цену закупки.</div>
      </div>` : ''}
      ${[...byCat.entries()].map(([cat, items]) => `
        <div class="sectiontitle">${esc(CAT[cat] ?? cat)}</div>
        <div class="card">
          ${items.map((m) => `<div class="stockrow ${m.outOfStock ? 'low' : ''}" data-material="${m.id}">
            <div class="body">
              <div class="name">${esc(m.nameRu)}</div>
              <div class="muted">${m.referencePrice ? `${money(m.referencePrice)} сум/${esc(m.unit)}` : '<b>цена не указана</b>'}${
                m.expiredQty > 0 ? ' · <b>есть просрочка</b>' : ''}${
                m.usedInTechcards ? ` · в ${m.usedInTechcards} техкартах` : ''}</div>
            </div>
            <div class="qty-val mono">${qtyFmt(m.qty)}<small>${esc(m.unit)}</small></div>
          </div>`).join('')}
        </div>`).join('')}
    </main>
    <button class="primary" data-act="newmaterial">+ Новый материал</button>
  `);
}

async function docMaterial(materialId) {
  spinner('Загрузка…');
  const d = await api(`/doctor/stock/${materialId}`);
  S.d.material = d;
  const m = d.material;

  render(`
    <header><h1>${esc(m.name_ru)}</h1>
      </header>
    <main>
      <div class="card">
        <div class="row"><span class="muted">На складе</span>
          <span class="mono name">${qtyFmt(d.batches.reduce((s, b) => s + Number(b.qty_remaining), 0))} ${esc(d.unit?.name_ru ?? '')}</span></div>
        <div class="row"><span class="muted">Делимая единица</span><span>${d.unit?.divisible ? 'да' : 'нет — списывается целиком'}</span></div>
      </div>
      <div class="sectiontitle">Партии</div>
      <div class="card">
        ${d.batches.length ? d.batches.map((b) => `<div class="stockrow ${b.expired ? 'low' : ''}" data-batch="${b.batch_id}">
          <div class="body">
            <div class="name">${qtyFmt(Number(b.qty_remaining))} из ${qtyFmt(Number(b.initial_qty))}</div>
            <div class="muted">${b.total_price ? `${money(b.total_price)} сум` : 'без цены'}${
              b.expires_at ? ` · до ${dateLabel(b.expires_at, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}${b.expired ? ' · <b>просрочена</b>' : ''}${
              b.supplier ? ` · ${esc(b.supplier)}` : ''}</div>
          </div>
        </div>`).join('') : '<div class="muted">Партий нет. Оприходуйте закупку.</div>'}
      </div>
      <div class="picker" style="margin-top:8px">
        <button data-act="receive"><div class="name">Оприходовать закупку</div><div class="price">количество, цена, срок годности</div></button>
        <button data-act="editmaterial"><div class="name">Изменить материал</div><div class="price">название, категория, цена</div></button>
      </div>
    </main>
  `);
}

function docBatch(batchId) {
  const b = S.d.material.batches.find((x) => x.batch_id === batchId);
  const m = S.d.material.material;
  const unit = S.d.material.unit?.name_ru ?? '';
  S.d.batch = b;
  render(`
    <header><h1>Партия</h1></header>
    <main>
      <div class="card">
        <div class="row"><span class="muted">Остаток</span>
          <span class="mono name">${qtyFmt(Number(b.qty_remaining))} ${esc(unit)}</span></div>
        <div class="row"><span class="muted">Было закуплено</span>
          <span class="mono">${qtyFmt(Number(b.initial_qty))} ${esc(unit)}</span></div>
        <div class="row"><span class="muted">Стоимость закупки</span>
          <span class="mono">${b.total_price ? `${money(b.total_price)} сум` : 'не указана'}</span></div>
        ${b.expires_at ? `<div class="row"><span class="muted">Срок годности</span>
          <span class="mono ${b.expired ? 'margin-neg' : ''}">${
            dateLabel(b.expires_at, { day: 'numeric', month: 'short', year: 'numeric' })}${b.expired ? ' · истёк' : ''}</span></div>` : ''}
        ${b.supplier ? `<div class="row"><span class="muted">Поставщик</span><span>${esc(b.supplier)}</span></div>` : ''}
      </div>
      <div class="card">
        <label class="fieldlabel">Фактический остаток по инвентаризации</label>
        <input class="field" id="aqty" type="number" inputmode="decimal" min="0" step="0.001"
          value="${b.qty_remaining}">
        <label class="fieldlabel">Причина расхождения — обязательно</label>
        <input class="field" id="areason" placeholder="Пересчёт, бой, потеря">
        <div class="note">Корректировка попадёт в журнал движений с причиной.
        Через месяц никто не вспомнит, почему остаток изменился, — поэтому без причины нельзя.</div>
      </div>
      <div class="picker">
        <button data-act="doadjust"><div class="name">Сохранить остаток</div>
          <div class="price">записать корректировку в журнал</div></button>
        ${Number(b.qty_remaining) > 0 ? `<button data-act="dowriteoff"><div class="name">Списать всю партию</div>
          <div class="price">${b.expired ? 'срок годности истёк' : 'утилизация'}</div></button>` : ''}
      </div>
    </main>
  `);
}

function docMaterialForm(existing) {
  const units = S.d.stock?.units ?? [];
  S.d.form = { unitId: existing?.base_unit_id ?? units[0]?.id, editing: existing?.id ?? null };
  const draw = () => render(`
    <header><h1>${existing ? 'Изменить материал' : 'Новый материал'}</h1>
      </header>
    <main>
      <div class="card">
        <label class="fieldlabel">Название</label>
        <input class="field" id="mname" placeholder="Композит пломбировочный" value="${esc(existing?.name_ru ?? '')}">
        <label class="fieldlabel">Категория — необязательно</label>
        <input class="field" id="mcat" placeholder="resto, endo, hygiene…" value="${esc(existing?.category ?? '')}">
        <label class="fieldlabel">Цена закупки за единицу, сум</label>
        <input class="field" id="mprice" type="number" inputmode="decimal" min="0" step="1"
          placeholder="75000" value="${existing?.reference_price ?? ''}">
        <div class="note">Без цены себестоимость приёма посчитается не полностью,
        и маржа покажется завышенной.</div>
      </div>
      ${existing ? '' : `<div class="sectiontitle">Единица измерения</div>
      <div class="card">
        <div class="chips">
          ${units.map((u) => `<button data-unit="${u.id}" class="${S.d.form.unitId === u.id ? 'on' : ''}">${esc(u.name_ru)}</button>`).join('')}
        </div>
        <div class="note">Делимая единица списывается долями (граммы, миллилитры,
        износ бора). Неделимая — только целиком: вскрытая ради 0,6 мл карпула
        стоит как целая.</div>
      </div>`}
    </main>
    <button class="primary" data-act="${existing ? 'updatematerial' : 'creatematerial'}">${existing ? 'Сохранить' : 'Добавить на склад'}</button>
  `);
  S.d.redraw = draw;
  draw();
  setTimeout(() => document.getElementById('mname')?.focus(), 80);
}

function docReceive() {
  const m = S.d.material.material;
  render(`
    <header><h1>Приход</h1></header>
    <main><div class="card">
      <label class="fieldlabel">Количество, ${esc(S.d.material.unit?.name_ru ?? '')}</label>
      <input class="field" id="rqty" type="number" inputmode="decimal" min="0" step="0.001" placeholder="10">
      <label class="fieldlabel">Стоимость всей закупки, сум</label>
      <input class="field" id="rprice" type="number" inputmode="numeric" min="0" step="1"
        placeholder="${m.reference_price ? money(m.reference_price * 10) : '750000'}">
      <label class="fieldlabel">Срок годности — необязательно</label>
      <input class="field" id="rexp" type="date" min="${localDate()}">
      <label class="fieldlabel">Поставщик — необязательно</label>
      <input class="field" id="rsup" placeholder="Название">
      <div class="note">Стоимость указывается за всю закупку, а не за единицу:
      так себестоимость считается долей партии и сходится до копейки.
      Списание идёт по сроку годности — ближайший расходуется первым.</div>
    </div></main>
    <button class="primary" data-act="doreceive">Оприходовать</button>
  `);
  setTimeout(() => document.getElementById('rqty')?.focus(), 80);
}

/* ── Техкарты: только выбор со склада ────────────────────────────────── */

async function docTechcards() {
  markSeen('techcards');
  spinner('Загрузка услуг…');
  const [{ services }, stock] = await Promise.all([api('/doctor/services'), api('/doctor/stock')]);
  S.d.stock = stock;

  if (!stock.materials.length) {
    return render(`
      <header><h1>Техкарты</h1></header>
      <div class="empty">Сначала заполните склад.<br>Техкарта берёт материалы оттуда.</div>
      <button class="primary" data-act="stock">Открыть склад</button>`);
  }

  render(`
    <header><h1>Техкарты</h1></header>
    <main>
      <div class="card">
        <div class="note" style="margin:0">Материалы берутся со склада. Чтобы добавить
        в карту то, чего там нет, сначала заведите материал на складе.</div>
      </div>
      <div class="picker" style="margin-top:8px">
        ${services.map((s) => `<button data-tc="${s.id}">
          <div class="name">${esc(s.name_ru)}</div>
          <div class="price">${money(s.price)} сум · ${s.duration_minutes ?? 30} мин</div>
        </button>`).join('')}
      </div>
    </main>
  `);
}

async function docTechcardEdit(serviceId) {
  spinner('Загрузка техкарты…');
  const [d, stock] = await Promise.all([api(`/doctor/techcard/${serviceId}`), api('/doctor/stock')]);
  S.d.stock = stock;
  S.d.tc = {
    serviceId, service: d.service, blocks: d.blocks, units: d.units,
    lines: d.lines.map((l) => ({
      materialId: l.material_id, analogGroupId: l.analog_group_id,
      title: l.material_ru ?? l.analog_group_name, normQty: Number(l.norm_qty),
      unitId: l.unit_id, unitRu: l.unit_ru, divisible: l.divisible,
      scalesWithQuantity: l.scales_with_quantity, price: l.reference_price,
    })),
  };

  const draw = () => {
    const t = S.d.tc;
    const cost = t.lines.reduce((s, l) => s + (Number(l.price) || 0) * l.normQty, 0);
    const share = t.service.price > 0 ? Math.round((cost / t.service.price) * 100) : 0;
    render(`
      <header><h1>${esc(t.service.name_ru)}</h1></header>
      <main>
        <div class="card">
          <div class="row"><span class="muted">Свои позиции</span><span class="mono">${money(cost)} сум</span></div>
          <div class="row"><span class="muted">Плюс блоки</span><span class="mono">${t.blocks.reduce((s, b) => s + Number(b.lines), 0)} позиций</span></div>
          <div class="row"><span class="muted">Доля от цены услуги</span>
            <span class="mono ${share > 60 ? 'margin-neg' : ''}">${share}%</span></div>
        </div>
        <div class="sectiontitle">Свои позиции — можно править</div>
        <div class="card">
          ${t.lines.length ? t.lines.map((l, i) => `<div class="tcline">
            <div class="body"><div class="name">${esc(l.title)}</div>
              <div class="muted">${esc(l.unitRu ?? '')}${l.scalesWithQuantity ? '' : ' · не умножается на количество'}${
                l.price ? '' : ' · <b>нет цены на складе</b>'}</div></div>
            <input class="num" type="number" step="0.001" min="0" value="${l.normQty}" data-norm="${i}"
              aria-label="Норма расхода ${esc(l.title)}">
            <button class="x" data-rmline="${i}" aria-label="Убрать">×</button>
          </div>`).join('') : '<div class="muted">Пока пусто</div>'}
          <button class="addiv" data-act="pickmaterial">+ материал со склада</button>
        </div>
        <div class="sectiontitle">Блоки — общие для многих услуг</div>
        <div class="card">
          ${t.blocks.map((b) => `<div class="row"><span>${esc(b.block_ru)}</span>
            <span class="muted">${b.lines} позиций · v${b.version}</span></div>`).join('')}
          <div class="note">Базовый набор кресла, анестезия и изоляция заводятся один раз
          и подключаются к десяткам услуг. Поменяли перчатки — правка одна, а не в каждой карте.</div>
        </div>
        <div class="card">
          <div class="note" style="margin:0">Сохранение создаёт <b>новую версию</b>.
          Закрытые приёмы останутся посчитанными по старым нормам — задним числом
          себестоимость не меняется.</div>
        </div>
      </main>
      <button class="primary" data-act="savetc">Сохранить новую версию</button>
    `);
  };
  S.d.redraw = draw;
  draw();
}

function docMaterialPicker() {
  const used = new Set(S.d.tc.lines.map((l) => l.materialId).filter(Boolean));
  const avail = (S.d.stock?.materials ?? []).filter((m) => !used.has(m.id));
  render(`
    <header><h1>Материал со склада</h1></header>
    <main>
      ${avail.length ? `<div class="picker">${avail.map((m) => `<button data-pick="${m.id}">
        <div class="name">${esc(m.nameRu)}</div>
        <div class="price">${m.referencePrice ? `${money(m.referencePrice)} сум/${esc(m.unit)}` : 'цена не указана'} · остаток ${qtyFmt(m.qty)} ${esc(m.unit)}</div>
      </button>`).join('')}</div>`
      : '<div class="empty">Все материалы склада уже в этой карте.<br>Заведите новый на складе.</div>'}
    </main>
  `);
}

/* ── Подписка ────────────────────────────────────────────────────────── */

async function docBilling() {
  spinner('Загрузка…');
  const { subscription: sub, plans } = await api('/billing');
  S.d.plan = plans[0]?.code;

  const draw = () => render(`
    <header><h1>Подписка</h1>
      </header>
    <main>
      <div class="card ${sub.frozen ? 'warn' : sub.daysLeft <= 3 ? 'warn' : 'ok'}">
        <div class="row"><span class="muted">${sub.frozen ? 'Не работает с' : 'Работает до'}</span>
          <span class="name mono">${dateLabel(String(sub.paidUntil).slice(0, 10))}</span></div>
        ${!sub.frozen ? `<div class="row"><span class="muted">Осталось</span>
          <span class="mono">${sub.daysLeft} дн.</span></div>` : ''}
        <div class="note">${sub.frozen
          ? 'Записи пациентов сохранены, напоминания по ним уходят. Принимать новые и вести приёмы можно после продления.'
          : 'Пациенты записываются, приёмы считаются, напоминания уходят.'}</div>
      </div>
      <div class="sectiontitle">Продлить</div>
      <div class="chips">
        ${plans.map((p) => `<button data-plan="${p.code}" class="${S.d.plan === p.code ? 'on' : ''}">
          ${esc(p.name_ru)} · ${money(p.price_uzs)} сум</button>`).join('')}
      </div>
      <div class="card" style="margin-top:12px">
        <div class="note" style="margin:0">Счёт придёт в чат с ботом — платить нужно там.
        Внутри приложения оплата не принимается: подтвердить её может только Telegram.</div>
      </div>
    </main>
    <button class="primary" data-act="payplan">Выставить счёт</button>
  `);
  S.d.redraw = draw;
  draw();
}

/**
 * Экран замороженного кабинета.
 *
 * Показывается вместо всего остального: работать нельзя, а гадать почему
 * врач не должен.
 */
function frozenScreen(paidUntil) {
  render(`
    <header><h1>Кабинет заморожен</h1>
      </header>
    <main>
      <div class="card warn">
        <div class="note" style="margin:0">Календарь, склад и отчёты закрыты.
        Данные никуда не делись — после продления кабинет откроется в том же виде.</div>
      </div>
      <div class="card">
        <div class="note" style="margin:0">Записи ваших пациентов сохранены, и напоминания
        по ним продолжают уходить. Отменять чужой приём из-за подписки мы не станем.</div>
      </div>
    </main>
    <button class="primary" data-act="billing">Продлить подписку</button>
  `);
}

/** Пациент видит паузу, а не долг: он ни при чём. */
function pausedScreen(phone) {
  render(`
    <header><h1>Онлайн-запись недоступна</h1></header>
    <main>
      <div class="card">
        <div class="note" style="margin:0">Кабинет временно не принимает записи
        через приложение.${phone ? ' Позвоните — вас запишут.' : ' Свяжитесь с врачом напрямую.'}</div>
        ${phone ? `<div class="row" style="margin-top:12px"><span class="muted">Телефон</span>
          <a href="tel:${esc(phone)}" class="tel">${esc(phone)}</a></div>` : ''}
      </div>
    </main>
  `);
}

/* ── Ссылки ──────────────────────────────────────────────────────────── */

async function docLink() {
  markSeen('link');
  spinner('Готовим ссылку…');
  const { link } = await api('/doctor/link');
  S.d.link = link;
  render(`
    <header><h1>Ссылка для пациентов</h1>
      </header>
    <main>
      <div class="card">
        <div class="linkbox mono">${esc(link)}</div>
        <div class="note">Разместите её в профиле, на визитке и в сообщениях пациентам.
        73% онлайн-записей делаются в нерабочее время, когда позвонить в кабинет невозможно.</div>
      </div>
    </main>
    <button class="primary" data-act="copylink">Скопировать ссылку</button>
  `);
}

async function docInvite() {
  spinner('Готовим приглашение…');
  const inv = await api('/doctor/invite', { method: 'POST' });
  S.d.link = inv.link;
  render(`
    <header><h1>Приглашение в кабинет</h1>
      </header>
    <main>
      <div class="card warn">
        <div class="linkbox mono">${esc(inv.link)}</div>
        <div class="note">Кто откроет эту ссылку — получит полный доступ к кабинету:
        календарь, выручка, себестоимость, база пациентов. Ссылка гаснет после
        первого использования и через сутки.</div>
      </div>
    </main>
    <button class="primary" data-act="copylink">Скопировать ссылку</button>
  `);
}

/* ── Расписание ──────────────────────────────────────────────────────── */

async function docSchedule() {
  spinner('Загрузка…');
  const { workingHours, overrides, settings } = await api('/doctor/schedule');
  S.d.hours = workingHours.map((h) => ({ weekday: h.weekday, startsAt: h.starts_at.slice(0, 5), endsAt: h.ends_at.slice(0, 5) }));
  S.d.settings = { ...settings };
  S.d.overrides = overrides;
  S.d.newOverride = { date: addDays(localDate(), 1), reason: '' };

  const draw = () => {
    const byDay = new Map();
    for (const h of S.d.hours) byDay.set(h.weekday, [...(byDay.get(h.weekday) ?? []), h]);
    const ov = S.d.newOverride;
    render(`
      <header><h1>Рабочие часы</h1></header>
      <main>
        <div class="card">
          ${[1, 2, 3, 4, 5, 6, 0].map((wd) => {
            const list = (byDay.get(wd) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            return `<div class="wday">
              <button class="toggle ${list.length ? 'on' : ''}" data-wd="${wd}"
                aria-pressed="${list.length ? 'true' : 'false'}">${WEEKDAYS[wd]}</button>
              <div class="intervals">
                ${list.length ? list.map((h, i) => `<span class="iv">
                  <input type="time" value="${h.startsAt}" data-edit="${wd}:${i}:start" step="900"
                    aria-label="${WEEKDAYS[wd]}, начало">
                  <span class="dash">–</span>
                  <input type="time" value="${h.endsAt}" data-edit="${wd}:${i}:end" step="900"
                    aria-label="${WEEKDAYS[wd]}, конец">
                  <button class="x" data-rm="${wd}:${i}" aria-label="Убрать интервал">×</button>
                </span>`).join('') : '<span class="muted">выходной</span>'}
                ${list.length ? `<button class="addiv" data-add="${wd}">+ перерыв</button>` : ''}
              </div>
            </div>`;
          }).join('')}
          <div class="note">Обед — это два интервала, а не дырка в одном.
          «+ перерыв» делит самый длинный интервал дня пополам и оставляет между
          половинами час; границы потом можно подвинуть.</div>
        </div>
        <div class="card">
          <div class="row"><span class="muted">Записываться не позже чем за</span>
            <span><input type="number" min="0" max="1440" step="30" class="num"
              value="${S.d.settings?.min_notice_minutes ?? 120}" data-set="min_notice_minutes"> мин</span></div>
          <div class="row"><span class="muted">Зазор после приёма</span>
            <span><input type="number" min="0" max="60" step="5" class="num"
              value="${S.d.settings?.buffer_minutes ?? 10}" data-set="buffer_minutes"> мин</span></div>
          <div class="row"><span class="muted">Запись вперёд на</span>
            <span><input type="number" min="1" max="365" class="num"
              value="${S.d.settings?.max_days_ahead ?? 30}" data-set="max_days_ahead"> дн</span></div>
        </div>

        <div class="sectiontitle">Отдельный день</div>
        <div class="card">
          <label class="fieldlabel">Дата</label>
          <input class="field" type="date" id="ovdate" value="${ov.date}" min="${localDate()}">
          <label class="fieldlabel">Причина — увидите только вы</label>
          <input class="field" id="ovreason" placeholder="Конференция, отпуск" value="${esc(ov.reason)}">
          <button class="mini" data-act="dayoff">Сделать выходным</button>
          <div class="note">Разовый выходной, который не меняет обычную неделю.
          Записи на этот день, если они есть, останутся — их нужно отменить вручную
          из календаря, чтобы пациент получил причину.</div>
        </div>

        ${S.d.overrides.length ? `<div class="sectiontitle">Уже назначены</div>
        <div class="card">${S.d.overrides.map((o) => `<div class="row">
          <span>${dateLabel(o.on_date)} — ${o.is_closed ? 'выходной' : `${o.starts_at.slice(0, 5)}–${o.ends_at.slice(0, 5)}`}${o.reason ? ` · ${esc(o.reason)}` : ''}</span>
          <button class="x" data-rmov="${o.id}" aria-label="Убрать">×</button>
        </div>`).join('')}</div>` : ''}
      </main>
      <button class="primary" data-act="savesched">Сохранить</button>
    `);
  };

  // Любая перерисовка стирает то, что врач уже набрал в полях времени:
  // экран строится из S.d.hours, а не из DOM. Поэтому перед КАЖДОЙ
  // перерисовкой введённое втягивается в состояние.
  S.d.redraw = draw;
  draw();
}

/** Втянуть введённое в поля обратно в состояние экрана расписания. */
function syncSchedule() {
  for (const inp of document.querySelectorAll('[data-edit]')) {
    const [wd, i, side] = inp.dataset.edit.split(':');
    const list = S.d.hours.filter((h) => h.weekday === Number(wd))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const t = list[Number(i)];
    if (t && inp.value) t[side === 'start' ? 'startsAt' : 'endsAt'] = inp.value;
  }
  for (const inp of document.querySelectorAll('[data-set]')) {
    S.d.settings = { ...S.d.settings, [inp.dataset.set]: Number(inp.value) };
  }
  const d = document.getElementById('ovdate');
  const r = document.getElementById('ovreason');
  if (d) S.d.newOverride = { date: d.value || S.d.newOverride.date, reason: r?.value.trim() ?? '' };
}

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* ══════════════════════════════════════════════════════════════════════════
   ПАЦИЕНТ
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Первая вкладка пациента.
 *
 * Кабинет выбран — прайс этого кабинета, потому что записаться к своему
 * стоматологу это одно касание. Не выбран — поиск: человек пришёл по
 * рекламе, ссылки у него нет, и упираться в «кабинет не выбран» ему незачем.
 */
function patBook() {
  return S.d.me?.tenantId ? patServices() : needLink();
}

async function patServices() {
  const [info, my] = await tabData('book', () => Promise.all([
    api('/book/info'), api('/book/my').catch(() => ({ appointments: [] })),
  ]), 'Загрузка…');
  S.d.info = info;
  const upcoming = (my.appointments ?? []).filter((a) => !a.past && a.status !== 'cancelled');

  render(`
    <header><h1>${esc(info.cabinet)}</h1></header>
    <main>
      ${S.d.me?.ownLink ? `<div class="card warn">
        <div class="name">Это ваша ссылка для пациентов</div>
        <div class="note" style="margin-top:6px">Так её видят те, кому вы её отправите.
        Записываться по ней самому не нужно.</div>
        <button class="mini" data-act="switcher">Вернуться в кабинет</button>
      </div>` : ''}
      ${upcoming.length ? `<div class="card ok">
        <div class="name">Вы записаны</div>
        ${upcoming.map((a) => `<div class="row"><span>${esc(a.service)}</span>
          <span class="mono">${dateLabel(a.startsAt.slice(0, 10), { day: 'numeric', month: 'short' })}, ${hhmm(a.startsAt)}</span></div>`).join('')}
        <button class="mini" data-act="myappts">Мои записи</button>
      </div>` : ''}
      <div class="sectiontitle">Выберите услугу</div>
      <div class="picker">
        ${info.services.map((s) => `<button data-svc="${s.id}">
          <div class="name">${esc(s.name)}</div>
          <div class="price">${money(s.price)} сум · ${s.durationMinutes} мин${
            s.consultation ? ' · не знаете, что нужно — выберите это' : ''}</div>
        </button>`).join('')}
      </div>
      <div class="note" style="margin:12px">Что именно делать, решит врач на осмотре.
      Если не уверены — записывайтесь на приём, цену пересчитают по факту.</div>
    </main>
  `);
}

async function patSlots(service) {
  S.d.service = service;
  spinner('Ищем свободное время…');
  const { days } = await api(`/book/slots?serviceId=${service.id}&days=21`);
  if (!days.length) {
    return render(`<header><h1>${esc(service.name)}</h1></header>
      <div class="empty">На ближайшие недели свободного времени нет.<br>Попробуйте другую услугу.</div>`);
  }
  S.d.days = days;
  S.d.pickedDate = days[0].date;

  // Все свободные дни одной прокручиваемой лентой. Раньше рисовались только
  // первые четырнадцать двумя рядами, и остальные дни были недостижимы.
  const stripHtml = (sel) => days.map((d) => `
    <button class="daychip ${d.date === sel ? 'on' : ''}" data-date="${d.date}"
      aria-pressed="${d.date === sel}" aria-label="${esc(d.label)}">
      <span class="dw">${d.weekday}</span><span class="dn">${dayNum(d.date)}</span>
      <span class="dd">${d.times.length}</span>
    </button>`).join('');

  const timesHtml = (day) => `
    <div class="sectiontitle">${esc(day.label)} — свободно ${day.times.length}</div>
    <div class="times">${day.times.map((t) => `<button data-time="${t}">${hhmm(t)}</button>`).join('')}</div>`;

  render(`
    <header><h1>${esc(service.name)}</h1>
      </header>
    <div class="weekstrip scroll" id="patstrip">${stripHtml(S.d.pickedDate)}</div>
    <main id="pattimes">${timesHtml(days[0])}</main>
  `);

  // Смена дня трогает только сетку времени: заголовок и лента дней остаются
  // на месте, иначе экран рывком перестраивается под пальцем.
  S.d.redraw = () => {
    const day = days.find((d) => d.date === S.d.pickedDate) ?? days[0];
    const strip = document.getElementById('patstrip');
    const times = document.getElementById('pattimes');
    if (!strip || !times) return;
    strip.querySelectorAll('[data-date]').forEach((b) => {
      const on = b.dataset.date === day.date;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    times.className = '';
    void times.offsetWidth;
    times.className = 'fade-up';
    times.innerHTML = timesHtml(day);
  };
}

function patConfirm(startsAt) {
  // Без подтверждённого номера записаться нельзя: врачу нужно, куда звонить,
  // а введённый руками номер проверить невозможно.
  if (!S.d.me?.phone) return phoneGate(startsAt);
  const s = S.d.service;
  render(`
    <header><h1>Подтверждение</h1></header>
    <main>
      <div class="card">
        <div class="row"><span class="muted">Услуга</span><span class="name">${esc(s.name)}</span></div>
        <div class="row"><span class="muted">Когда</span><span class="mono name">${
          dateLabel(startsAt.slice(0, 10), { day: 'numeric', month: 'long', weekday: 'short' })}, ${hhmm(startsAt)}</span></div>
        <div class="row"><span class="muted">Стоимость</span><span class="mono">${money(s.price)} сум</span></div>
      </div>
      <div class="card">
        <label class="fieldlabel">Ваше имя</label>
        <input class="field" id="pname" placeholder="Как к вам обращаться" autocomplete="name"
               value="${esc(S.d.me?.fullName ?? '')}">
        <div class="row"><span class="muted">Телефон</span>
          <span class="name mono">${esc(S.d.me?.phone ?? '')}</span></div>
        <label class="fieldlabel">Что беспокоит — необязательно</label>
        <input class="field" id="pnote" placeholder="Болит при холодном">
        <div class="note">Больше ничего не нужно. Остальное врач спросит на приёме.</div>
      </div>
    </main>
    <button class="primary" data-act="dobook" data-at="${startsAt}">Записаться</button>
  `);
  setTimeout(() => document.getElementById('pname')?.focus(), 80);
}

function patCancel(apptId) {
  const a = (S.d.myAppts ?? []).find((x) => x.id === apptId);
  if (!a) return patMy();
  render(`
    <header><h1>Отменить запись?</h1></header>
    <main>
      <div class="card">
        <div class="row"><span class="muted">Услуга</span><span class="name">${esc(a.service)}</span></div>
        <div class="row"><span class="muted">Когда</span><span class="mono name">${
          dateLabel(a.startsAt.slice(0, 10), { day: 'numeric', month: 'long', weekday: 'short' })}, ${hhmm(a.startsAt)}</span></div>
        <div class="note">Врач получит сообщение и сможет отдать это время другому.
        Если планы просто сдвинулись — лучше отменить сейчас, а не в день приёма.</div>
      </div>
      <div class="picker">
        <button data-act="keepappt"><div class="name">Оставить как есть</div>
          <div class="price">вернуться назад</div></button>
      </div>
    </main>
    <button class="primary danger" data-act="docancelmy" data-id="${apptId}">Да, отменить</button>
  `);
}

/**
 * Перенос записи.
 *
 * Сетка та же, что при первичной записи, но с одним отличием: собственная
 * бронь из расчёта исключена. Иначе человек с приёмом в 10:00 не увидел бы
 * ни 10:15, ни 10:30 — их закрывал бы он сам, и самый частый перенос,
 * «сдвинуть немного», оказался бы невозможен.
 *
 * Отдельная операция, а не «отменить и записаться заново»: между двумя
 * действиями слот успевает уйти, и человек, который сдвигал время на час,
 * остаётся без приёма вовсе.
 */
async function patReschedule(apptId) {
  spinner('Ищем свободное время…');
  const { current, days } = await api(`/me/appointments/${apptId}/slots?days=21`);
  const wasLine = `${dateLabel(current.startsAt.slice(0, 10), { day: 'numeric', month: 'long' })}, ${hhmm(current.startsAt)}`;

  if (!days.length) {
    return render(`
      <header><h1>Перенести приём</h1></header>
      <main><div class="card warn">
        <div class="name">Свободного времени нет</div>
        <div class="note" style="margin-top:6px">На ближайшие три недели окон не осталось.
        Позвоните в кабинет — врач подберёт время вручную.</div>
      </div></main>`);
  }

  S.d.resched = { apptId, current, days };
  S.d.pickedDate = days[0].date;

  const stripHtml = (sel) => days.map((d) => `
    <button class="daychip ${d.date === sel ? 'on' : ''}" data-date="${d.date}"
      aria-pressed="${d.date === sel}" aria-label="${esc(d.label)}">
      <span class="dw">${d.weekday}</span><span class="dn">${dayNum(d.date)}</span>
      <span class="dd">${d.times.length}</span>
    </button>`).join('');

  const timesHtml = (day) => `
    <div class="sectiontitle">${esc(day.label)} — свободно ${day.times.length}</div>
    <div class="times">${day.times.map((t) => `
      <button data-rtime="${t}" ${t === current.startsAt ? 'disabled' : ''}>${hhmm(t)}</button>`).join('')}</div>`;

  render(`
    <header><h1>Перенести приём</h1>
      </header>
    <div class="weekstrip scroll" id="rstrip">${stripHtml(S.d.pickedDate)}</div>
    <main id="rtimes">${timesHtml(days[0])}</main>
  `);

  // Смена дня трогает только сетку времени: заголовок и лента дней остаются
  // на месте, иначе экран рывком перестраивается под пальцем.
  S.d.redraw = () => {
    const day = days.find((d) => d.date === S.d.pickedDate) ?? days[0];
    const strip = document.getElementById('rstrip');
    const times = document.getElementById('rtimes');
    if (!strip || !times) return;
    strip.querySelectorAll('[data-date]').forEach((b) => {
      const on = b.dataset.date === day.date;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    times.className = '';
    void times.offsetWidth;
    times.className = 'fade-up';
    times.innerHTML = timesHtml(day);
  };
}

/** Отдельный шаг подтверждения: перенос одним касанием — потерянное время. */
function patReschedConfirm(startsAt) {
  const r = S.d.resched;
  if (!r) return patMy();
  render(`
    <header><h1>Перенести?</h1></header>
    <main>
      <div class="card">
        <div class="row"><span class="muted">Услуга</span><span class="name">${esc(r.current.service)}</span></div>
        <div class="row"><span class="muted">Было</span><span class="mono">${
          dateLabel(r.current.startsAt.slice(0, 10), { day: 'numeric', month: 'long', weekday: 'short' })}, ${hhmm(r.current.startsAt)}</span></div>
        <div class="row"><span class="muted">Станет</span><span class="mono name">${
          dateLabel(startsAt.slice(0, 10), { day: 'numeric', month: 'long', weekday: 'short' })}, ${hhmm(startsAt)}</span></div>
        <div class="note">Врач получит сообщение, а прежнее время освободится для другого пациента.</div>
      </div>
    </main>
    <button class="primary" data-act="doresched" data-id="${r.apptId}" data-at="${startsAt}">Перенести</button>
  `);
}

/**
 * Подтверждение номера.
 *
 * Номер присылает сам Telegram служебным сообщением боту — подделать его
 * нельзя, а в приложении вводить нечего. Приложение лишь ждёт, пока номер
 * появится: записывает его вебхук бота, а не браузер пациента.
 */
function phoneGate(startsAt) {
  const s = S.d.service;
  render(`
    <header><h1>Нужен ваш номер</h1>
      </header>
    <main>
      <div class="card">
        <div class="note" style="margin:0">Врач должен знать, куда звонить, если приём
        придётся перенести. Telegram пришлёт номер сам — вводить и проверять
        ничего не нужно.</div>
      </div>
      <div class="card">
        <div class="note" style="margin:0">Мы не показываем ваш номер никому, кроме
        кабинета, в который вы записываетесь.</div>
      </div>
    </main>
    <button class="primary" data-act="sharephone" data-at="${startsAt}">Поделиться номером</button>
  `);
}

/**
 * Ждём, пока номер приедет от Telegram.
 *
 * Номер записывает вебхук бота, а не браузер: приложение только видит, что
 * он появился. Куда идти дальше — дело вызвавшего: с экрана записи это
 * продолжение записи, из профиля — просто обновлённая карточка.
 */
async function awaitPhone(attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const me = await api('/me').catch(() => null);
    if (me?.phone) { S.d.me = me; toast('Номер подтверждён'); return true; }
  }
  return false;
}

/**
 * План лечения глазами пациента.
 *
 * Главный страх человека в частной стоматологии — «меня разводят». Против
 * него работает не убеждение, а список: что именно сделают, в каком порядке,
 * почём и что уже сделано. Себестоимости здесь нет и не приходит с сервера:
 * пациенту отдаётся другой набор полей, а не тот же с погашенными колонками.
 */
function patPlan(planId) {
  const p = (S.d.myPlans ?? []).find((x) => x.id === planId);
  if (!p) return patMy();
  const left = Number(p.total) - Number(p.donePart);

  render(`
    <header><h1>${esc(p.title)}</h1></header>
    <main>
      ${p.stages.map((st) => `
        <div class="sectiontitle">Этап ${st.stage}${
          st.items.every((i) => i.status === 'done') ? ' — сделан' : ''}</div>
        <div class="card">${st.items.map((i) => `
          <div class="row">
            <span>${i.status === 'done' ? '✓ ' : ''}${esc(i.service)}${
              i.tooth ? ` · зуб ${esc(i.tooth)}` : ''}${i.quantity > 1 ? ` · ${i.quantity}` : ''}</span>
            <span class="mono ${i.status === 'done' ? 'muted' : ''}">${money(i.price)}</span>
          </div>`).join('')}</div>`).join('')}

      <div class="sectiontitle">Деньги</div>
      <div class="card">
        <div class="row"><span class="muted">Весь план</span>
          <span class="mono">${money(p.total)} сум</span></div>
        <div class="row"><span class="muted">Уже сделано</span>
          <span class="mono">${money(p.donePart)} сум</span></div>
        <div class="row"><span class="muted">Осталось</span>
          <span class="mono">${money(left)} сум</span></div>
        <div class="row"><span class="name">${
          Number(p.balance.debt) > 0 ? 'К оплате сейчас' : 'Задолженности нет'}</span>
          <span class="mono name">${money(Math.max(0, Number(p.balance.debt)))} сум</span></div>
        <div class="note">К оплате — только за то, что уже сделано. За будущие этапы
        платить заранее не нужно.</div>
      </div>
    </main>
  `);
}

/* ── Зубная карта ──────────────────────────────────────────────────────
   Зубы — настоящие анатомические рисунки, а не силуэты из четырёх кривых:
   врач узнаёт моляр по трём корням, а не по подписи. Набор взят готовым
   (React Advanced Odontogram, Zoltán Dul, MIT) — исходники и лицензия лежат
   в vendor/teeth, спрайт собирается scripts/build-teeth.mjs.

   Раскладка рядами, как в любой зубной карте: коронки, жевательные
   поверхности, снова поверхности, коронки. Дугу пробовал — с настоящими
   рисунками она врёт: повёрнутый на семьдесят градусов моляр не читается
   как моляр. */

const FDI = {
  upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
  upperMilk: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
  lowerMilk: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
};
const isMilkTooth = (n) => Number(String(n)[0]) >= 5;

/** Тип зуба по номеру. У молочных четвёртый и пятый — моляры, премоляров нет. */
function toothKind(n) {
  const pos = Number(String(n)[1]);
  if (pos <= 2) return 'incisor';
  if (pos === 3) return 'canine';
  if (isMilkTooth(n)) return 'molar';
  return pos <= 5 ? 'premolar' : 'molar';
}

/** Жевательная поверхность есть у премоляров и моляров; у резцов её не рисуют. */
const hasOcclusal = (n) => ['premolar', 'molar'].includes(toothKind(n));

// Спрайт кладём в документ один раз: тридцать два зуба ссылаются на двенадцать
// силуэтов, а не тащат за собой по сто пятьдесят кривых каждый.
let spriteIn = false;
function ensureSprite() {
  if (spriteIn) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  box.innerHTML = TEETH_SPRITE;
  document.body.appendChild(box);
  spriteIn = true;
}

const W = 40;      // ШИРИНА места под зуб в пикселях, не количество зубов
const CROWN = 72;  // высота коронки с корнем
// Жевательная поверхность шире, чем выше (48×41 в исходнике). Ставим её в
// клетку по этой пропорции: в квадратной коробке она висела бы посередине,
// оторванная от своей же коронки.
const OCCL = 28;
const PAD = 15;    // поле под номера сверху и снизу

/** Поставить силуэт в клетку, при надобности отзеркалив. */
const place = (sym, x, y, w, h, mx = 1, my = 1) =>
  `<use href="#${sym}" width="${w}" height="${h}" transform="translate(${
    (x + (mx < 0 ? w : 0)).toFixed(1)} ${(y + (my < 0 ? h : 0)).toFixed(1)}) scale(${mx} ${my})"/>`;

/**
 * Один ряд челюсти.
 *
 * `up` — верхняя челюсть: коронки корнями вверх, жевательная поверхность под
 * ними. У нижней всё зеркально по вертикали, чтобы ряды смотрели друг на
 * друга, как во рту.
 *
 * Половины зеркалим по горизонтали: рисунок один, а зубы слева и справа —
 * отражения. Так делает и сам набор, иначе пришлось бы держать 32 файла.
 */
/**
 * Какая отметка красит зуб.
 *
 * Отметок на зубе может быть несколько сразу — на 26 и кариес, и пломба, и
 * запломбированный канал. Красить зуб всеми значит не покрасить ничем,
 * поэтому цвет берёт одна, самая тяжёлая: нет зуба важнее коронки, коронка
 * важнее кариеса, кариес важнее состояния канала. Остальные — точками.
 */
const MARK_WEIGHT = { state: 0, build: 1, lesion: 2, endo: 3, perio: 4 };
const leadMark = (list) => (list ?? []).slice()
  .sort((a, b) => (MARK_WEIGHT[a.category] ?? 9) - (MARK_WEIGHT[b.category] ?? 9))[0];

function jawRow(numbers, { up, marks, states, selected, milk, top, dots, mirror }) {
  return numbers.map((t, i) => {
    const x = i * W;
    const pre = milk ? 't-milk-' : 't-';
    const kind = toothKind(t);
    const crownY = up ? top : top + OCCL + 4;
    const occlY = up ? top + CROWN + 4 : top;

    const on = selected.includes(String(t));
    const done = marks[t];
    const mine = states[t] ?? [];
    const lead = leadMark(mine);
    const label = [
      `зуб ${t}`,
      mine.length ? mine.map((m) => m.name.toLowerCase()).join(', ') : null,
      done ? `${done} ${plural(done, 'запись', 'записи', 'записей')}` : null,
    ].filter(Boolean).join(', ');

    // Заливка поверх рисунка, а не вместо него: multiply красит эмаль,
    // оставляя корень, пульпу и разницу между моляром и резцом.
    // Красим КОРОНКУ, а не весь зуб: корни цветом кариеса — это уже другой
    // диагноз. Коронка занимает примерно нижние 55% рисунка у верхней
    // челюсти и верхние у нижней, потому что рисунок перевёрнут.
    const tintH = CROWN * 0.55;
    const tint = lead ? `<rect class="tint" x="${x + 4}"
        y="${up ? crownY + CROWN - tintH : crownY}" width="${W - 8}"
        height="${tintH}" rx="5" fill="${lead.color}"/>` : '';
    const dotRow = dots && mine.length ? mine.slice(0, 4).map((m, k) =>
      `<circle class="dot" cx="${x + W / 2 + (k - (Math.min(mine.length, 4) - 1) / 2) * 7}"
        cy="${up ? top + CROWN + OCCL + 10 : top - 8}" r="2.6" fill="${m.color}"/>`).join('') : '';

    return `<g class="tooth${done ? ' done' : ''}${on ? ' on' : ''}${lead ? ' marked' : ''}"
      data-tooth="${t}" role="button" tabindex="0" aria-label="${label}">
      <rect class="cell" x="${x + 1}" y="${top - (up ? PAD - 2 : 4)}" width="${W - 2}"
        height="${CROWN + OCCL + PAD + 6}" rx="7"/>
      ${place(`${pre}${kind}`, x + 3, crownY, W - 6, CROWN, mirror, up ? 1 : -1)}
      ${tint}
      ${hasOcclusal(t)
        ? place(`${pre}occl-${kind}`, x + 3, occlY, W - 6, OCCL, mirror, up ? 1 : -1)
        : ''}
      ${dotRow}
      <text class="num" x="${x + W / 2}" y="${up ? top - 5 : top + OCCL + CROWN + 16}">${t}</text>
    </g>`;
  }).join('');
}

/**
 * Зубная карта: обе челюсти, состояние и выбор.
 *
 * `marks` — сколько записей на зубе; закрашенный зуб значит «здесь лечили»,
 * а не «здесь болит»: карта собирается из истории, а не из диагнозов,
 * которых мы не ведём.
 *
 * Отметка — подложка под зубом, а не перекраска самого зуба: рисунок залит
 * градиентами, и перекрасить его значит потерять и корень, и пульпу.
 */
/**
 * Половина рта: верхние и нижние зубы одной стороны, в прикусе.
 *
 * Восемь зубов в ряду умещаются на экран телефона целиком, шестнадцать —
 * нет. Делим по СТОРОНАМ, а не по челюстям: врач работает с одной стороной
 * и видит, что чему противостоит — верхняя шестёрка над нижней шестёркой.
 */
function halfChart(up, low, { marks, states, selected, milk, dots, mirror, label }) {
  const width = up.length * W;
  const topRow = PAD;
  const botRow = PAD + CROWN + OCCL + 18;
  const height = botRow + CROWN + OCCL + PAD + 10;
  return `<div class="half">
    <div class="half-label">${label}</div>
    <svg class="chart" viewBox="0 0 ${width} ${height}"
        role="group" aria-label="Зубы: ${label}">
      <g>${jawRow(up, { up: true, marks, states, selected, milk, top: topRow, dots, mirror })}</g>
      <g>${jawRow(low, { up: false, marks, states, selected, milk, top: botRow, dots, mirror })}</g>
    </svg>
  </div>`;
}

/**
 * Зубная формула: все 32 зуба сразу.
 *
 * Ряд из шестнадцати зубов не влезает в телефон, если зуб должен быть
 * различим. Сначала я ужал зубы — стало не разглядеть; потом добавил
 * прокрутку — и формула перестала быть формулой: врач видел девять зубов
 * из тридцати двух и справедливо спрашивал, где остальные. Ответ не в
 * размере и не в прокрутке, а в делении: две половины рта, обе целиком на
 * экране, каждый зуб со своим номером.
 */
function toothChart({ marks = {}, states = {}, selected = [], milk = false, dots = false }) {
  ensureSprite();
  const up = milk ? FDI.upperMilk : FDI.upper;
  const low = milk ? FDI.lowerMilk : FDI.lower;
  const h = up.length / 2;
  const common = { marks, states, selected, milk, dots };
  return halfChart(up.slice(0, h), low.slice(0, h),
      { ...common, mirror: 1, label: 'Правая сторона' })
    + halfChart(up.slice(h), low.slice(h),
      { ...common, mirror: -1, label: 'Левая сторона' });
}

/** Карточка с картой: легенда и переключатель молочных. */
/**
 * Карточка с картой.
 *
 * `wide` разводит два разных дела. Смотреть карту — значит видеть весь рот
 * сразу, и она вписывается в ширину: зуб выходит около 21px, но по нему и не
 * целятся. Выбирать зуб — значит попадать, и там карта шире экрана и
 * прокручивается вбок: 35px на зуб. Тридцать два зуба в ширину телефона с
 * запасом на промах не помещаются, и делать вид, что помещаются, хуже.
 */

function chartCard({ marks = {}, states = {}, selected = [], milk = false, note = '', wide = false, legend = true }) {
  // Сколько отмечено на ТОЙ челюсти, которая сейчас не показана. Без этого
  // врач отмечает молочный зуб, переключается обратно и видит пустую карту:
  // отметка на месте, но её не видно, а понять это неоткуда.
  const other = [...Object.keys(marks), ...Object.keys(states)]
    .filter((t) => isMilkTooth(t) !== milk).length;
  // Переключатель показывается ВСЕГДА. Раньше он появлялся только когда на
  // молочных уже что-то отмечено — а отметить их было нечем, потому что
  // переключателя не было. Детского пациента завести было невозможно.
  return `<div class="card">
    <div class="chart-wrap${wide ? ' wide' : ''}">${
      toothChart({ marks, states, selected, milk, dots: wide })}</div>
    <div class="chart-legend">
      <span class="done"><i></i>лечили</span>
      <span class="sel"><i></i>выбран</span>
      <button class="mini" data-act="milk" data-on="${milk ? '' : '1'}">${
        milk ? 'Постоянные зубы' : 'Молочные зубы'}${other ? ` · ${other}` : ''}</button>
    </div>
    ${note ? `<div class="note">${note}</div>` : ''}
  </div>`;
}

/** Сколько записей на каждом зубе. Из истории, а не из отдельной таблицы. */
const toothMarks = (entries) => entries.reduce((m, e) => (
  e.tooth ? { ...m, [e.tooth]: (m[e.tooth] ?? 0) + 1 } : m), {});

/**
 * Выбор зуба.
 *
 * Отдельный экран, а не поле в форме. Ввод «26» руками — это ввод с
 * опечатками: 62 вместо 26 проходит проверку формата и попадает в историю
 * как другой зуб. С картой промахнуться можно только в соседний, а
 * выбранный зуб ещё и назван словом внизу.
 */
function toothPick(cfg) {
  S.d.pick = { milk: false, value: [], marks: {}, many: false, ...cfg };
  S.d.pick.value = (S.d.pick.value ?? []).map(String);
  drawToothPick();
}

function drawToothPick() {
  const p = S.d.pick;
  const n = p.value.length;
  return render(`
    <header><h1>${esc(p.title ?? 'Какой зуб')}</h1>
      </header>
    <main>
      ${chartCard({
        marks: p.marks, selected: p.value, milk: p.milk, wide: true,
        note: p.many
          ? 'Лечили несколько зубов — отметьте все. Услуга внесётся один раз, а в карте появится запись по каждому зубу.'
          : '',
      })}
      <div class="card">
        <div class="row"><span class="muted">${n > 1 ? 'Выбраны' : 'Выбран'}</span>
          <span class="mono name">${n ? `${n > 1 ? 'зубы ' : 'зуб '}${p.value.join(', ')}` : 'ничего'}</span></div>
        ${n ? '<button class="mini" data-act="notooth">Снять выбор</button>' : ''}
      </div>
    </main>
    <button class="primary" data-act="picktooth"${n ? '' : ' disabled'}>${
      n === 0 ? 'Выберите зуб на карте'
      : n === 1 ? `Это зуб ${p.value[0]}`
      : `Это ${n} ${plural(n, 'зуб', 'зуба', 'зубов')}: ${p.value.join(', ')}`}</button>
  `);
}

/**
 * Медицинская карта — общий вид для обеих сторон.
 *
 * Один и тот же список читают пациент и врач: разными их делает не вёрстка,
 * а право, и оно проверяется в базе. Две отдельные разметки для одних и тех
 * же данных разъехались бы через месяц, и разъехались бы молча.
 *
 * Уточнения не идут отдельными строками: дополнение без записи, к которой
 * оно относится, читается как самостоятельное лечение. Оно встаёт под своей
 * записью — так следующий врач видит и что записали, и что потом уточнили.
 */
function recordList(entries, { amendable = false } = {}) {
  const roots = entries.filter((e) => !e.amends);
  const byParent = new Map();
  for (const e of entries.filter((x) => x.amends)) {
    byParent.set(e.amends, [...(byParent.get(e.amends) ?? []), e]);
  }

  const byDate = new Map();
  for (const e of roots) byDate.set(e.occurredOn, [...(byDate.get(e.occurredOn) ?? []), e]);

  const who = (e) => `${esc(e.cabinet)}${e.doctor ? `, ${esc(e.doctor)}` : ''}${
    e.cabinetGone ? ' <span class="muted">(кабинет закрыт)</span>' : ''}`;

  // Год — только если он не нынешний: «4 СЕНТЯБРЯ 2026 Г.» в заголовке
  // раздела читается хуже, чем «4 СЕНТЯБРЯ», а в старых записях год нужен.
  const thisYear = String(new Date().getFullYear());
  const head = (d) => dateLabel(d, d.slice(0, 4) === thisYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' }).replace(' г.', '');

  return [...byDate.entries()].map(([date, list]) => `
    <div class="sectiontitle">${head(date)}</div>
    <div class="card">${list.map((e) => `
      <div class="row"><span class="name">${esc(e.service)}${
        e.tooth ? ` · зуб ${esc(e.tooth)}` : ''}${e.quantity > 1 ? ` · ${e.quantity}` : ''}<br>
        <span class="muted">${who(e)}</span></span></div>
      ${e.note ? `<div class="note" style="margin:2px 0 8px">${esc(e.note)}</div>` : ''}
      ${(byParent.get(e.id) ?? []).map((a) => `
        <div class="note" style="margin:2px 0 8px"><b>Уточнение</b> от ${
          dateLabel(a.occurredOn, { day: 'numeric', month: 'short' })}, ${who(a)}:<br>${esc(a.note ?? '')}</div>`).join('')}
      ${amendable ? `<button class="mini" data-amend="${e.id}">Уточнить эту запись</button>` : ''}
    `).join('')}</div>`).join('');
}

/**
 * Карта пациента у него самого.
 *
 * Смысл всего продукта в одном экране: человек уходит от врача, переезжает
 * в другой город — и лечение уходит вместе с ним. Поэтому карта читается
 * без активного кабинета и показывает записи кабинетов, которых уже нет.
 */
async function patRecord() {
  const [rec, teeth] = await tabData('card', () => Promise.all([
    api('/me/record').catch(() => ({ entries: [] })),
    api('/me/teeth').catch(() => ({ marks: [] })),
  ]), 'Открываем карту…');
  S.d.myRecord = rec.entries ?? [];
  S.d.myTeeth = teeth.marks ?? [];
  S.d.recTooth = null;
  return drawPatRecord();
}

/** Отрисовка своей карты из уже полученного: выбор зуба не ходит в сеть. */
function drawPatRecord() {
  const entries = S.d.myRecord ?? [];
  const roots = entries.filter((e) => !e.amends);
  const cabinets = new Set(entries.map((e) => e.cabinet));
  const tooth = S.d.recTooth;
  const shown = tooth
    ? entries.filter((e) => e.tooth === tooth || entries.some(
        (o) => o.id === e.amends && o.tooth === tooth))
    : entries;

  render(`
    <header><h1>Моя карта</h1></header>
    <main>
      ${roots.length || (S.d.myTeeth ?? []).length ? `${chartCard({
        marks: toothMarks(entries), states: byTooth(S.d.myTeeth), milk: S.d.recMilk,
        selected: tooth ? [tooth] : [],
        note: 'Цветом — что с зубом сейчас, по отметкам врача. Нажмите зуб — останутся только его записи.',
      })}
      ${(S.d.myTeeth ?? []).length ? `<div class="card">
        <div class="sectiontitle" style="margin-top:0">Что отмечено</div>
        ${S.d.myTeeth.map((m) => `<div class="row">
          <span><i class="swatch" style="background:${m.color}"></i>${esc(m.name)} · зуб ${esc(m.tooth)}
            <br><span class="muted">${esc(m.cabinet)}${m.doctor ? `, ${esc(m.doctor)}` : ''}</span></span>
          <span class="muted mono">${dateLabel(m.notedOn, { day: 'numeric', month: 'short' })}</span>
        </div>`).join('')}
        <div class="note">Отметки ставит врач на приёме. Изменить их вы не можете —
        это его запись о том, что он видел.</div>
      </div>` : ''}
      ${tooth ? `<div class="card ok"><div class="row">
        <span class="name">Зуб ${esc(tooth)}</span>
        <button class="mini" data-act="alltooth">Все зубы</button></div></div>` : ''}
      <div class="card">
        <div class="note" style="margin:0">Это ваша карта, а не кабинета. Новый стоматолог
        увидит её, как только вы к нему запишетесь, — показывать и пересылать ничего
        не нужно. Записи нельзя изменить задним числом: ошибку врач уточняет
        дополнением, и видно оба текста.</div>
      </div>
      ${shown.length ? recordList(shown)
        : '<div class="empty">На этом зубе записей нет.</div>'}`
      : `<div class="card">
        <div class="note" style="margin:0">Здесь появится всё, что вам лечили: услуга, зуб,
        дата, кабинет и врач. Запись добавляется, когда врач закрывает приём, — и остаётся
        у вас навсегда, даже если кабинет закроется.</div>
      </div>
      <div class="empty">Пока вам ничего не лечили в Stomiko.</div>`}
    </main>
    ${TABS.some((t) => t.k === 'book')
      ? '<button class="primary" data-act="tobook">Записаться</button>'
      : '<button class="primary" data-act="findcab">Найти стоматолога</button>'}
  `);
}

/**
 * «Ещё» — всё про самого человека, а не про лечение.
 *
 * До этого раздела не было вовсе: переключение в кабинет, выбор другого
 * стоматолога и подтверждение номера жили на экране поиска, куда пациент с
 * кабинетом не заходил никогда. Врач, который лечится у коллеги, не мог
 * вернуться к себе иначе как случайно.
 */
/**
 * «Ещё» — всё про самого человека.
 *
 * Строится как список настроек, а не как набор плиток: каждая группа под
 * своим заголовком, внутри группы — ряды одной высоты, между группами
 * ничего не висит само по себе. Раньше «Я врач» стоял первой карточкой без
 * заголовка, пустое «Где вы лечитесь» показывалось абзацем-сноской, а
 * «Найти стоматолога» отваливался от своей же группы отдельной плиткой.
 *
 * Порядок — по частоте, а не по важности: сначала свои данные и свои
 * кабинеты, потом переключение в кресло врача, в самом низу — работа
 * платформы, которая касается одного человека на всю систему.
 */
async function patMore() {
  const me = S.d.me ?? {};
  const cabinets = me.patientOf ?? [];
  render(`
    <header><h1>Ещё</h1></header>
    <main>
      <div class="sectiontitle">Ваши данные</div>
      <div class="picker">
        <button data-act="profile"><div class="name">ФИО, номер и место</div>
          <div class="price">${[me.fullName || 'имя не указано',
            me.phone || 'номер не подтверждён',
            me.lat != null ? 'место есть' : 'место не отправлено'].join(' · ')}</div></button>
      </div>

      <div class="sectiontitle">Где вы лечитесь</div>
      <div class="picker">
        ${cabinets.map((c) => `<button data-pick-cab="${c.tenantId}">
          <div class="name">${esc(c.name)}${c.tenantId === me.tenantId ? ' · сейчас' : ''}</div>
          <div class="price">${c.upcoming
            ? `${c.upcoming} ${plural(c.upcoming, 'запись', 'записи', 'записей')} впереди`
            : c.lastVisit ? `последний приём ${dateLabel(c.lastVisit)}` : 'записей нет'}</div>
        </button>`).join('')}
        <button data-act="findcab">
          <div class="name">Найти ${cabinets.length ? 'другого ' : ''}стоматолога</div>
          <div class="price">по городу, названию или ориентиру</div></button>
      </div>
      ${cabinets.length ? '' : `<div class="grouphint">Пока вы никуда не записывались.
        Если стоматолог прислал ссылку — откройте её, и кабинет появится здесь сам.</div>`}

      <div class="sectiontitle">${me.canBeDoctor ? 'Ваш кабинет' : 'Если вы врач'}</div>
      <div class="picker">
        ${me.canBeDoctor
          ? `<button data-act="switcher"><div class="name">Перейти в кабинет</div>
              <div class="price">вы работаете в ${me.staffOf.length === 1 ? 'кабинете'
                : `${me.staffOf.length} кабинетах`}</div></button>`
          : `<button data-act="iamdoctor"><div class="name">Завести свой кабинет</div>
              <div class="price">или войти по приглашению коллеги</div></button>`}
      </div>

      ${me.isPlatformOwner ? `<div class="sectiontitle">Платформа</div>
      <div class="picker">
        <button data-act="adminlic"><div class="name">Проверка лицензий</div>
          <div class="price">кабинеты, которые просятся в поиск</div></button>
      </div>` : ''}
    </main>
  `);
}

async function patMy() {
  // Поздравление живёт один показ: на второй заход это уже не новость.
  // Снимаем флаг СРАЗУ в локальную переменную — экран рисуется после
  // сетевых запросов, и отложенная очистка успела бы сработать раньше.
  const justBooked = S.d.justBooked;
  S.d.justBooked = null;
  // Записи по ВСЕМ кабинетам, где человек лечится, а не только по активному:
  // он может ходить к терапевту и к ортопеду, и держать это в двух местах —
  // значит заставлять его переключаться, чтобы увидеть свои же приёмы.
  const [{ appointments }, plans] = await tabData('my', () => Promise.all([
    api('/me/appointments'),
    api('/me/plans').then((r) => r.plans).catch(() => []),
  ]), 'Загрузка…');
  S.d.myAppts = appointments;
  S.d.myPlans = plans;
  render(`
    <header><h1>Мои записи</h1></header>
    <main>
      ${(S.d.myPlans ?? []).map((p) => `
      <div class="card ${p.status === 'done' ? '' : 'ok'}" data-mplan="${p.id}">
        <div class="row"><span class="name">${esc(p.title)}<br>
          <span class="muted">${esc(p.cabinet)} · план лечения${
            p.status === 'done' ? ' · завершён' : ''}</span></span>
          <span class="mono">${money(p.total)}<small> сум</small></span></div>
        <div class="note" style="margin-top:6px">${
          Number(p.balance.debt) > 0
            ? `К оплате за сделанное: ${money(p.balance.debt)} сум.`
            : 'Задолженности нет.'} Нажмите, чтобы посмотреть этапы.</div>
      </div>`).join('')}
      ${justBooked ? `<div class="card ok">
        <div class="row"><span class="name">Вы записаны</span></div>
        <div class="note" style="margin:6px 0 0">${esc(justBooked.service)} —
        ${dateLabel(justBooked.at.slice(0, 10))}, ${hhmm(justBooked.at)}.
        Врач уже видит вашу запись. Напомним за сутки и за два часа.</div>
      </div>` : ''}
      ${S.d.noNotifications ? `<div class="card warn">
        <div class="name">Включите уведомления</div>
        <div class="note" style="margin-top:6px">Мы не сможем предупредить вас, если приём
        отменят или перенесут. Нажмите «Начать» в чате с ботом — это займёт секунду.</div>
        <button class="mini" data-act="enablenotif">Открыть чат с ботом</button>
      </div>` : ''}${appointments.length ? appointments.map((a) => `
      <div class="card ${a.status === 'cancelled' ? 'muted-card' : ''}">
        <div class="row"><span class="name">${esc(a.service)}<br>
          <span class="muted">${esc(a.cabinet)}</span></span>
          <span class="badge ${a.status === 'cancelled' ? 'overdue' : a.past ? 'closed' : 'open'}">${
            a.status === 'cancelled' ? 'отменена' : a.past ? 'прошла' : 'предстоит'}</span></div>
        <div class="row"><span class="mono">${dateLabel(a.startsAt.slice(0, 10))}, ${hhmm(a.startsAt)}</span>
          <span class="mono muted">${money(a.price)} сум</span></div>
        ${!a.past && a.status !== 'cancelled' ? `${a.confirmed
          ? '<div class="note" style="margin-top:6px">Вы подтвердили, что придёте.</div>' : ''}
          <button class="mini" data-resched="${a.id}">Перенести</button>
          <button class="mini" data-cancel="${a.id}">Отменить</button>` : ''}
      </div>`).join('') : '<div class="empty">Записей пока нет.</div>'}
    </main>
    ${S.d.me?.canBeDoctor ? `<div class="picker" style="margin-top:16px">
      <button data-act="switcher"><div class="name">Перейти в кабинет</div>
        <div class="price">вы работаете в ${S.d.me.staffOf.length === 1 ? 'кабинете' : `${S.d.me.staffOf.length} кабинетах`}</div></button>
    </div>` : ''}
    <button class="primary" data-act="tobook">Записаться</button>
  `);
}

/* ══════════════════════════════════════════════════════════════════════════
   Обработчики
   ══════════════════════════════════════════════════════════════════════════ */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-day],[data-week],[data-appt],[data-act],[data-service],[data-q],[data-tc],[data-svc],[data-date],[data-time],[data-tourgo],[data-city],[data-pick-cab],[data-cancel],[data-resched],[data-rtime],[data-tplan],[data-psvc],[data-tq],[data-trm],[data-tstage],[data-pmethod],[data-mplan],[data-wd],[data-add],[data-rm],[data-rmov],[data-rmline],[data-material],[data-batch],[data-unit],[data-pick],[data-wsvc],[data-reason],[data-patient],[data-visit],[data-free],[data-tab],[data-mode],[data-tpl],[data-spec],[data-plan],[data-amend],[data-tooth],[data-toothitem],[data-vsvc],[data-markcode],[data-markgroup],[data-clearmark]');
  if (!el) return;
  const d = el.dataset;
  haptic();

  try {
    if (d.tab !== undefined) return goTab(Number(d.tab));
    if (d.openRegistry) {
      // Номер подставлен в фильтр реестра; поиск в нём человек запускает сам —
      // страница защищена от программных обращений, и это её право.
      const url = `https://license.gov.uz/registry?filter%5Bnumber%5D=${
        encodeURIComponent(d.openRegistry)}`;
      tg?.openLink ? tg.openLink(url) : window.open(url, '_blank');
      return;
    }
    if (d.verdict) {
      const until = val(`lic-until-${d.tenant}`);
      let note = null;
      if (d.verdict === 'rejected') {
        const ok = await ask({
          title: 'Отклонить заявку?',
          body: `Врач прочитает причину и сможет прислать номер заново.
                 Без причины отказ читается как произвол.`,
          confirm: 'Отклонить',
        });
        if (!ok) return;
        note = 'Номер не найден в реестре или лицензия не действует. Проверьте номер и пришлите заново.';
      } else if (!until) {
        return toast('Укажите, до какой даты действует лицензия', true);
      }
      await api(`/admin/licenses/${d.tenant}`, { method: 'POST', body: JSON.stringify({
        verdict: d.verdict, validUntil: until || null, note }) });
      toast(d.verdict === 'verified' ? 'Лицензия подтверждена' : 'Заявка отклонена');
      return adminLicenses();
    }
    if (d.mode) {
      await api('/me/mode', { method: 'POST', body: JSON.stringify({ mode: d.mode, tenantId: d.tenant }) });
      // Режим меняет ВЕСЬ набор экранов, поэтому перечитываем себя целиком.
      const me = await api('/me');
      S.d.me = me;
      S.d.cal = null;
      dropCache();
      S.stack = [];
      S.tab = 0;
      setTabs(me.mode);
      return go(TABS[0].fn);
    }
    // Неделя уже загружена — день выбирается из памяти, без запроса и без
    // перерисовки всего экрана.
    if (d.day) return selectDay(d.day);
    if (d.week) return docWeek(addDays(S.d.weekStart, Number(d.week)));
    if (d.appt) return go(docAppointment, d.appt);
    if (d.patient) return go(docPatient, d.patient);
    if (d.amend) return go(docAmend, d.amend);

    // Нажатие по зубу значит разное на разных экранах: на выборе — выбрать,
    // на карте — оставить записи только этого зуба. Различаем по экрану,
    // а не по лишнему атрибуту на каждом из тридцати двух зубов.
    if (d.tooth) {
      const top = S.stack[S.stack.length - 1]?.[0];
      // Экран отметок: выбрана отметка — ставим её, не выбрана — показываем,
      // что на зубе уже есть. Это две разные задачи одного касания, и врач
      // различает их тем, что сам перед этим выбрал отметку.
      if (top === docTeeth) {
        const t = S.d.teeth;
        if (!t.pick) { t.tooth = t.tooth === d.tooth ? null : d.tooth; return drawDocTeeth(); }
        const r = await api(`/doctor/patients/${t.patientId}/teeth`, {
          method: 'POST', body: JSON.stringify({ tooth: d.tooth, code: t.pick }),
        });
        // Обновляем на месте, а не перезагружаем экран: врач ставит отметки
        // подряд, и круг до Франкфурта на каждый зуб — это уже не работа.
        const mark = t.palette.find((x) => x.code === r.code);
        t.marks = [...t.marks.filter((m) => !(m.tooth === d.tooth && m.category === r.category)),
          { ...mark, tooth: d.tooth, notedOn: localDate(), cabinet: S.d.me?.cabinet ?? '' }];
        t.history = [{ ...mark, tooth: d.tooth, notedOn: localDate(),
          cabinet: S.d.me?.cabinet ?? '' }, ...t.history];
        haptic('soft');
        // Пломба не отменяет кариес: это разные группы, и на одном зубе
        // бывает и то и другое. Но чаще всё-таки вылечили — поэтому такой
        // зуб раскрываем сразу, чтобы снять старую отметку было одно
        // касание, а не поиск. Решает врач, не программа.
        // Зуб на карте — 17 пикселей шириной. Врач видит, что что-то
        // покрасилось, но не читает номер. Называем словом, что и куда
        // встало: иначе промах в соседний зуб замечается через неделю.
        t.last = { tooth: d.tooth, name: mark?.name ?? '' };
        const mineNow = t.marks.filter((m) => m.tooth === d.tooth);
        if (mineNow.some((m) => m.category === 'build')
            && mineNow.some((m) => m.category === 'lesion')) {
          t.tooth = d.tooth;
        }
        return drawDocTeeth();
      }
      if (top === toothPick) {
        const p = S.d.pick;
        p.value = p.value.includes(d.tooth)
          ? p.value.filter((x) => x !== d.tooth)
          // Одиночный выбор заменяет, множественный копит. Порядок номеров —
          // как во рту, а не как нажимали: карту читают, а не вспоминают.
          : (p.many ? [...p.value, d.tooth].sort() : [d.tooth]);
        return drawToothPick();
      }
      S.d.recTooth = S.d.recTooth === d.tooth ? null : d.tooth;
      return top === docRecord ? drawDocRecord() : drawPatRecord();
    }
    if (d.markcode) {
      S.d.teeth.pick = S.d.teeth.pick === d.markcode ? null : d.markcode;
      S.d.teeth.tooth = null;
      S.d.teeth.last = null;
      return drawDocTeeth();
    }
    if (d.markgroup) {
      S.d.teeth.open = S.d.teeth.open === d.markgroup ? null : d.markgroup;
      return drawDocTeeth();
    }
    if (d.clearmark) {
      const t = S.d.teeth;
      await api(`/doctor/patients/${t.patientId}/teeth`, {
        method: 'POST', body: JSON.stringify({ tooth: t.tooth, category: d.clearmark }),
      });
      t.marks = t.marks.filter((m) => !(m.tooth === t.tooth && m.category === d.clearmark));
      t.history = [{ code: null, tooth: t.tooth, notedOn: localDate(),
        cabinet: S.d.me?.cabinet ?? '' }, ...t.history];
      return drawDocTeeth();
    }
    if (d.toothitem !== undefined) {
      readPlanForm();
      const idx = Number(d.toothitem);
      const item = S.d.tplan.items[idx];
      return go(toothPick, {
        // В плане у каждой позиции своя цена, поэтому и зуб один: две пломбы
        // это две строки плана, а не одна с двумя номерами.
        title: 'Какой зуб', sub: item.service, value: item.tooth ? [item.tooth] : [],
        onPick: (teeth) => { S.d.tplan.items[idx].tooth = teeth[0] ?? ''; back(); },
      });
    }
    if (d.vsvc) {
      const svc = (S.d.visit?.services ?? []).find((x) => x.id === d.vsvc);
      return go(toothPick, {
        title: 'Какие зубы', sub: svc?.name ?? '', value: svc?.teeth ?? [], many: true,
        onPick: async (teeth) => {
          await api(`/doctor/visit-services/${d.vsvc}/teeth`,
            { method: 'PUT', body: JSON.stringify({ teeth }) });
          S.stack.pop();
          return docVisit(S.d.visitId);
        },
      });
    }
    if (d.visit) return go(docVisit, d.visit);
    // Свободное окно в ленте дня — это приглашение занять его, а не просто
    // подпись: врач тапает по нему и сразу попадает в «Занять время».
    if (d.free) {
      // Время берётся в часовом поясе кабинета, а не браузера: иначе окно
      // подставится со сдвигом у любого, кто не в Ташкенте.
      const from = hhmm(d.free);
      await go(docBlock);
      S.d.block.from = from;
      S.d.block.to = toHHMM(Math.min(toMin(from) + 60, 23 * 60 + 45));
      return S.d.redraw();
    }
    if (d.material) return go(docMaterial, d.material);
    if (d.batch) return go(docBatch, d.batch);
    if (d.tc) return go(docTechcardEdit, d.tc);
    if (d.svc) return go(patSlots, S.d.info.services.find((s) => s.id === d.svc));
    if (d.date) { S.d.pickedDate = d.date; return S.d.redraw(); }
    if (d.time) return go(patConfirm, d.time);
    if (d.unit) { S.d.form.unitId = d.unit; return S.d.redraw(); }
    if (d.tpl) {
      S.d.reg.template = d.tpl;
      // Выбор справочника заодно отмечает свою специализацию: врач, взявший
      // ортопедический справочник, ортопедом и является. Снять отметку он
      // может сам — снимать за него нельзя, у кабинета их несколько.
      const sp = (S.d.reg.templates ?? []).find((t) => t.code === d.tpl)?.specialty;
      if (sp) S.d.reg.specialties.add(sp);
      return S.d.redraw();
    }
    if (d.spec) {
      // Список, а не переключатель: врач редко делает что-то одно. Последнюю
      // отметку снять нельзя — карточка без специализации не отвечает на
      // первый вопрос пациента.
      const set = S.d.reg?.specialties ?? S.d.listing?.specSet;
      if (!set) return;
      if (set.has(d.spec)) {
        if (set.size === 1) return toast('Хотя бы одну оставьте', true);
        set.delete(d.spec);
      } else set.add(d.spec);
      return S.d.redraw();
    }
    if (d.plan) { S.d.plan = d.plan; return S.d.redraw(); }
    if (d.wsvc) { S.d.walkin.serviceId = S.d.walkin.serviceId === d.wsvc ? null : d.wsvc; return S.d.redraw(); }
    if (d.reason) { document.getElementById('xreason').value = d.reason; return; }

    if (d.pick) {
      const m = S.d.stock.materials.find((x) => x.id === d.pick);
      const unit = (S.d.tc.units ?? []).find((u) => u.name_ru === m.unit);
      S.d.tc.lines.push({
        materialId: m.id, analogGroupId: null, title: m.nameRu, normQty: 1,
        unitId: unit?.id ?? S.d.tc.lines[0]?.unitId, unitRu: m.unit,
        divisible: m.divisible, scalesWithQuantity: true, price: m.referencePrice,
      });
      return back();
    }

    if (d.service) {
      const svc = S.d.services.find((s) => s.id === d.service);
      // Услуга уже в приёме — значит врач не добавляет вторую такую же, а
      // уточняет зубы у той. Начало приёма подставляет услугу из записи БЕЗ
      // зуба, и нажатие на неё в прайсе раньше давало «пломба» и «пломба ×2»
      // двумя строками — то, чего никто не просил.
      const already = (S.d.visit?.services ?? []).find((x) => x.name === svc.name_ru);
      if (already && ['tooth', 'canal', 'surface'].includes(svc.unit_of_norm)) {
        return go(toothPick, {
          title: 'Какие зубы', sub: svc.name_ru, many: svc.unit_of_norm === 'tooth',
          value: already.teeth ?? [],
          onPick: async (teeth) => {
            await api(`/doctor/visit-services/${already.id}/teeth`,
              { method: 'PUT', body: JSON.stringify({ teeth }) });
            S.stack.pop();
            return docVisit(S.d.visitId);
          },
        });
      }
      if (svc.unit_of_norm === 'session' || svc.unit_of_norm === 'jaw') {
        await api(`/doctor/visits/${S.d.visitId}/services`, {
          method: 'POST', body: JSON.stringify({ serviceId: svc.id, quantity: 1 }),
        });
        return docVisit(S.d.visitId);
      }
      // Услуга «за зуб» идёт сразу на карту: количество тут и есть число
      // отмеченных зубов, и спрашивать его отдельным экраном — значит
      // спросить одно и то же дважды.
      if (svc.unit_of_norm === 'tooth') {
        S.d.picked = svc;
        return go(toothPick, {
          title: 'Какие зубы', sub: svc.name_ru, many: true,
          onPick: (teeth) => addVisitService(svc, teeth.length, teeth),
        });
      }
      return go(docQuantity, svc);
    }
    if (d.q) { S.d.quantity = Math.max(1, S.d.quantity + (d.q === '+' ? 1 : -1)); return S.d.redraw(); }
    // Отмена одним касанием — потерянный приём от случайного тапа.
    // Пациент подтверждает на отдельном экране, где видит, что именно отменяет.
    if (d.cancel) return go(patCancel, d.cancel);
    if (d.resched) return go(patReschedule, d.resched);
    if (d.rtime) return go(patReschedConfirm, d.rtime);
    if (d.tourgo) return tourGo(d.tourgo);
    if (d.city !== undefined) {
      // Город — это фильтр того же экрана, а не шаг вглубь. Но и запись в
      // стеке должна знать новый фильтр: иначе «назад» и перерисовка вернут
      // человека к прежнему городу, которого он уже не выбирал.
      const q = S.d.find?.query ?? '';
      const top = S.stack[S.stack.length - 1];
      if (top?.[0] === needLink) S.stack[S.stack.length - 1] = [needLink, [d.city, q]];
      return needLink(d.city, q);
    }
    if (d.pickCab) {
      await api('/me/choose', { method: 'POST', body: JSON.stringify({ tenantId: d.pickCab }) });
      // Кабинет выбран — личность изменилась целиком, перечитываем себя.
      S.d.me = await api('/me');
      dropCache();
      S.stack = []; S.tab = 0;
      setTabs('patient');
      return go(TABS[0].fn);
    }
    if (d.tplan) return go(docPlan, d.tplan);
    if (d.mplan) return go(patPlan, d.mplan);
    if (d.psvc) {
      const svc = S.d.tplan.services.find((x) => x.id === d.psvc);
      // Новая позиция попадает в последний этап: врач набирает план по
      // порядку, и «в конец» — то, чего он ждёт. Перекинуть можно стрелками.
      const last = S.d.tplan.items.reduce((m, i) => Math.max(m, i.stage), 1);
      S.d.tplan.items.push({
        serviceId: svc.id, service: svc.name_ru, unit: svc.unit_of_norm,
        tooth: '', quantity: 1, price: Number(svc.price), stage: last, status: 'planned',
        costBase: svc.costBase, costPerUnit: svc.costPerUnit,
      });
      return back();
    }
    if (d.tq) {
      readPlanForm();
      const [i, sign] = d.tq.split(':');
      const item = S.d.tplan.items[Number(i)];
      item.quantity = Math.max(1, item.quantity + (sign === '+' ? 1 : -1));
      return drawPlanEdit();
    }
    if (d.tstage) {
      readPlanForm();
      const [i, sign] = d.tstage.split(':');
      const item = S.d.tplan.items[Number(i)];
      item.stage = Math.max(1, item.stage + (sign === '+' ? 1 : -1));
      return drawPlanEdit();
    }
    if (d.trm) { readPlanForm(); S.d.tplan.items.splice(Number(d.trm), 1); return drawPlanEdit(); }
    if (d.pmethod) { S.d.payMethod = d.pmethod; return docPayment(S.d.patient.id); }

    // Расписание: набранное в полях втягивается ДО любой правки состояния,
    // иначе перерисовка возвращает старое время и правка теряется молча.
    if (d.wd !== undefined) {
      syncSchedule();
      const wd = Number(d.wd);
      S.d.hours = S.d.hours.some((h) => h.weekday === wd)
        ? S.d.hours.filter((h) => h.weekday !== wd)
        : [...S.d.hours, { weekday: wd, startsAt: '09:00', endsAt: '18:00' }];
      return S.d.redraw();
    }
    if (d.add !== undefined) {
      syncSchedule();
      const wd = Number(d.add);
      const list = S.d.hours.filter((h) => h.weekday === wd)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      // Перерыв — это деление рабочего куска надвое, а не новый интервал
      // в хвост дня: приписанное после 18:00 давало 18:00–18:00, которое
      // сервер справедливо отвергал как «конец раньше начала».
      const longest = list.reduce((best, h) =>
        (toMin(h.endsAt) - toMin(h.startsAt)) > (toMin(best.endsAt) - toMin(best.startsAt)) ? h : best, list[0]);
      if (!longest || toMin(longest.endsAt) - toMin(longest.startsAt) < 150) {
        return toast('Интервал слишком короткий, чтобы делить его перерывом', true);
      }
      const mid = Math.round((toMin(longest.startsAt) + toMin(longest.endsAt)) / 2 / 60) * 60;
      const tail = longest.endsAt;
      longest.endsAt = toHHMM(mid - 30);
      S.d.hours.push({ weekday: wd, startsAt: toHHMM(mid + 30), endsAt: tail });
      return S.d.redraw();
    }
    if (d.rm !== undefined) {
      syncSchedule();
      const [wd, i] = d.rm.split(':').map(Number);
      // Индекс приходит из отрисованного списка, а он отсортирован:
      // без такой же сортировки удалялся бы другой интервал.
      const target = S.d.hours.filter((h) => h.weekday === wd)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[i];
      S.d.hours = S.d.hours.filter((h) => h !== target);
      return S.d.redraw();
    }
    if (d.rmov) { await api(`/doctor/schedule/override/${d.rmov}`, { method: 'DELETE' }); return docSchedule(); }
    if (d.rmline !== undefined) { S.d.tc.lines.splice(Number(d.rmline), 1); return S.d.redraw(); }

    switch (d.act) {
      case 'margin': return go(docMargin);
      case 'techcards': return go(docTechcards);
      case 'schedule': return go(docSchedule);
      case 'stock': return goTab(TABS.findIndex((t) => t.k === 'stock'));
      case 'myappts': return goTab(TABS.findIndex((t) => t.k === 'my'));
      case 'tobook': return goTab(TABS.findIndex((t) => t.k === 'book'));
      case 'keepappt': return back();
      case 'sharephone': {
        keepTyped();
        const was = el.textContent;
        el.disabled = true;
        el.textContent = 'Ждём номер из Telegram…';
        const r = await askContact();
        if (r === 'отказ') {
          // Отказ — это ответ, а не поломка: возвращаем кнопку на место, а не
          // оставляем человека перед вечным «ждём».
          el.disabled = false; el.textContent = was;
          return toast('Без номера записаться нельзя: врачу нужно, куда звонить', true);
        }
        if (r === 'нельзя') {
          tg?.openTelegramLink?.(`https://t.me/${S.d.me?.bot ?? 'stomiko_bot'}?start=phone`);
        }
        if (await awaitPhone()) return d.at ? patConfirm(d.at) : refresh();
        el.disabled = false; el.textContent = was;
        return toast('Номер пока не пришёл. Попробуйте ещё раз', true);
      }
      case 'myplace': {
        keepTyped();
        const was = el.textContent;
        el.disabled = true;
        el.textContent = 'Определяем…';
        const point = await askLocation();
        if (typeof point === 'string') {
          // Отказ и «клиент не умеет» объясняются на самом экране, каждый
          // по-своему: одно чинится настройками, другое не чинится вовсе.
          S.d.geo = point;
          el.disabled = false; el.textContent = was;
          return refresh();
        }
        S.d.geo = null;
        // Набранное имя уезжает вместе с местом: что уже написано, то
        // сохранено, даже если человек закроет приложение на этом шаге.
        const draft = (S.d.draftName ?? '').length >= 2 ? { fullName: S.d.draftName } : {};
        S.d.me = { ...S.d.me, ...await api('/me/profile',
          { method: 'PUT', body: JSON.stringify({ ...point, ...draft }) }) };
        toast('Место сохранено');
        // На шаге знакомства место — последний вопрос: отправил и попал в
        // приложение. Лишнее «Готово» после уже нажатой кнопки — лишний шаг.
        if (S.stack[S.stack.length - 1]?.[0] === placeScreen) {
          setTabs(S.d.me.mode);
          S.stack = [];
          return go(TABS[0].fn);
        }
        return refresh();
      }
      case 'geosettings': {
        keepTyped();
        // Кнопка ведёт в настройки Telegram, а не чинит доступ сама. Значит,
        // вернувшись, человек должен увидеть обычное «отправить место», а не
        // застрявшую жалобу.
        tg?.LocationManager?.openSettings?.();
        S.d.geo = null;
        return refresh();
      }
      case 'profile': return go(profileScreen, false);
      case 'saveprofile': {
        const name = val('myname');
        if (name.length < 2) return toast('Как вас записывать в карту?', true);
        if (d.first === '1' && !S.d.me?.phone) {
          // Кнопку с условием в подписи никто не читает — нажимают, и всё.
          // Поэтому условие объясняется после нажатия и там, где его
          // выполняют: карточка номера подъезжает под палец и мигает.
          keepTyped();
          const card = document.getElementById('phonecard');
          card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          card?.classList.remove('attn'); void card?.offsetWidth; card?.classList.add('attn');
          return toast('Сначала поделитесь номером — без него в системе не зарегистрироваться', true);
        }
        el.disabled = true;
        S.d.me = { ...S.d.me, ...await api('/me/profile',
          { method: 'PUT', body: JSON.stringify({ fullName: name }) }) };
        S.d.draftName = null;
        if (d.first !== '1') { toast('Сохранено'); return back(); }
        return go(roleScreen);
      }
      case 'aspatient': return go(placeScreen);
      case 'skipplace': {
        // Знакомство кончается пациентом — даже у того, у кого есть кабинет.
        // Спрашивали про ЧЕЛОВЕКА, и высадить его сразу в кресло врача
        // значит ответить не на тот вопрос. Кабинет никуда не делся: он в
        // «Ещё» → «Вернуться в кабинет».
        if (S.d.me.mode !== 'patient') {
          await api('/me/mode', { method: 'POST', body: JSON.stringify({ mode: 'patient' }) });
          S.d.me = await api('/me');
          dropCache();
        }
        setTabs(S.d.me.mode);
        S.stack = [];
        return go(TABS[0].fn);
      }
      case 'asdoctor': return go(doctorEntry);
      case 'dangerzone': {
        const scale = await api('/doctor/cabinet/scale');
        const owner = scale.role === 'owner';
        const rows = owner ? [
          [`${plural(scale.patients, 'карточка пациента', 'карточки пациентов', 'карточек пациентов')} в кабинете`, scale.patients],
          [plural(scale.visits, 'закрытый приём', 'закрытых приёма', 'закрытых приёмов'), scale.visits],
          [plural(scale.appointments, 'предстоящая запись', 'предстоящие записи', 'предстоящих записей'), scale.appointments],
          [plural(scale.plans, 'план лечения', 'плана лечения', 'планов лечения'), scale.plans],
          [plural(scale.payments, 'запись об оплате', 'записи об оплатах', 'записей об оплатах'), scale.payments],
          [plural(scale.materials, 'позиция на складе', 'позиции на складе', 'позиций на складе'), scale.materials],
        ].filter(([, n]) => Number(n) > 0) : [];
        const ok = await ask({
          title: owner ? 'Удалить кабинет?' : 'Выйти из кабинета?',
          body: owner
            // Вопрос без цифр — вопрос ни о чём: человек не помнит, сколько
            // у него пациентов. Со счётом это уже решение.
            ? `<b>${esc(scale.name ?? '')}</b> и всё, что в нём:<br>${
                rows.length ? rows.map(([l, n]) => `${n} ${l}`).join('<br>') : 'кабинет пока пуст'}
               <br><br>Отменить это будет нечем.${Number(scale.records) > 0
                 ? ` Лечение, которое вы уже провели — ${scale.records} ${
                     plural(scale.records, 'запись', 'записи', 'записей')
                   }, — останется в картах самих пациентов: карты принадлежат им, а не кабинету.`
                 : ''}`
            : `Вы перестанете видеть <b>${esc(scale.name ?? '')}</b>. Данные останутся у владельца.`,
          confirm: owner ? 'Да, удалить' : 'Выйти',
          // Необратимое не должно быть самой заметной кнопкой в окне: главной
          // остаётся «Отмена», а удаление — подписью рядом. Кабинет со всей
          // историей однажды уже ушёл под палец, целившийся в другое.
          danger: owner,
        });
        if (!ok) return;
        await api(owner ? '/doctor/cabinet' : '/doctor/cabinet/leave',
          { method: owner ? 'DELETE' : 'POST' });
        toast(owner ? 'Кабинет удалён' : 'Вы вышли из кабинета');
        dropCache(); S.d.cal = null; S.stack = []; S.tab = 0;
        S.d.me = await api('/me');
        setTabs(S.d.me.mode);
        return go(TABS[0].fn);
      }
      case 'listing': return go(docListing);
      case 'adminlic': return go(adminLicenses);
      case 'sendlicense': {
        readListingForm();
        const num = val('licnum');
        if (num.length < 4) return toast('Номер слишком короткий — его не найти в реестре', true);
        el.disabled = true;
        const r = await api('/doctor/license', { method: 'PUT', body: JSON.stringify({
          number: num, tin: val('lictin') }) });
        // Подача снимает кабинет с поиска: отметка «проверено» не должна
        // пережить документ, к которому она относилась.
        S.d.listing = { ...S.d.listing, ...r, listed: false };
        toast('Отправлено на проверку — ответ придёт в чат');
        return docListing();
      }
      case 'cabplace': {
        el.disabled = true;
        el.textContent = 'Определяем…';
        const point = await askLocation();
        if (!point) { el.disabled = false; return toast('Место не получено. Разрешите доступ в настройках Telegram', true); }
        // Точка сохраняется вместе с остальной карточкой: врач мог не дописать
        // адрес, и отправлять её отдельно — значит публиковать полкарточки.
        readListingForm();
        S.d.listing = { ...S.d.listing, ...point };
        toast('Отмечено');
        return S.d.redraw();
      }
      case 'savelisting': {
        readListingForm();
        const l = S.d.listing;
        el.disabled = true;
        // Специализации и имя врача — часть той же карточки, что и адрес:
        // сохраняются одним нажатием, а не отдельной кнопкой на каждое поле.
        await api('/doctor/profile', { method: 'PUT', body: JSON.stringify({
          specialties: [...l.specSet], doctor: l.doctor }) }).catch(() => {});
        const r = await api('/doctor/listing', { method: 'PUT', body: JSON.stringify({
          city: l.city, address: l.address, landmark: l.landmark, phone: l.phone,
          listed: d.listed === '1', lat: l.lat, lon: l.lon }) });
        // Ответ несёт состояние лицензии: если врач подал новый номер из
        // другого окна, кнопка тут же станет «нужна проверенная лицензия».
        S.d.listing = { ...l, ...r, listed: Boolean(r.listed) };
        toast(r.listed ? 'Кабинет показывается в поиске' : 'Кабинет убран из поиска');
        return docListing();
      }
      case 'record': S.d.recTooth = null; return go(docRecord, S.d.patient.id);
      case 'teeth': S.d.teeth = null; return go(docTeeth, S.d.patient.id);
      case 'unfocus': S.d.teeth.tooth = null; return drawDocTeeth();
      case 'dropmark': S.d.teeth.pick = null; return drawDocTeeth();
      case 'alltooth': {
        S.d.recTooth = null;
        return S.stack[S.stack.length - 1]?.[0] === docRecord ? drawDocRecord() : drawPatRecord();
      }
      case 'milk': {
        // Переключатель молочных живёт на двух экранах сразу: на выборе он
        // меняет чем выбирать, на карте — что показывать.
        const top = S.stack[S.stack.length - 1]?.[0];
        if (top === toothPick) { S.d.pick.milk = !!d.on; return drawToothPick(); }
        if (top === docTeeth) { S.d.teeth.milk = !!d.on; return drawDocTeeth(); }
        S.d.recMilk = !!d.on;
        return top === docRecord ? drawDocRecord() : drawPatRecord();
      }
      case 'notooth': S.d.pick.value = []; return drawToothPick();
      case 'picktooth': {
        const { value, onPick } = S.d.pick;
        if (!value.length) return toast('Выберите зуб на карте', true);
        return onPick(value);
      }
      case 'saveamend': {
        const note = document.getElementById('amendnote')?.value.trim() ?? '';
        if (!note) return toast('Дополнение без текста ничего не уточняет', true);
        el.disabled = true; el.textContent = 'Добавляем…';
        await api(`/doctor/record/${d.id}/amend`, {
          method: 'POST', body: JSON.stringify({ note }),
        });
        toast('Уточнение добавлено');
        // Возврат на карту, а не назад: уточнение имеет смысл только рядом
        // с записью, к которой относится, — его и надо увидеть.
        S.stack.pop();
        return go(docRecord, S.d.record.patientId);
      }
      case 'newplan': S.d.tplan = null; return go(docPlanEdit, null);
      case 'editplan': S.d.tplan = null; return go(docPlanEdit, S.d.tplanView.id);
      case 'addplanitem': { readPlanForm(); return go(docPlanPicker); }
      case 'saveplan': {
        readPlanForm();
        const t = S.d.tplan;
        const planned = t.items.filter((i) => i.status !== 'done');
        if (!planned.length) return toast('Добавьте хотя бы одну услугу', true);
        const badTooth = planned.find((i) => i.tooth && !/^[1-8][1-8]$/.test(i.tooth));
        if (badTooth) return toast(`Зуб «${badTooth.tooth}» — не номер по FDI. Например 26.`, true);
        el.disabled = true; el.textContent = 'Сохраняем…';
        const r = await api('/doctor/plans', { method: 'POST', body: JSON.stringify({
          planId: t.planId, patientId: t.patientId, title: t.title, status: t.status,
          items: planned.map((i) => ({
            serviceId: i.serviceId, tooth: i.tooth || null,
            quantity: i.quantity, price: i.price, stage: i.stage })),
        }) });
        dropCache('patients');
        S.d.tplan = null;
        // Возврат на сам план, а не назад: врач сохранил, чтобы посмотреть
        // итог, — и итог должен открыться сразу.
        S.stack.pop();
        return go(docPlan, r.planId);
      }
      case 'activateplan': {
        const p = S.d.tplanView;
        el.disabled = true;
        const r = await api('/doctor/plans', { method: 'POST', body: JSON.stringify({
          planId: p.id, title: p.title, status: 'active',
          items: p.items.filter((i) => i.status !== 'done').map((i) => ({
            serviceId: i.serviceId, tooth: i.tooth, quantity: i.quantity,
            price: Number(i.price), stage: i.stage })),
        }) });
        dropCache('patients');
        toast(r.activated ? 'План отправлен пациенту' : 'План открыт пациенту');
        return docPlan(p.id);
      }
      case 'closeplan': {
        const p = S.d.tplanView;
        el.disabled = true;
        await api('/doctor/plans', { method: 'POST', body: JSON.stringify({
          planId: p.id, title: p.title, status: 'done',
          items: p.items.filter((i) => i.status !== 'done').map((i) => ({
            serviceId: i.serviceId, tooth: i.tooth, quantity: i.quantity,
            price: Number(i.price), stage: i.stage })),
        }) });
        dropCache('patients');
        toast('План закрыт');
        return docPlan(p.id);
      }
      case 'delplan': {
        el.disabled = true;
        await api(`/doctor/plans/${S.d.tplanView.id}`, { method: 'DELETE' });
        dropCache('patients');
        toast('План удалён');
        return back();
      }
      case 'pay': return go(docPayment, S.d.patient.id);
      case 'dopay': {
        const amount = Number(val('payamount').replace(/\s/g, ''));
        if (!(amount > 0)) return toast('Укажите сумму', true);
        el.disabled = true; el.textContent = 'Проводим…';
        const r = await api(`/doctor/patients/${d.id}/payments`, { method: 'POST',
          body: JSON.stringify({ amount, method: S.d.payMethod ?? 'cash', note: val('paynote') || null }) });
        tg?.HapticFeedback?.notificationOccurred?.('success');
        toast(`Принято. Долг: ${money(r.balance.debt)} сум`);
        dropCache('patients');
        S.stack.pop();
        return docPatient(d.id);
      }
      case 'doresched': {
        el.disabled = true;
        el.textContent = 'Переносим…';
        await api(`/me/appointments/${d.id}/reschedule`, {
          method: 'POST', body: JSON.stringify({ startsAt: d.at }),
        });
        tg?.HapticFeedback?.notificationOccurred?.('success');
        toast('Запись перенесена. Врач уведомлён.');
        dropMine();
        // Возврат к списку записей, а не на шаг назад: позади остались сетка
        // времени и подтверждение, и оба уже неактуальны.
        S.stack = [];
        const my = TABS.findIndex((t) => t.k === 'my');
        if (my >= 0) S.tab = my;
        return go(TABS[my >= 0 ? my : 0].fn);
      }
      case 'docancelmy': {
        el.disabled = true;
        await api(`/me/appointments/${d.id}/cancel`, { method: 'POST' });
        toast('Запись отменена. Врач уведомлён.');
        dropMine();
        S.stack.pop();
        return patMy();
      }
      case 'enablenotif':
        tg?.openTelegramLink?.(`https://t.me/${S.d.me?.bot ?? 'stomiko_bot'}?start=notify`);
        return;
      case 'block': return go(docBlock);
      case 'walkin': return go(docWalkIn);
      case 'tocancel': return go(docCancel);
      case 'remind': {
        const r = await api(`/doctor/appointments/${S.d.appt.id}/remind`, { method: 'POST' });
        return toast(r.notified ? 'Напоминание отправлено'
          : r.phone ? `Пациент не в Telegram — позвоните: ${r.phone}` : 'Пациенту нельзя написать', !r.notified);
      }
      case 'newmaterial': return go(docMaterialForm, null);
      case 'editmaterial': return go(docMaterialForm, S.d.material.material);
      case 'receive': return go(docReceive);
      case 'pickmaterial': return go(docMaterialPicker);

      case 'checkblock': {
        const b = readBlockForm();
        if (b.to <= b.from) return toast('Конец должен быть позже начала', true);
        const { conflicts } = await api(
          `/doctor/conflicts?startsAt=${encodeURIComponent(`${b.date}T${b.from}:00+05:00`)}&endsAt=${encodeURIComponent(`${b.date}T${b.to}:00+05:00`)}`);
        b.conflicts = conflicts;
        return S.d.redraw();
      }
      case 'doblock': {
        const b = readBlockForm();
        if (b.conflicts.length && !b.reason) return toast('Укажите причину отмены', true);
        el.disabled = true;
        const r = await api('/doctor/block', {
          method: 'POST',
          body: JSON.stringify({
            startsAt: `${b.date}T${b.from}:00+05:00`,
            endsAt: `${b.date}T${b.to}:00+05:00`,
            reason: b.note || 'Занято',
            cancelReason: b.reason,
          }),
        });
        const noReach = (r.cancelled ?? []).filter((x) => !x.ok);
        dropCalendar();
        toast(noReach.length
          ? `Время занято. Не дошло до ${noReach.length}: ${noReach.map((x) => x.phone ?? x.patient).join(', ')} — позвоните`
          : (r.cancelled ?? []).length ? `Время занято, ${r.cancelled.length} пациентов уведомлены` : 'Время занято');
        S.d.selectedDay = b.date;
        return back();
      }
      case 'dowalkin': {
        const name = val('wname');
        if (!name) return toast('Укажите имя пациента', true);
        el.disabled = true;
        const { visitId } = await api('/doctor/walk-in', {
          method: 'POST',
          body: JSON.stringify({ name, phone: val('wphone'), serviceId: S.d.walkin.serviceId }),
        });
        dropCalendar();
        S.stack.pop();
        return go(docVisit, visitId);
      }
      case 'docancel': {
        const reason = val('xreason');
        if (!reason) return toast('Укажите причину', true);
        el.disabled = true;
        const r = await api(`/doctor/appointments/${S.d.appt.id}/cancel`, {
          method: 'POST', body: JSON.stringify({ reason }),
        });
        dropCalendar();
        toast(r.notified ? 'Отменено, пациент уведомлён'
          : r.phone ? `Отменено. Пациент не в Telegram — позвоните: ${r.phone}` : 'Отменено');
        return back(2);
      }
      case 'creatematerial': {
        const nameRu = val('mname');
        if (!nameRu) return toast('Укажите название', true);
        el.disabled = true;
        const { materialId } = await api('/doctor/stock', {
          method: 'POST',
          body: JSON.stringify({
            nameRu, category: val('mcat'), unitId: S.d.form.unitId,
            referencePrice: Number(val('mprice')) || null,
          }),
        });
        toast('Материал добавлен. Теперь оприходуйте закупку.');
        S.stack.pop();
        return go(docMaterial, materialId);
      }
      case 'updatematerial': {
        el.disabled = true;
        await api(`/doctor/stock/${S.d.form.editing}`, {
          method: 'PUT',
          body: JSON.stringify({
            nameRu: val('mname'), category: val('mcat'),
            referencePrice: Number(val('mprice')) || null,
          }),
        });
        toast('Сохранено');
        return back();
      }
      case 'doadjust': {
        const newQty = Number(val('aqty'));
        const reason = val('areason');
        if (!reason) return toast('Укажите причину расхождения', true);
        if (!(newQty >= 0)) return toast('Остаток не может быть отрицательным', true);
        el.disabled = true;
        await api(`/doctor/stock/batches/${S.d.batch.batch_id}/adjust`, {
          method: 'POST', body: JSON.stringify({ newQty, reason }),
        });
        toast('Остаток скорректирован');
        S.stack.pop();
        return docMaterial(S.d.material.material.id);
      }
      case 'dowriteoff': {
        const reason = val('areason') || (S.d.batch.expired ? 'истёк срок годности' : 'утилизация');
        el.disabled = true;
        await api(`/doctor/stock/batches/${S.d.batch.batch_id}/write-off`, {
          method: 'POST', body: JSON.stringify({ reason }),
        });
        toast('Партия списана');
        S.stack.pop();
        return docMaterial(S.d.material.material.id);
      }
      case 'doreceive': {
        const qty = Number(val('rqty'));
        if (!(qty > 0)) return toast('Укажите количество', true);
        el.disabled = true;
        await api(`/doctor/stock/${S.d.material.material.id}/receive`, {
          method: 'POST',
          body: JSON.stringify({
            qty, totalPrice: Number(val('rprice')) || null,
            expiresAt: val('rexp') || null, supplier: val('rsup') || undefined,
          }),
        });
        toast('Партия оприходована');
        return back();
      }
      case 'addservice': {
        // Каналы и поверхности считаются В ПРЕДЕЛАХ одного зуба: три канала —
        // это один зуб, а не три. Поэтому здесь выбор одиночный, а
        // множественный — только у услуг «за зуб».
        const svc = S.d.picked;
        if (!['canal', 'surface'].includes(svc.unit_of_norm)) {
          return addVisitService(svc, S.d.quantity, []);
        }
        return go(toothPick, {
          title: 'Какой зуб', sub: svc.name_ru,
          onPick: (teeth) => addVisitService(svc, S.d.quantity, teeth),
        });
      }
      case 'startvisit': {
        const { visitId } = await api(`/doctor/appointments/${S.d.appt.id}/start`, { method: 'POST' });
        dropCalendar();
        return go(docVisit, visitId);
      }
      case 'close': {
        // Услуга «за зуб» без зуба уходит в карту пациента строкой «пломба —
        // неизвестно где». Исправить её потом нельзя: запись запечатывается
        // этим самым закрытием. Поэтому спрашиваем ДО, а не сожалеем после.
        const noTeeth = (S.d.visit?.services ?? []).filter((x) => {
          const svc = (S.d.services ?? []).find((y) => y.name_ru === x.name);
          return svc && ['tooth', 'canal', 'surface'].includes(svc.unit_of_norm)
            && !(x.teeth ?? []).length;
        });
        if (noTeeth.length) {
          const go_ = await ask({
            title: 'Закрыть без зуба?',
            body: `${noTeeth.map((x) => `<b>${esc(x.name)}</b>`).join('<br>')}
              <br><br>У ${noTeeth.length === 1 ? 'этой услуги' : 'этих услуг'} не указан зуб.
              В карте пациента останется запись без номера, и дописать его будет
              нельзя — приём запечатывается закрытием.`,
            confirm: 'Всё равно закрыть', cancel: 'Указать зуб',
          });
          if (!go_) return;
        }
        el.disabled = true; el.textContent = 'Закрываем…';
        const r = await api(`/doctor/visits/${S.d.visitId}/close`, { method: 'POST' });
        tg?.HapticFeedback?.notificationOccurred?.('success');
        if (r.shortfalls > 0) toast(`Закрыт. ${r.shortfalls} позиций списано без остатка — пополните склад`);
        return docBreakdown(S.d.visitId);
      }
      case 'savesched': {
        syncSchedule();
        const bad = S.d.hours.find((h) => toMin(h.endsAt) <= toMin(h.startsAt));
        if (bad) return toast(`${WEEKDAYS[bad.weekday]}: ${bad.startsAt}–${bad.endsAt} — конец раньше начала`, true);
        el.disabled = true;
        dropCalendar();
        await api('/doctor/schedule', {
          method: 'PUT',
          body: JSON.stringify({
            hours: S.d.hours,
            settings: {
              minNoticeMinutes: S.d.settings?.min_notice_minutes,
              bufferMinutes: S.d.settings?.buffer_minutes,
              maxDaysAhead: S.d.settings?.max_days_ahead,
            },
          }),
        });
        toast(S.d.hours.length ? 'Расписание сохранено' : 'Сохранено. Рабочих дней нет — записаться нельзя');
        return back();
      }
      case 'dayoff': {
        syncSchedule();
        const { date, reason } = S.d.newOverride;
        if (!date) return toast('Выберите дату', true);
        await api('/doctor/schedule/override', {
          method: 'POST',
          body: JSON.stringify({ date, isClosed: true, reason: reason || 'выходной' }),
        });
        toast(`${dateLabel(date)} — выходной`);
        return docSchedule();
      }
      case 'patients': return goTab(TABS.findIndex((t) => t.k === 'patients'));
      case 'myrecord': return go(patRecord);
      // Оба экрана — вход вглубь из «Ещё», а не перерисовка текущего.
      // Без go() они вставали поверх раздела, не попадая в стек, и кнопка
      // «назад» на них не появлялась вовсе: выйти можно было только закрыв
      // приложение.
      case 'findcab': return go(needLink);
      case 'iamdoctor': return go(doctorEntry);
      case 'newcabinet': return go(newCabinet);
      case 'tour': return go(tourScreen);
      case 'billing': return go(docBilling);
      case 'payplan': {
        el.disabled = true;
        const was = el.textContent;
        el.textContent = 'Выставляем…';
        try {
          const r = await api('/billing/invoice', { method: 'POST', body: JSON.stringify({ plan: S.d.plan }) });
          toast('Счёт отправлен в чат с ботом');
          tg?.openTelegramLink?.(`https://t.me/${r.bot ?? 'stomiko_bot'}`);
        } finally {
          // Кнопку возвращаем в строй. Она оставалась серой навсегда: счёт
          // мог не дойти, врач мог передумать и выбрать другой срок — а
          // единственный способ починить экран был перезапуск приложения.
          el.disabled = false;
          el.textContent = was;
        }
        return;
      }
      case 'reviewhint': return go(afterTour, { visits: 0, appointments: 0, patients: 0, batches: 0 });
      case 'docreate': {
        const name = val('cabname');
        if (name.length < 2) return toast('Укажите название кабинета', true);
        el.disabled = true;
        el.textContent = 'Готовим кабинет…';
        const r = await api('/onboarding/register', {
          method: 'POST',
          body: JSON.stringify({ name, template: S.d.reg.template,
            specialties: [...S.d.reg.specialties] }),
        });
        if (r.demo === false) toast('Кабинет создан, но демо-приёмы не наполнились', true);
        tg?.HapticFeedback?.notificationOccurred?.('success');
        // Кабинет создан — личность изменилась целиком, перечитываем себя.
        S.d.me = await api('/me');
        S.d.cal = null; dropCache();
        S.stack = []; S.tab = 0;
        setTabs('doctor');
        return go(TABS[0].fn);
      }
      case 'finishtour': {
        el.disabled = true;
        const { wiped } = await api('/onboarding/finish', { method: 'POST' });
        S.d.me = await api('/me');
        S.d.cal = null; dropCache();
        S.stack = [];
        return go(afterTour, wiped);
      }
      case 'reviewed': {
        await api('/onboarding/reviewed', { method: 'POST' });
        S.d.me = await api('/me');
        toast('Отмечено. Можно звать пациентов.');
        S.stack = []; S.tab = 0;
        return go(TABS[0].fn);
      }
      case 'switcher': return go(switcher);
      case 'useinvite': {
        const raw = val('invcode');
        const code = (raw.match(/inv_[A-Za-z0-9_-]+/) ?? [])[0];
        if (!code) return toast('Код должен начинаться с inv_', true);
        // Приглашение гасится при следующем открытии: перезапуск приложения
        // с этим параметром — единственный путь, которым Telegram отдаёт
        // подписанный start_param.
        tg?.openTelegramLink?.(`https://t.me/${S.d.me?.bot ?? 'stomiko_bot'}?startapp=${code}`);
        return toast('Открываем кабинет…');
      }
      case 'savenotes': {
        const phone = val('pphonefix');
        if (phone && phone.replace(/\D/g, '').length < 9) return toast('Телефон неполный', true);
        await api(`/doctor/patients/${S.d.patient.id}`, {
          method: 'PUT', body: JSON.stringify({ notes: val('pnotes'), phone }),
        });
        toast('Сохранено');
        // Форма правки — пройденный шаг: без этого «назад» с карточки
        // возвращал в ту же форму, из которой человек только что вышел.
        S.stack.pop();
        return docPatient(S.d.patient.id);
      }
      case 'noshow': {
        el.disabled = true;
        await api(`/doctor/appointments/${S.d.appt.id}/no-show`, { method: 'POST' });
        dropCalendar();
        toast('Отмечено: не пришёл');
        return back();
      }
      case 'savetc': {
        for (const inp of document.querySelectorAll('[data-norm]')) {
          S.d.tc.lines[Number(inp.dataset.norm)].normQty = Number(inp.value);
        }
        if (!S.d.tc.lines.length) return toast('Техкарта не может быть пустой', true);
        el.disabled = true;
        const r = await api(`/doctor/techcard/${S.d.tc.serviceId}`, {
          method: 'PUT',
          body: JSON.stringify({
            lines: S.d.tc.lines.map((l) => ({
              materialId: l.materialId, analogGroupId: l.analogGroupId,
              normQty: l.normQty, unitId: l.unitId, scalesWithQuantity: l.scalesWithQuantity,
            })),
          }),
        });
        toast(`Версия ${r.version}: ${r.expandedLines} позиций`);
        return back();
      }
      case 'link': return go(docLink);
      case 'invite': return go(docInvite);
      case 'copylink':
        await navigator.clipboard.writeText(S.d.link).catch(() => {});
        return toast('Скопировано');

      case 'dobook': {
        const name = val('pname');
        if (!name) return toast('Укажите имя', true);
        el.disabled = true; el.textContent = 'Записываем…';
        const r = await api('/book', {
          method: 'POST',
          body: JSON.stringify({ serviceId: S.d.service.id, startsAt: d.at, name, note: val('pnote') }),
        });
        // Поправил имя при записи — значит, в профиле оно было неверное.
        // Спрашивать то же самое в третий раз незачем.
        if (name !== S.d.me?.fullName) {
          S.d.me = { ...S.d.me, ...await api('/me/profile',
            { method: 'PUT', body: JSON.stringify({ fullName: name }) }).catch(() => ({})) };
        }
        tg?.HapticFeedback?.notificationOccurred?.('success');
        S.stack = [];
        // Бот не может написать первым тому, кто не начинал с ним чат. Пациент
        // должен узнать это сейчас, а не в день несостоявшегося приёма.
        S.d.noNotifications = r.notificationsEnabled === false;
        // Подсветка вкладки — не украшение: экран «Мои записи» при горящей
        // вкладке «Запись» читается как «я нажал не туда».
        const myTab = TABS.findIndex((t) => t.k === 'my');
        if (myTab >= 0) S.tab = myTab;
        // Первое, что человек видит после записи, — что он записан. Раньше
        // первым было предупреждение про уведомления: он сделал дело, а его
        // встречает укор.
        S.d.justBooked = { at: d.at, service: S.d.service.name };
        dropMine();
        return go(patMy);
      }
      default: return;
    }
  } catch (err) {
    // Заморозка и пауза — не ошибки действия, а состояние кабинета.
    // Показывать их тостом поверх недоступного экрана бессмысленно.
    if (err.body?.frozen) { S.stack = []; return frozenScreen(err.body.paidUntil); }
    if (err.body?.paused) { S.stack = []; return pausedScreen(err.body.phone); }
    toast(err.message, true);
    const btn = root.querySelector('.primary[disabled]');
    if (btn) { btn.disabled = false; btn.textContent = 'Повторить'; }
  }
});

/* ── Старт ────────────────────────────────────────────────────────────── */
(async () => {
  try {
    const me = await api('/me');
    S.d.me = me;
    // Роль больше не спрашивается на входе. Пациентов на порядок больше, чем
    // врачей, и первым экраном им доставался вопрос о том, кто они, — вместо
    // поиска стоматолога, за которым они и пришли. Врач заводит кабинет из
    // раздела «Ещё»: он делает это один раз в жизни, пациент записывается
    // каждый раз.
    const q = new URLSearchParams(location.search);
    // Первый вход: имени у человека ещё нет. Без него его не записать и не
    // позвать в кресло, поэтому спрашиваем сразу — один раз за всё время, а
    // не при каждой записи в каждый кабинет. Кроме случая, когда человек
    // пришёл по ссылке за конкретным делом: знакомиться посреди дела глупо.
    if (!me.fullName && !q.get('appt') && !q.get('resched')) {
      return go(profileScreen, true);
    }
    setTabs(me.mode);
    await go(TABS[0].fn);
    // Пришли по кнопке «Перенести» под напоминанием: человек уже решил, что
    // переносит, и список записей на пути к сетке времени — лишний экран.
    if (q.get('plan') === '1') {
      const my = TABS.findIndex((t) => t.k === 'my');
      if (my >= 0) return goTab(my);
    }
    // Пришли по кнопке «Открыть» под уведомлением о новой записи: врач уже
    // прочитал, кто и когда, — ему нужна сама запись, а не путь к ней.
    const appt = q.get('appt');
    if (/^[0-9a-f-]{36}$/i.test(appt ?? '') && me.mode === 'doctor') {
      go(docAppointment, appt);
      return;
    }
    const resched = q.get('resched');
    if (/^[0-9a-f-]{36}$/i.test(resched ?? '')) {
      // Ошибка здесь не должна уносить всё приложение: запись могли отменить
      // или она уже прошла — тогда человек остаётся на своём разделе.
      go(patReschedule, resched).catch((e) => toast(e.message, true));
      return;
    }
    // Первый экран нарисован — можно тихо прогреть остальные разделы.
    // Запросы в фоне дешевле, чем заставка на каждое первое нажатие.
    //
    // Условие читало `me.role`, которого в ответе нет вовсе — поле называется
    // `mode`. Из-за опечатки прогрев не выполнялся НИ РАЗУ, и каждый первый
    // переход между разделами показывал заставку. Заодно прогреваем разделы
    // пациента: их больше, и ходят по ним чаще.
    if (me.mode === 'doctor') {
      tabData('stock', () => api('/doctor/stock'));
      tabData('patients', () => api('/doctor/patients'));
      tabData('cabinet', () => api('/doctor/reports/margin').catch(() => ({ totals: null })));
    } else {
      tabData('my', () => Promise.all([
        api('/me/appointments'),
        api('/me/plans').then((r) => r.plans).catch(() => []),
      ]));
      tabData('card', () => Promise.all([
        api('/me/record').catch(() => ({ entries: [] })),
        api('/me/teeth').catch(() => ({ marks: [] })),
      ]));
    }
  } catch (err) {
    if (err.body?.frozen) return frozenScreen(err.body.paidUntil);
    if (err.body?.paused) return pausedScreen(err.body.phone);
    render(`<div class="empty">${esc(err.message)}</div>`);
  }
})();

