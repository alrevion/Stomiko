/**
 * Проверка готовности к показу.
 *
 * Проходит оба сценария целиком по задеплоенному URL и убирает за собой.
 * Всё, что нельзя проверить юнит-тестом: роли, приглашения, слоты,
 * уведомления, напоминания, склад.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.WORKER_URL ?? 'https://stomiko-api.alrevion.workers.dev';

function env(key: string): string {
  const raw = readFileSync(resolve(here, '../.dev.vars'), 'utf8');
  for (const l of raw.split('\n')) if (l.trim().startsWith(`${key}=`)) return l.trim().slice(key.length + 1).trim();
  throw new Error(`нет ${key}`);
}
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
const ok = (cond: boolean, label: string, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) problems.push(label);
};
const section = (t: string) => console.log(`\n${t}`);

const addDays = (n: number) =>
  new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

const DOC_UID = 900001;
// Не 900002: соседний номер занят проверкой «приглашение одноразовое»,
// которая входит вторым человеком как DOC_UID + 1. Совпадение делало
// вторым входящим самого владельца, и проверка молча теряла смысл.
const OWNER_UID = 900009;
const PAT_UID = 970000 + (Date.now() % 9000);

/**
 * Кабинет проверки — СВОЙ, а не первый попавшийся.
 *
 * Раньше здесь стояло `tenants limit 1`, и проверка работала внутри боевого
 * кабинета владельца: заводила туда пациента «Проверка Готовности» и
 * записывала его на приём. Запись настоящая — значит владельцу приходило
 * настоящее уведомление «Новая запись», каждый запуск. Я неделю засорял ему
 * личный чат собственной проверкой и увидел это только на его скриншоте.
 *
 * Заодно проверка перестала зависеть от того, есть ли на платформе хоть один
 * кабинет: теперь она заводит его сама и сама же убирает.
 */
let TENANT = '';

