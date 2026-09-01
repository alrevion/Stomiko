import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmedText, notifyPlanReady, notifyReminder } from './notify.js';

/**
 * Клавиатура под напоминанием.
 *
 * Проверяется то, что уходит в Telegram, а не то, что мы намеревались
 * отправить: ошибка в одном имени поля (`callback_data`, `web_app`) даёт
 * сообщение без кнопок, и обнаружилось бы это на живом пациенте.
 */

const SUBJ = 'tg:12345';
const APPT = '11111111-2222-3333-4444-555555555555';
const APP = 'https://app.example';

function capture() {
  const calls: any[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return { json: async () => ({ ok: true }) } as Response;
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('напоминание за сутки', () => {
  it('несёт обе кнопки', async () => {
    const calls = capture();
    await notifyReminder('T', SUBJ, 'Кабинет', 'Пломба', '2026-09-10T05:00:00Z', 'day', APPT, APP);
    const kb = calls[0].body.reply_markup.inline_keyboard[0];
    expect(kb).toHaveLength(2);
    expect(kb[0].callback_data).toBe(`cfm:${APPT}`);
    expect(kb[1].web_app.url).toBe(`${APP}?resched=${APPT}`);
  });

  // 64 байта — предел Telegram на callback_data. UUID с приставкой в него
  // укладывается, но проверить дешевле, чем узнать по молчащей кнопке.
  it('данные кнопки влезают в лимит Telegram', async () => {
    const calls = capture();
    await notifyReminder('T', SUBJ, 'Кабинет', null, '2026-09-10T05:00:00Z', 'day', APPT, APP);
    const data = calls[0].body.reply_markup.inline_keyboard[0][0].callback_data;
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });

  it('без адреса приложения кнопок нет — лучше текст, чем мёртвая кнопка', async () => {
    const calls = capture();
    await notifyReminder('T', SUBJ, 'Кабинет', 'Пломба', '2026-09-10T05:00:00Z', 'day');
    expect(calls[0].body.reply_markup).toBeUndefined();
    expect(calls[0].body.text).toContain('отмените запись');
  });
});

describe('напоминание за два часа', () => {
  // Подтверждать поздно: врач уже ничего не успеет с окном, а перенести
  // некуда — ближе минимального запаса система времени не предлагает.
  it('идёт без кнопок', async () => {
    const calls = capture();
    await notifyReminder('T', SUBJ, 'Кабинет', 'Пломба', '2026-09-10T05:00:00Z', 'hour', APPT, APP);
    expect(calls[0].body.reply_markup).toBeUndefined();
  });
});

describe('текст после подтверждения', () => {
  it('заменяет напоминание, не оставляя вопроса', () => {
    const t = confirmedText('Кабинет', 'Пломба', '2026-09-10T05:00:00Z');
    expect(t).toContain('Приём подтверждён');
    expect(t).not.toContain('Придёте?');
  });

  it('экранирует разметку в названиях', () => {
    expect(confirmedText('<b>Кабинет', 'Пломба & шлифовка', '2026-09-10T05:00:00Z'))
      .toContain('&lt;b&gt;Кабинет');
  });
});

describe('кому не пишем', () => {
  it('без чата с ботом отправки нет', async () => {
    const calls = capture();
    const r = await notifyReminder('T', 'email:кто-то', 'Кабинет', null, '2026-09-10T05:00:00Z', 'day', APPT, APP);
    expect(r).toBe('no_chat');
    expect(calls).toHaveLength(0);
  });
});

describe('сообщение о готовом плане', () => {
  it('ведёт в приложение и называет сумму', async () => {
    const calls = capture();
    await notifyPlanReady('T', SUBJ, 'Кабинет', 'Лечение 26 зуба', 1950000, APP);
    // Разряды Intl разделяет неразрывным пробелом, и какой именно — зависит
    // от версии ICU. Сверяем по цифрам, а не по конкретному пробелу.
    expect(calls[0].body.text.replace(/\s/g, ' ')).toContain('1 950 000 сум');
    expect(calls[0].body.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`${APP}?plan=1`);
  });

  // Себестоимость не должна просочиться даже в текст уведомления: функция
  // её не принимает вовсе, и это проверяется на сигнатуре, а не на глаз.
  it('не получает и не показывает себестоимость', async () => {
    const calls = capture();
    await notifyPlanReady('T', SUBJ, 'Кабинет', 'План', 100, APP);
    expect(calls[0].body.text).not.toMatch(/себестоим|материал/i);
  });

  it('без чата с ботом молчит', async () => {
    const calls = capture();
    expect(await notifyPlanReady('T', null, 'Кабинет', 'План', 100, APP)).toBe('no_chat');
    expect(calls).toHaveLength(0);
  });
});
