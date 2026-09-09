/**
 * Проверка нового поведения: склад как источник материалов, отмена с причиной
 * и уведомлением, блокировка времени поверх чужой записи.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.WORKER_URL ?? 'https://stomiko-api.alrevion.workers.dev';

function env(key: string): string {
  const raw = readFileSync(resolve(here, '../.dev.vars'), 'utf8');
  for (const l of raw.split('\n')) if (l.trim().startsWith(`${key}=`)) return l.trim().slice(key.length + 1).trim();
  throw new Error(`нет ${key}`);
}
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });


function initData(uid: number, sp?: string): string {
  const f: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat_instance: '-1', chat_type: 'sender',
    user: JSON.stringify({ id: uid, first_name: `U${uid}` }),
  };
  if (sp) f.start_param = sp;
  const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  f.hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}

const as = (uid: number, sp?: string) => async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData(uid, sp), ...(init.headers ?? {}) },
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

const problems: string[] = [];
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

/**
 * Свой кабинет, а не чужой.
 *
 * Набор рассчитывал, что в базе уже есть кабинет у tg:900001 — то есть на
 * следы прошлых прогонов. Стоило базе оказаться чистой (или чужой кабинет
 * удалить), и проверки падали не на продукте, а на своей же подготовке.
 */
async function ownCabinet(uid: number, sb: SupabaseClient, doc: ReturnType<typeof as>) {
  const { data: old_ } = await sb.from('memberships').select('tenant_id').eq('subject', `tg:${uid}`);
  for (const m of old_ ?? []) await sb.rpc('delete_tenant', { p_tenant_id: m.tenant_id });
  await sb.from('app_users').delete().eq('subject', `tg:${uid}`);
  const reg = await doc('/onboarding/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Кабинет Проверки', doctorName: 'Проверкин П.П.', template: 'therapist' }),
  });
  if (reg.status !== 200) throw new Error(`кабинет не создан: ${JSON.stringify(reg.body)}`);
  await doc('/onboarding/finish', { method: 'POST' });
  return String(reg.body.tenantId);
}