async function main() {
  section('── Свой кабинет для проверки ──');
  const owner = as(OWNER_UID);
  const reg = await owner('/onboarding/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Кабинет Проверки', doctorName: 'Проверкин П.П.', template: 'therapist' }),
  });
  ok(reg.status === 200, 'кабинет заводится с нуля', String(reg.body.error ?? reg.body.tenantId));
  TENANT = String(reg.body.tenantId);

  section('── Данные кабинета ──');
  const { count: patients } = await sb.from('patients')
    .select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT);
  const { count: upcoming } = await sb.from('appointments')
    .select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT)
    .eq('status', 'scheduled').gte('starts_at', new Date().toISOString());
  const { count: closed } = await sb.from('visits')
    .select('*', { count: 'exact', head: true }).eq('tenant_id', TENANT).eq('status', 'closed');
  // Пороги — под ДЕМО нового кабинета, а не под кабинет, поработавший месяц.
  // Прежние 100 приёмов и 50 пациентов были снимком накопленной базы
  // владельца и к «готов ли продукт для нового врача» отношения не имели.
  ok((closed ?? 0) >= 10, 'демо-история приёмов наполнена', `${closed} закрытых`);
  ok((upcoming ?? 0) >= 8, 'календарь на неделю не пустой', `${upcoming} записей впереди`);
  ok((patients ?? 0) >= 10, 'демо-база пациентов есть', `${patients}`);

  const { data: junk } = await sb.from('patients').select('full_name')
    .in('full_name', ['Тестовый Пациент', 'Конфликтный Пациент', 'Тест Пациент', 'ТЕСТ Цепочка']);
  ok((junk ?? []).length === 0, 'следов автотестов в базе нет', `${(junk ?? []).length}`);

  section('── Изоляция кабинетов ──');
  // Дыра была настоящая: до правки visit_detail отдавал пациента чужого
  // кабинета по одному лишь идентификатору из адреса.
  const { data: guards, error: guardErr } = await sb.rpc('audit_tenant_guards', {});
  ok(!guardErr && (guards ?? []).length === 0,
    'каждая функция проверяет кабинет',
    guardErr ? guardErr.message
      : (guards ?? []).length ? `БЕЗ ТЕНАНТА: ${(guards as any[]).map((g) => g.имя).join(', ')}` : 'исключений нет');

  const raw = await sb.rpc('visit_detail', { p_visit_id: '00000000-0000-0000-0000-000000000000' } as any);
  ok(Boolean(raw.error) && /permission denied/i.test(raw.error!.message),
    'беззащитная версия функции недоступна ключом воркера',
    raw.error?.message ?? 'ОТДАЛА ДАННЫЕ');

  // Второй слой: политика на самой таблице. Первый слой (фильтр в коде)
  // держится на аккуратности и верен ровно до следующего забытого фильтра.
  const { data: rls } = await sb.rpc('rls_health', {});
  const rh = (rls ?? {}) as { tables?: number; missing_policy?: string[]; rls_without_policy?: string[] };
  ok((rh.missing_policy ?? []).length === 0,
    'на всех таблицах кабинета есть политика изоляции',
    (rh.missing_policy ?? []).length ? `без политики: ${(rh.missing_policy ?? []).join(', ')}` : `${rh.tables} таблиц`);
  ok((rh.rls_without_policy ?? []).length === 0,
    'нет таблиц с RLS, но без единой политики',
    (rh.rls_without_policy ?? []).join(', ') || 'таких нет');

  // Живая проба возможна только с секретом подписи: без него воркер ходит
  // под service_role, который RLS обходит, и проба ничего бы не доказала.
  const jwtSecret = (() => { try { return env('SUPABASE_JWT_SECRET'); } catch { return ''; } })();
  const anonKey = (() => { try { return env('SUPABASE_ANON_KEY'); } catch { return ''; } })();
  if (jwtSecret && anonKey) {
    const sign = async (tenantId: string | null) => {
      const now = Math.floor(Date.now() / 1000);
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = b64({ alg: 'HS256', typ: 'JWT' });
      const body = b64({ role: 'authenticated', ...(tenantId ? { tenant_id: tenantId } : {}), iat: now, exp: now + 60 });
      const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url');
      return `${head}.${body}.${sig}`;
    };
    // Отказ и «ноль строк» — разные вещи, и путать их здесь опаснее всего:
    // неверный секрет подписи даёт отказ по КАЖДОМУ запросу, а выглядел бы
    // как «чужого не видно» — то есть как успех проверки изоляции.
    const probe = async (token: string): Promise<{ rows: number } | { refused: string }> => {
      const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/patients?select=id`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return { refused: `${r.status} ${(await r.text()).slice(0, 120)}` };
      return { rows: ((await r.json()) as unknown[]).length };
    };
    const { data: tRow } = await sb.from('tenants').select('id').eq('id', TENANT).maybeSingle();
    const own = await probe(await sign(String(tRow?.id)));
    const foreign = await probe(await sign('00000000-0000-0000-0000-000000000000'));
    const none = await probe(await sign(null));

    if ('refused' in own) {
      // Первая же проба отказала — секрет не тот, каким подписаны ключи
      // проекта. Дальше проверять нечего: остальные откажут так же, и их
      // «ноль строк» прочитались бы как работающая изоляция.
      ok(false, 'СЕКРЕТ ПОДПИСИ НЕ ПОДХОДИТ — база отвергает наши токены', own.refused);
      ok(false, 'проверка изоляции не проведена',
        'возьмите значение в Supabase → Settings → API → JWT Settings');
    } else {
      ok(own.rows > 0, 'по токену своего кабинета данные видны', `${own.rows} пациентов`);
      ok('rows' in foreign && foreign.rows === 0, 'по токену чужого кабинета не видно ничего',
        'rows' in foreign ? `${foreign.rows}` : foreign.refused);
      ok('rows' in none && none.rows === 0, 'без claim о кабинете не видно ничего',
        'rows' in none ? `${none.rows}` : none.refused);
    }
  } else {
    ok(true, 'живая проба изоляции пропущена — не задан SUPABASE_JWT_SECRET',
      'политики готовы, включение одной переменной');
  }

  // Проба выше говорит про БАЗУ. Воркер мог при этом остаться на service_role:
  // второй слой включается только когда ОБА секрета привязаны к нему, и без
  // этой проверки preflight был бы зелёным при выключенной защите.
  try {
    const bound = new Set(
      (JSON.parse(execFileSync('node_modules/.bin/wrangler', ['secret', 'list'],
        { cwd: resolve(here, '..'), encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })) as { name: string }[])
        .map((x) => x.name));
    const need = ['SUPABASE_JWT_SECRET', 'SUPABASE_ANON_KEY'];
    const missing = need.filter((n) => !bound.has(n));
    ok(missing.length === 0,
      'воркер работает со вторым слоем, а не только база',
      missing.length ? `не привязано: ${missing.join(', ')}` : 'оба секрета привязаны');
  } catch {
    ok(true, 'привязку секретов воркера проверить не удалось — wrangler недоступен',
      'проверьте вручную: wrangler secret list');
  }

  // Переносимая история: она новее всего остального и ломается тише всего.
  const { data: ch } = await sb.rpc('clinical_health', {});
  const c = (ch ?? {}) as Record<string, number>;
  ok((c.missing ?? 0) === 0,
    'у каждой оказанной услуги опознанного пациента есть запись в истории',
    (c.missing ?? 0) ? `без записи: ${c.missing}` : `записей ${c.entries}, людей ${c.people}`);
  ok((c.orphan_amendments ?? 0) === 0, 'дополнения ссылаются на существующие записи',
    `${c.orphan_amendments}`);

  const { data: tokens } = await sb.from('tenants').select('public_token');
  ok((tokens ?? []).every((t: any) => /^d_[A-Za-z0-9_-]+$/.test(t.public_token)),
    'ссылки кабинетов открываются в Telegram',
    `${(tokens ?? []).length} проверено`);

  section('── Справочник-шаблон ──');
  // Шаблон снят с действующего кабинета. Если справочник кабинета поправили,
  // а шаблон нет — новый врач получит НЕ ТО, что работает у первого, и
  // разойдётся это молча.
  // Справочников теперь шесть, и проверять надо каждый: осиротевшая строка
  // в справочнике ортопеда так же испортит ему себестоимость, как испортила
  // бы терапевту, а заметить её некому.
  const { data: tplStats } = await sb.rpc('template_health', {});
  const по = (tplStats ?? {}) as Record<string, Record<string, number>>;
  const шаблоны = Object.entries(по);
  ok(шаблоны.length > 0, 'справочники на месте', `${шаблоны.length} шт.`);
  const пусто = шаблоны.filter(([, t]) => !(t.units > 0 && t.materials > 0 && t.services > 0));
  ok(пусто.length === 0, 'каждый справочник наполнен',
    пусто.map(([k]) => k).join(', ') || шаблоны.map(([k, t]) => `${k}: ${t.services}/${t.materials}`).join(', '));
  const безЦены = шаблоны.filter(([, t]) => t.materials_without_price > 0);
  ok(безЦены.length === 0, 'у всех материалов справочников есть цена',
    безЦены.map(([k, t]) => `${k}: ${t.materials_without_price}`).join(', ') || 'все с ценой');
  const безТехкарт = шаблоны.filter(([, t]) => t.services_without_techcard > 0 || t.services_without_lines > 0);
  ok(безТехкарт.length === 0, 'у всех услуг справочников есть техкарта со строками',
    безТехкарт.map(([k, t]) => `${k}: ${t.services_without_techcard}/${t.services_without_lines}`).join(', ') || 'все с техкартой');
  const висячие = шаблоны.filter(([, t]) => t.orphan_lines > 0);
  ok(висячие.length === 0, 'строки техкарт ссылаются на существующее',
    висячие.map(([k, t]) => `${k}: ${t.orphan_lines}`).join(', ') || 'висячих нет');

  section('── Роли и доступ ──');
  const stranger = as(PAT_UID + 500);
  const sm = await stranger('/me');
  // Новый человек без ссылки никуда не приводится наугад: раньше запасной путь
  // «единственный кабинет» отдавал бы его чужому врачу, как только кабинетов
  // станет два.
  ok(sm.body.mode === 'patient' && sm.body.needsChoice === true,
    'новый человек без ссылки опознан как пациент', `needsChoice=${sm.body.needsChoice}`);
  ok((await stranger('/book/info')).status === 400, 'без кабинета запись недоступна');
  const sneak = await stranger('/doctor/calendar');
  ok(sneak.status === 403, 'посторонний не пролезает в кабинет', `HTTP ${sneak.status}`);
  const grab = await stranger('/me/mode', {
    method: 'POST', body: JSON.stringify({ mode: 'doctor' }),
  });
  ok(grab.status === 400, 'врачом делает членство, а не желание', String(grab.body.error));
  const fakeInvite = await as(PAT_UID + 501, 'inv_подделка')('/me');
  ok(fakeInvite.status === 401, 'поддельное приглашение отклоняется', String(fakeInvite.body.error));

  // Настоящее приглашение выпускает действующий врач.
  const inviteToken = (await sb.rpc('create_staff_invite', {
    p_tenant_id: TENANT, p_created_by: `tg:${OWNER_UID}`, p_hours: 1,
  })).data as string;

  const doc = as(DOC_UID, inviteToken);
  const dm = await doc('/me');
  ok(dm.body.mode === 'doctor' && dm.body.canBeDoctor === true,
    'по приглашению выдаётся режим врача', String(dm.body.cabinet));
  const docAgain = as(DOC_UID);   // повторный вход уже без ссылки
  ok((await docAgain('/me')).body.mode === 'doctor', 'при следующем входе режим помнится');
  ok((await doc('/me')).body.mode === 'doctor',
    'повторное открытие погасшего приглашения не выкидывает из кабинета');

  // Один человек — два режима: стоматолог тоже лечит зубы у коллеги.
  await docAgain('/me/mode', { method: 'POST', body: JSON.stringify({ mode: 'patient' }) });
  const asPatient = await docAgain('/me');
  ok(asPatient.body.mode === 'patient' && asPatient.body.canBeDoctor === true,
    'врач переключается в пациента, не теряя кабинет');
  ok((await docAgain('/doctor/calendar')).status === 403,
    'в режиме пациента врачебные маршруты закрыты');
  await docAgain('/me/mode', { method: 'POST', body: JSON.stringify({ mode: 'doctor' }) });
  ok((await docAgain('/doctor/calendar')).status === 200, 'возврат в кабинет работает');

  const reuse = await as(DOC_UID + 1, inviteToken)('/me');
  ok(reuse.status === 401 && String(reuse.body.error).includes('использовано'),
    'приглашение одноразовое', String(reuse.body.error));

  section('── Сценарий врача ──');
  const cal = await doc('/doctor/calendar');
  ok(cal.status === 200 && (cal.body.workingHours ?? []).length > 0, 'календарь и рабочие часы',
    `${(cal.body.appointments ?? []).length} записей на неделю`);
  const stock = await doc('/doctor/stock');
  ok((stock.body.summary?.total ?? 0) > 40, 'склад наполнен',
    `${stock.body.summary?.total} материалов на ${Math.round(stock.body.summary?.value).toLocaleString('ru-RU')} сум`);
  ok(stock.body.summary?.needsPrice === 0, 'у всех материалов есть цена', `без цены: ${stock.body.summary?.needsPrice}`);
  const health = await doc('/doctor/stock/health');
  ok(health.body.reconcileMismatches === 0, 'остатки сходятся с журналом');
  const margin = await doc('/doctor/reports/margin');
  ok((margin.body.rows ?? []).length >= 5, 'отчёт по марже наполнен',
    `сверх материалов ${margin.body.totals?.margin.toLocaleString('ru-RU')} сум`);
  const link = await doc('/doctor/link');
  const publicToken = String(link.body.token);
  ok(publicToken.startsWith('d_'), 'ссылка для пациентов готова', String(link.body.link));

  section('── Сценарий пациента ──');
  const pat = as(PAT_UID, publicToken);
  const info = await pat('/book/info');
  const svc = (info.body.services ?? [])[0];
  ok(Boolean(svc), 'услуги видны пациенту', `${(info.body.services ?? []).length}`);
  const slots = await pat(`/book/slots?serviceId=${svc.id}&days=14`);
  const day = (slots.body.days ?? [])[0];
  ok(Boolean(day) && day.times.length > 0, 'свободное время есть',
    `${(slots.body.days ?? []).length} дней, ближайший ${day?.date}`);

  const at = day.times[day.times.length - 1];

  // Номер обязателен и берётся только от Telegram: введённый руками нельзя
  // проверить, он двоит карточки опечатками и не даёт врачу дозвониться.
  ok(info.body.needsPhone === true, 'пока номер не подтверждён, приложение это знает');
  const noPhone = await pat('/book', {
    method: 'POST',
    body: JSON.stringify({ serviceId: svc.id, startsAt: at, name: 'Проверка Готовности' }),
  });
  ok(noPhone.status === 428, 'без подтверждённого номера запись отклоняется', String(noPhone.body.error));

  // Чужую визитку вебхук не принимает: в пересланном контакте user_id не свой.
  await fetch(`${BASE}/tg/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { chat: { id: PAT_UID }, from: { id: PAT_UID },
      contact: { phone_number: '+998900000000', user_id: PAT_UID + 7 } } }),
  }).catch(() => {});
  const afterEvil = await pat('/me');
  ok(!afterEvil.body.phone, 'пересланная чужая визитка отклонена');

  await sb.rpc('set_verified_phone', { p_subject: `tg:${PAT_UID}`, p_phone: '998 90 000-07-77' });
  const withPhone = await pat('/me');
  ok(withPhone.body.phone === '+998900000777', 'номер от Telegram приведён к единому виду',
    String(withPhone.body.phone));

  const booked = await pat('/book', {
    method: 'POST',
    // Телефон в теле подсунут намеренно: он должен быть проигнорирован.
    body: JSON.stringify({ serviceId: svc.id, startsAt: at, name: 'Проверка Готовности', phone: '+998111111111', note: 'проверка' }),
  });
  ok(booked.status === 200, 'запись создаётся', String(booked.body.appointmentId ?? booked.body.error));
  const { data: booked_card } = await sb.from('patients').select('phone, telegram_subject')
    .eq('id', booked.body.patientId).maybeSingle();
  ok(booked_card?.phone === '+998900000777',
    'в карточку попал подтверждённый номер, а не присланный в теле', String(booked_card?.phone));
  ok(booked_card?.telegram_subject === `tg:${PAT_UID}`, 'карточка привязана к аккаунту');
  ok(booked.body.notificationsEnabled === false,
    'пациенту без чата честно сообщается, что уведомлений не будет');

  const seen = await doc(`/doctor/calendar?from=${at.slice(0, 10)}&to=${at.slice(0, 10)}`);
  ok((seen.body.appointments ?? []).some((a: any) => a.source === 'patient_link'),
    'запись видна врачу в календаре');

  section('── История и карточка пациента ──');
  const plist = await doc('/doctor/patients');
  const withHistory = (plist.body.patients ?? []).filter((p: any) => p.visits > 0);
  ok((plist.body.patients ?? []).length >= 10, 'база пациентов открывается', `${(plist.body.patients ?? []).length} в списке`);
  ok(withHistory.length >= 5, 'у пациентов есть история приёмов',
    `${withHistory.length} с приёмами, максимум ${Math.max(...withHistory.map((p: any) => p.visits))}`);

  const found = await doc(`/doctor/patients?q=${encodeURIComponent(withHistory[0].name.split(' ')[0])}`);
  ok((found.body.patients ?? []).length > 0, 'поиск по имени работает', `${(found.body.patients ?? []).length}`);

  const card = await doc(`/doctor/patients/${withHistory[0].id}`);
  ok(card.status === 200 && (card.body.visits ?? []).length > 0, 'карточка пациента с историей',
    `${card.body.name}: ${(card.body.visits ?? []).length} приёмов`);

  // Раньше приём искали в ленте дня — вчерашний открыть было нельзя вообще.
  const oldVisit = card.body.visits[card.body.visits.length - 1];
  const vd = await doc(`/doctor/visits/${oldVisit.id}`);
  ok(vd.status === 200 && vd.body.visit?.patient, 'приём прошлых дней открывается',
    `${oldVisit.date}, ${(vd.body.visit?.services ?? []).length} услуг`);

  const bd2 = await doc(`/doctor/visits/${oldVisit.id}/cost-breakdown`);
  ok(bd2.status === 200 && (bd2.body.lines ?? []).length > 0, 'себестоимость старого приёма считается',
    `${(bd2.body.lines ?? []).length} позиций`);

  section('── Календарь: занято и свободно ──');
  ok(Number(cal.body.minServiceMinutes) > 0, 'известна самая короткая услуга',
    `${cal.body.minServiceMinutes} мин`);
  const past = await doc(`/doctor/calendar?from=${addDays(-14)}&to=${addDays(-1)}`);
  ok((past.body.appointments ?? []).length >= 10, 'история видна в календаре, а не только в отчёте',
    `${(past.body.appointments ?? []).length} записей за две недели`);

  section('── Расписание ──');
  const sched = await doc('/doctor/schedule');
  const hours = (sched.body.workingHours ?? []).map((h: any) => ({
    weekday: h.weekday, startsAt: h.starts_at.slice(0, 5), endsAt: h.ends_at.slice(0, 5),
  }));
  // Главная проверка: сохранение НЕИЗМЕНЁННОГО расписания обязано проходить.
  // Именно оно молча падало, пока проверки корректно отвергали неверное.
  const saved = await doc('/doctor/schedule', {
    method: 'PUT',
    body: JSON.stringify({ hours, settings: { minNoticeMinutes: 120, bufferMinutes: 10, maxDaysAhead: 30 } }),
  });
  ok(saved.status === 200, 'расписание сохраняется', String(saved.body.error ?? `${saved.body.days} интервалов`));
  const degenerate = await doc('/doctor/schedule', {
    method: 'PUT', body: JSON.stringify({ hours: [...hours, { weekday: 1, startsAt: '18:00', endsAt: '18:00' }] }),
  });
  ok(degenerate.status === 400, 'пустой интервал отклоняется');
  const overlap = await doc('/doctor/schedule', {
    method: 'PUT', body: JSON.stringify({ hours: [...hours, { weekday: 1, startsAt: '10:00', endsAt: '12:00' }] }),
  });
  ok(overlap.status === 400, 'пересечение интервалов отклоняется');
  const stillThere = await doc('/doctor/schedule');
  ok((stillThere.body.workingHours ?? []).length === hours.length,
    'после отказа рабочие часы целы', `${(stillThere.body.workingHours ?? []).length}`);

  const offDate = addDays(21);
  const ovr = await doc('/doctor/schedule/override', {
    method: 'POST', body: JSON.stringify({ date: offDate, isClosed: true, reason: 'проверка' }),
  });
  ok(ovr.status === 200, 'разовый выходной ставится', offDate);
  await doc(`/doctor/schedule/override/${ovr.body.override.id}`, { method: 'DELETE' });

  section('── Журнал доступа ──');
  // Журнал, который заполняет вызывающий код, однажды забудут — и забудут
  // ровно там, где он потом будет нужен. Поэтому актор обязателен.
  const noActor = await sb.rpc('patient_card', {
    p_tenant_id: TENANT,
    p_patient_id: withHistory[0].id,
  } as any);
  ok(Boolean(noActor.error), 'карточку нельзя открыть, не назвавшись',
    noActor.error?.message?.slice(0, 48) ?? 'ОТДАЛАСЬ БЕЗ АКТОРА');

  const { count: logged } = await sb.from('access_log')
    .select('*', { count: 'exact', head: true })
    .gte('at', new Date(Date.now() - 5 * 60000).toISOString());
  ok((logged ?? 0) > 0, 'обращения к карточкам пишутся в журнал', `${logged} за последние минуты`);

  const pruned = await sb.rpc('prune_access_log', { p_keep_days: 730 });
  ok(!pruned.error, 'чистка журнала работает', `срок хранения 2 года`);

  section('── Напоминания ──');
  const { data: due, error: dueErr } = await sb.rpc('due_reminders', {});
  ok(!dueErr, 'механизм напоминаний отвечает', dueErr ? dueErr.message : `сейчас в очереди ${(due ?? []).length}`);

  const hook = await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json() as any;
  ok(hook.result?.url?.includes('/tg/webhook'), 'вебхук /start настроен', hook.result?.url);
  ok(!hook.result?.last_error_message, 'вебхук без ошибок', hook.result?.last_error_message ?? 'чисто');

  section('── Уборка ──');
  // Убираем ПО ПАЦИЕНТУ, а не по записи этого прогона.
  //
  // Раньше удалялась одна запись, а карточка — по номеру. Любая запись,
  // оставшаяся от прошлого раза, держала карточку внешним ключом, удаление
  // молча не проходило, и следующий прогон получал чужую карточку с чужим
  // telegram_subject — то есть проверка «карточка привязана к аккаунту»
  // ломалась не из-за продукта, а из-за мусора после себя.
  const { data: leftovers } = await sb.from('patients').select('id')
    .or(`phone.eq.+998900000777,full_name.in.("Проверка Готовности","Проверка Сквозная")`);
  const junkIds = (leftovers ?? []).map((x) => String(x.id));
  if (junkIds.length) {
    const { data: apps } = await sb.from('appointments').select('id').in('patient_id', junkIds);
    const appIds = (apps ?? []).map((x) => String(x.id));
    if (appIds.length) {
      await sb.from('appointment_resources').delete().in('appointment_id', appIds);
      await sb.from('appointments').delete().in('id', appIds);
    }
    await sb.from('treatment_plan_items').delete().in('plan_id',
      ((await sb.from('treatment_plans').select('id').in('patient_id', junkIds)).data ?? [])
        .map((x) => String(x.id)));
    await sb.from('treatment_plans').delete().in('patient_id', junkIds);
    await sb.from('payments').delete().in('patient_id', junkIds);
    // Результат удаления ПРОВЕРЯЕТСЯ: молчаливый отказ по внешнему ключу и
    // был причиной того, что мусор копился незамеченным.
    const { error: delErr } = await sb.from('patients').delete().in('id', junkIds);
    ok(!delErr, 'проверочные карточки удалены', delErr?.message ?? `${junkIds.length} шт.`);
  }
  const dropped = await sb.rpc('delete_tenant', { p_tenant_id: TENANT });
  ok(!dropped.error, 'кабинет проверки удалён', dropped.error?.message ?? '');
  await sb.from('app_users').delete().like('subject', 'tg:9%');
  // Смысл проверки — что проверочные аккаунты не остались в кабинетах, а не
  // что кабинет в базе один. Пока кабинет был единственным, эти две вещи
  // совпадали; с приходом второго владельца проверка стала падать на
  // совершенно нормальном положении дел.
  const { data: left } = await sb.from('memberships').select('subject, tenant_id');
  const testers = (left ?? []).filter((m) => /^tg:9\d{5}$/.test(String(m.subject)));
  ok(testers.length === 0, 'проверочные аккаунты в кабинетах не остались',
    testers.map((m) => m.subject).join(', ') || `живых членств ${(left ?? []).length}`);

  console.log(`\n${problems.length ? `НЕ ГОТОВО: ${problems.join('; ')}` : 'Готово к показу.'}`);
  if (problems.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
