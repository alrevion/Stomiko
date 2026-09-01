/**
 * Сквозной тест обеих ролей по задеплоенному URL + наполнение недели записями.
 *
 * Проверяет то, что нельзя проверить юнит-тестом: что врач и пациент получают
 * разные приложения, что пациент не пролезает в врачебные маршруты, и что
 * запись пациента доходит до календаря врача.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const URL_BASE = process.env.WORKER_URL ?? 'https://stomiko-api.alrevion.workers.dev';

function env(key: string): string {
  const raw = readFileSync(resolve(here, '../.dev.vars'), 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${key}=`)) return t.slice(key.length + 1).trim();
  }
  throw new Error(`в .dev.vars нет ${key}`);
}
const token = env('TELEGRAM_BOT_TOKEN');

/** Подписываем initData как Telegram, включая signature в строку проверки. */
function initData(userId: number, startParam?: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '-1234567890123456789',
    chat_type: 'sender',
    user: JSON.stringify({ id: userId, first_name: `U${userId}` }),
  };
  if (startParam) fields.start_param = startParam;
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  fields.hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(fields).toString();
}

const as = (uid: number, sp?: string) => async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${URL_BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': initData(uid, sp),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

const problems: string[] = [];
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

async function main() {
  // Тест сам заявляет роль врача через ?startapp=doctor.
  const doc = as(900001);
  const me = await doc('/me');
  check(me.body.role === 'doctor', 'врач получает роль doctor', String(me.body.role));

  console.log('\n── Врач ──');
  const cal = await doc('/doctor/calendar');
  check(cal.status === 200, 'календарь отдаётся',
    `записей ${(cal.body.appointments as unknown[])?.length}, часов ${(cal.body.workingHours as unknown[])?.length}`);

  const sched = await doc('/doctor/schedule');
  check((sched.body.workingHours as unknown[])?.length > 0, 'рабочие часы настроены',
    `${(sched.body.workingHours as unknown[])?.length} интервалов`);

  const link = await doc('/doctor/link');
  const publicLink = String(link.body.link ?? '');
  check(publicLink.includes('startapp=d_'), 'ссылка для пациентов с непрозрачным токеном', publicLink);
  const publicToken = String(link.body.token ?? '');

  const services = await doc('/doctor/services');
  check((services.body.services as unknown[])?.length === 8, 'услуги на месте');

  const firstSvc = (services.body.services as { id: string }[])[0];
  const tc = await doc(`/doctor/techcard/${firstSvc.id}`);
  check(tc.status === 200, 'техкарта открывается для правки',
    `своих строк ${(tc.body.lines as unknown[])?.length}, блоков ${(tc.body.blocks as unknown[])?.length}`);

  console.log('\n── Пациент ──');
  const patientId = 970000 + Math.floor(Number(process.env.SEED ?? 1));
  const pat = as(patientId, publicToken);
  const pme = await pat('/me');
  check(pme.body.role === 'patient', 'новый пользователь получает роль patient', String(pme.body.role));

  const forbidden = await pat('/doctor/calendar');
  check(forbidden.status === 403, 'пациент НЕ пролезает в врачебные маршруты', `HTTP ${forbidden.status}`);

  const info = await pat('/book/info');
  const bookable = (info.body.services as { id: string; name: string; durationMinutes: number }[]) ?? [];
  check(bookable.length === 7, 'пациенту видны только записываемые услуги',
    `${bookable.length} из 8 (рентген скрыт)`);

  const svc = bookable.find((s) => s.durationMinutes >= 40) ?? bookable[0]!;
  const slots = await pat(`/book/slots?serviceId=${svc.id}&days=14`);
  const days = (slots.body.days as { date: string; times: string[] }[]) ?? [];
  check(days.length > 0, 'свободные слоты считаются',
    `${days.length} дней, первый ${days[0]?.date} (${days[0]?.times.length} слотов)`);

  const slot = days[0]!.times[Math.floor(days[0]!.times.length / 2)]!;
  const booked = await pat('/book', {
    method: 'POST',
    body: JSON.stringify({ serviceId: svc.id, startsAt: slot, name: 'Тестовый Пациент', phone: '+998901112233', note: 'болит' }),
  });
  check(booked.status === 200, 'пациент записался', String(booked.body.appointmentId ?? booked.body.error));

  const again = await pat('/book', {
    method: 'POST',
    body: JSON.stringify({ serviceId: svc.id, startsAt: slot, name: 'Другой', phone: '+998909998877' }),
  });
  check(again.status === 409, 'тот же слот второй раз не отдаётся', String(again.body.error));

  const my = await pat('/book/my');
  check((my.body.appointments as unknown[])?.length >= 1, 'пациент видит свои записи');

  console.log('\n── Запись дошла до врача ──');
  const cal2 = await doc(`/doctor/calendar?from=${slot.slice(0, 10)}&to=${slot.slice(0, 10)}`);
  const found = (cal2.body.appointments as { source: string; patient: string }[] ?? [])
    .find((a) => a.source === 'patient_link');
  check(Boolean(found), 'в календаре врача видна запись из ссылки', found?.patient ?? '');

  console.log(`\n${problems.length ? `ПРОБЛЕМЫ: ${problems.join('; ')}` : 'Все проверки пройдены.'}`);
  console.log(`\nСсылка для пациентов: ${publicLink}`);
  if (problems.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
