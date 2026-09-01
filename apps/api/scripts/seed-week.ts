/**
 * Записи на ближайшую неделю — чтобы врач открыл живой календарь, а не пустой.
 *
 * Идёт через продовый `book_appointment`: тот же путь, что и у пациента,
 * с той же защитой от двойной записи. Второго способа создать запись нет.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const raw = readFileSync(resolve(here, '../.dev.vars'), 'utf8');
  const v = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) v.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return { url: v.get('SUPABASE_URL')!, key: v.get('SUPABASE_SERVICE_ROLE_KEY')! };
}

const FIRST = ['Санжар', 'Дилноза', 'Азиз', 'Малика', 'Тимур', 'Нигора', 'Рустам', 'Зухра', 'Бекзод', 'Феруза', 'Отабек', 'Камола'];
const LAST = ['Азизов', 'Каримова', 'Юсупов', 'Рахимова', 'Тошматов', 'Эргашева', 'Абдуллаев', 'Саидова'];
const NOTES = ['болит при холодном', 'откололся край', 'плановый осмотр', 'кровит десна', '', 'выпала пломба'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

async function main() {
  const { url, key } = loadEnv();
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: tenants } = await sb.from('tenants').select('id, name').limit(1);
  const tenantId = tenants![0]!.id as string;
  const { data: chairs } = await sb.from('resources').select('id').eq('tenant_id', tenantId).eq('kind', 'chair').limit(1);
  const chair = chairs![0]!.id as string;
  const { data: services } = await sb
    .from('services').select('id, name_ru, duration_minutes, bookable').eq('tenant_id', tenantId).eq('bookable', true);

  const rand = rng(4242);
  let booked = 0, skipped = 0;

  for (const svcRound of [0, 1, 2]) {
    for (const svc of services ?? []) {
      // Слоты берутся тем же способом, каким их видит пациент.
      const { data: slots } = await sb.rpc('available_slots', {
        p_tenant_id: tenantId,
        p_resource_id: chair,
        p_service_id: svc.id,
        p_from: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }),
        p_to: new Date(Date.now() + 6 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }),
      });
      const free = (slots ?? []) as { slot_start: string }[];
      if (!free.length) { skipped += 1; continue; }

      const pick = free[Math.floor(rand() * free.length)]!;
      const name = `${LAST[Math.floor(rand() * LAST.length)]} ${FIRST[Math.floor(rand() * FIRST.length)]}`;
      const phone = `+9989${String(10000000 + Math.floor(rand() * 89999999))}`;
      // Часть записей — «пришли по ссылке», часть завёл сам кабинет:
      // врач должен видеть разницу в календаре.
      const source = rand() < 0.55 ? 'patient_link' : 'staff';

      const { error } = await sb.rpc('book_appointment', {
        p_tenant_id: tenantId,
        p_resource_id: chair,
        p_service_id: svc.id,
        p_starts_at: pick.slot_start,
        p_patient_name: name,
        p_phone: phone,
        p_note: NOTES[Math.floor(rand() * NOTES.length)] || null,
        p_source: source,
      });
      if (error) { skipped += 1; continue; }
      booked += 1;
    }
    void svcRound;
  }

  const { data: check } = await sb
    .from('appointments').select('id, starts_at, source, status').eq('tenant_id', tenantId)
    .gte('starts_at', new Date().toISOString());
  const upcoming = (check ?? []).filter((a) => a.status !== 'cancelled');

  console.log(`Записано: ${booked}, пропущено (нет слота): ${skipped}`);
  console.log(`Впереди записей: ${upcoming.length}, из них по ссылке: ${upcoming.filter((a) => a.source === 'patient_link').length}`);

  if (upcoming.length < 8) {
    console.error('Календарь получился слишком пустым для показа.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