async function main() {
  const doc = as(900001);
  const tid = await ownCabinet(900001, sb, doc);

  console.log('── Склад ──');
  const stock = await doc('/doctor/stock');
  check(stock.status === 200, 'склад отдаётся',
    `${stock.body.summary?.total} материалов, ${Math.round(stock.body.summary?.value).toLocaleString('ru-RU')} сум`);
  check(stock.body.materials.every((m: any) => m.unit && typeof m.qty === 'number'), 'у каждого материала есть единица и остаток');

  const unitId = stock.body.units[0]?.id;
  const created = await doc('/doctor/stock', {
    method: 'POST',
    body: JSON.stringify({ nameRu: `Тест-материал ${Date.now()}`, unitId, category: 'resto', referencePrice: 5000 }),
  });
  check(created.status === 200, 'новый материал заводится на складе', String(created.body.materialId ?? created.body.error));
  const matId = created.body.materialId;

  const dup = await doc('/doctor/stock', {
    method: 'POST', body: JSON.stringify({ nameRu: 'Адгезив', unitId, referencePrice: 1 }),
  });
  check(dup.status === 400 && String(dup.body.error).includes('уже есть'), 'дубликат материала отклоняется');

  const recv = await doc(`/doctor/stock/${matId}/receive`, {
    method: 'POST', body: JSON.stringify({ qty: 10, totalPrice: 50000, expiresAt: null, supplier: 'Тест' }),
  });
  check(recv.status === 200, 'приход партии проходит');

  const detail = await doc(`/doctor/stock/${matId}`);
  check(Number(detail.body.batches?.[0]?.qty_remaining) === 10, 'остаток появился', `${detail.body.batches?.[0]?.qty_remaining}`);

  const del = await doc(`/doctor/stock/${matId}`, { method: 'DELETE' });
  check(del.status === 400 && String(del.body.error).includes('движения'),
    'материал с движениями удалить нельзя', String(del.body.error));

  console.log('\n── Техкарта берёт со склада ──');
  const { services } = (await doc('/doctor/services')).body;
  const tc = await doc(`/doctor/techcard/${services[1].id}`);
  check(tc.status === 200 && Array.isArray(tc.body.materials), 'редактор техкарты получает список склада',
    `${tc.body.materials.length} материалов`);

  console.log('\n── Занять время поверх чужой записи ──');
  const patUid = 980000 + (Date.now() % 9000);
  const link = (await doc('/doctor/link')).body.token;
  const pat = as(patUid, link);
  // Номер приходит от Telegram и без него записаться нельзя: подставляем
  // его тем же путём, что вебхук бота, иначе набор проверяет не продукт.
  await pat('/me');
  await sb.rpc('set_verified_phone', { p_subject: `tg:${patUid}`, p_phone: `+99890${1000000 + (Date.now() % 8999999)}` });
  const info = await pat('/book/info');
  const svc = info.body.services[0];
  const slots = await pat(`/book/slots?serviceId=${svc.id}&days=14`);
  const day = slots.body.days?.[0];
  check(Boolean(day), 'слоты есть');
  const at = day.times[day.times.length - 1];

  const booked = await pat('/book', {
    method: 'POST',
    body: JSON.stringify({ serviceId: svc.id, startsAt: at, name: 'Конфликтный Пациент', phone: `+99890${1000000 + (Date.now() % 8999999)}` }),
  });
  check(booked.status === 200, 'пациент записался на слот');

  const from = at;
  const to = new Date(new Date(at).getTime() + svc.durationMinutes * 60000).toISOString();
  const conflicts = await doc(`/doctor/conflicts?startsAt=${encodeURIComponent(from)}&endsAt=${encodeURIComponent(to)}`);
  check((conflicts.body.conflicts ?? []).length >= 1, 'врач видит, кого затронет блокировка',
    conflicts.body.conflicts?.[0]?.patient);
  check(conflicts.body.conflicts?.[0]?.notifiable === true, 'видно, что пациенту можно написать');

  const noReason = await doc('/doctor/block', {
    method: 'POST', body: JSON.stringify({ startsAt: from, endsAt: to, reason: 'Обед' }),
  });
  check(noReason.status === 409, 'без причины отмены блокировка отклоняется', String(noReason.body.error));

  const withReason = await doc('/doctor/block', {
    method: 'POST',
    body: JSON.stringify({ startsAt: from, endsAt: to, reason: 'Обед', cancelReason: 'Врач заболел, переносим' }),
  });
  check(withReason.status === 200, 'с причиной блокировка проходит');
  check((withReason.body.cancelled ?? []).length >= 1, 'запись отменена');
  // Пользователь теста никогда не нажимал Start, поэтому бот написать ему НЕ может:
  // Telegram отвечает «chat not found». Правильное поведение — не тихий успех,
  // а явная причина и телефон, по которому врачу надо позвонить.
  const c0 = withReason.body.cancelled?.[0];
  check(c0?.reason === 'no_chat', 'причина недоставки названа точно', String(c0?.reason));
  check(Boolean(c0?.phone), 'врачу отдан телефон для звонка', String(c0?.phone));

  const my = await pat('/book/my');
  const cancelled = (my.body.appointments ?? []).find((a: any) => a.status === 'cancelled');
  check(Boolean(cancelled), 'пациент видит отменённую запись');

  // За собой убираем: осиротевший кабинет проверки попадёт в поиск и в
  // предпоказ как «проверочные аккаунты не убраны». Один раз уже попал.
  await sb.rpc('delete_tenant', { p_tenant_id: tid });
  await sb.from('app_users').delete().like('subject', 'tg:9%');

  console.log(`\n${problems.length ? `ПРОБЛЕМЫ: ${problems.join('; ')}` : 'Все проверки пройдены.'}`);
  if (problems.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
