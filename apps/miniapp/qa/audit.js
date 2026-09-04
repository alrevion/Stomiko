/** Проверка экрана на дефекты, которые видно только на телефоне. */
window.__audit = function (label) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;height:100dvh;width:1px;visibility:hidden';
  document.body.appendChild(probe);
  const dvh = probe.getBoundingClientRect().height; probe.remove();
  // Поправка: в эмуляторе окна 100dvh и innerHeight расходятся, на
  // устройстве совпадают. Без неё проверка находит «недоступные» кнопки,
  // которых на телефоне нет.
  const sheet = parseInt(getComputedStyle(document.documentElement)
    .getPropertyValue('--tg-viewport-stable-height')) || dvh;
  const H = window.innerHeight - (dvh - sheet);
  const out = []; const seen = new Set();
  const add = (t) => { if (!seen.has(t)) { seen.add(t); out.push(t); } };
  const keep = window.scrollY;
  document.querySelectorAll('.primary, .nav').forEach((el) => {
    if (el.hidden) return; const r = el.getBoundingClientRect();
    if (r.height && r.bottom > H + 1)
      add('НЕДОСТУПНО: «' + (el.textContent || el.className).trim().slice(0, 30) + '» на ' + Math.round(r.bottom - H) + 'px за краем');
  });
  if (document.documentElement.scrollWidth > window.innerWidth + 1)
    add('ГОРИЗОНТАЛЬНАЯ ПРОКРУТКА: ' + document.documentElement.scrollWidth + ' при ' + window.innerWidth);
  document.querySelectorAll('#root *').forEach((el) => {
    if (el.children.length) return;
    // Внутри SVG scrollWidth значит другое: обрезает там viewBox, а не бокс
    // элемента. Без этой оговорки зубная карта давала четырнадцать «обрезано»
    // на номерах, которые видно целиком.
    if (el.ownerSVGElement || el.tagName === 'svg') return;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && getComputedStyle(el).overflow === 'visible')
      add('ОБРЕЗАНО: «' + (el.textContent || '').trim().slice(0, 30) + '» шире на ' + (el.scrollWidth - el.clientWidth) + 'px');
  });
  document.querySelectorAll('button, input, select, textarea, a').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.height || r.top > H) return;
    if (r.height < 30 || r.width < 30)
      add('МЕЛКАЯ ЦЕЛЬ: «' + (el.textContent || el.id || el.className).trim().slice(0, 22) + '» ' + Math.round(r.width) + '×' + Math.round(r.height));
  });
  const last = [...document.querySelectorAll('#root main > *')].pop();
  if (last) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const lr = last.getBoundingClientRect();
    const p = document.querySelector('.primary'); const n = document.querySelector('.nav');
    const barTop = Math.min(p ? p.getBoundingClientRect().top : H, (n && !n.hidden) ? n.getBoundingClientRect().top : H);
    if (lr.bottom > barTop + 1) add('ПРЯЧЕТСЯ ЗА ПАНЕЛЬЮ: на ' + Math.round(lr.bottom - barTop) + 'px под ней');
  }
  const p2 = document.querySelector('.primary'), n2 = document.querySelector('.nav');
  if (p2 && n2 && !n2.hidden && p2.getBoundingClientRect().bottom > n2.getBoundingClientRect().top + 1)
    add('НАЛОЖЕНИЕ: кнопка заезжает на панель');
  window.scrollTo(0, keep);
  return { экран: label, находки: out.length ? out : ['чисто'] };
};
