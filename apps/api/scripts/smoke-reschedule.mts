/** Подтверждение приёма кнопкой и перенос пациентом: полный путь до боевого воркера. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
function initData(uid: number, sp?: string) {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender', user: JSON.stringify({ id: uid, first_name:'T' }) };
  if (sp) f.start_param = sp;
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}
const as = (uid: number, sp?: string) => async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': initData(uid, sp), ...(init.headers??{}) } });
  return { status: r.status, body: (await r.json().catch(()=>({}))) as any };
};
/** Нажатие кнопки под напоминанием приходит вебхуком, а не из приложения. */
const press = (uid: number, apptId: string) =>
  fetch(`${BASE}/tg/webhook`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Telegram-Bot-Api-Secret-Token': env('TELEGRAM_WEBHOOK_SECRET') },
    body: JSON.stringify({ callback_query: {
      id: `cb_${Date.now()}`, from: { id: uid }, data: `cfm:${apptId}`,
      message: { chat: { id: uid }, message_id: 1 } } }),
  }).then((r) => r.status);

const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };

const DOC = 990201, PAT = 990202, STRANGER = 990203;
await sb.from('memberships').delete().eq('subject', `tg:${DOC}`);
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`, `tg:${STRANGER}`]);
const doc = as(DOC);

console.log('── Подготовка ──');
const reg = await doc('/onboarding/register', { method:'POST',
  body: JSON.stringify({ name: 'Кабинет Переносов', template: 'therapist' }) });
ok(reg.status === 200, 'кабинет создан', String(reg.body.error ?? ''));
const tid = reg.body.tenantId as string;
// Обучение отдаёт кабинет с демо-данными; для чистоты записи их убираем.
await doc('/onboarding/finish', { method: 'POST' }).catch(() => {});

const link = (await sb.from('tenants').select('public_token').eq('id', tid).single()).data!.public_token;
const pat = as(PAT, link);
// Номер приходит от Telegram служебным сообщением; здесь ставим его напрямую.
await sb.rpc('set_verified_phone', { p_subject: `tg:${PAT}`, p_phone: '+998900990202' });

const info = await pat('/book/info');
ok(info.status === 200, 'пациент видит кабинет', String(info.body.error ?? ''));
const svc = (info.body.services ?? [])[0];
const slots = await pat(`/book/slots?serviceId=${svc.id}&days=21`);
const firstDay = (slots.body.days ?? [])[0];
ok(!!firstDay, 'свободное время есть');
const booked = await pat('/book', { method:'POST',
  body: JSON.stringify({ serviceId: svc.id, startsAt: firstDay.times[0], name: 'Пациент Переносов' }) });
ok(booked.status === 200, 'запись создана', String(booked.body.error ?? ''));
const aid = booked.body.appointmentId as string;

console.log('\n── Кнопка «Подтверждаю» ──');
ok(await press(STRANGER, aid) === 200, 'вебхук принял нажатие постороннего');
const afterStranger = (await sb.from('appointments').select('confirmed_at').eq('id', aid).single()).data!;
ok(afterStranger.confirmed_at === null,
  'нажатие постороннего НИЧЕГО не подтвердило — сообщение можно переслать кому угодно');

await press(PAT, aid);
const afterOwner = (await sb.from('appointments').select('confirmed_at').eq('id', aid).single()).data!;
ok(afterOwner.confirmed_at !== null, 'владелец подтвердил');
await press(PAT, aid);
const afterTwice = (await sb.from('appointments').select('confirmed_at').eq('id', aid).single()).data!;
ok(afterTwice.confirmed_at === afterOwner.confirmed_at, 'повторное нажатие ничего не переписывает');

const mine = await pat('/me/appointments');
ok(mine.body.appointments.find((a: any) => a.id === aid)?.confirmed === true,
  'отметка видна пациенту в списке');
const cal = await doc(`/doctor/calendar?from=${firstDay.date}&to=${firstDay.date}`);
const inCal = (cal.body.appointments ?? []).find((a: any) => a.id === aid);
ok(inCal?.confirmed === true, 'отметка видна врачу в расписании');
ok(inCal?.reachable === true, 'врач видит, что пациенту есть куда нажимать');

console.log('\n── Перенос ──');
const forMove = await pat(`/me/appointments/${aid}/slots?days=21`);
ok(forMove.status === 200, 'сетка времени для переноса отдана', String(forMove.body.error ?? ''));
const own = new Date(booked.body.startsAt).getTime();
const offered = (forMove.body.days ?? []).flatMap((d: any) => d.times);
ok(offered.includes(booked.body.startsAt),
  'собственное время в сетке есть — своя же бронь не должна его закрывать');
const neighbour = offered.find((t: string) => Math.abs(new Date(t).getTime() - own) <= 60 * 60e3 && t !== booked.body.startsAt);
ok(!!neighbour, 'соседнее время внутри своего же часа доступно — это и есть «сдвинуть немного»',
  String(neighbour ?? '—'));

const stranger = as(STRANGER, link);
const stolen = await stranger(`/me/appointments/${aid}/reschedule`, {
  method:'POST', body: JSON.stringify({ startsAt: neighbour }) });
ok(stolen.status === 404, 'посторонний не может перенести чужую запись', String(stolen.status));

const moved = await pat(`/me/appointments/${aid}/reschedule`, {
  method:'POST', body: JSON.stringify({ startsAt: neighbour }) });
ok(moved.status === 200, 'перенос выполнен', String(moved.body.error ?? ''));
const row = (await sb.from('appointments')
  .select('starts_at, ends_at, confirmed_at, reminded_day_at').eq('id', aid).single()).data!;
ok(new Date(row.starts_at).toISOString() === new Date(neighbour).toISOString(), 'время сменилось');
ok(row.confirmed_at === null, 'подтверждение сброшено — оно относилось к старому времени');
ok(row.reminded_day_at === null, 'напоминание пойдёт заново');
const { count: busy } = await sb.from('appointment_resources')
  .select('*', { count:'exact', head:true }).eq('appointment_id', aid);
ok(busy === 1, 'бронь ровно одна', `${busy}`);
const { count: rows } = await sb.from('appointments')
  .select('*', { count:'exact', head:true }).eq('tenant_id', tid).eq('status','scheduled');
ok(rows === 1, 'запись одна: перенос двигает её, а не плодит новую', `${rows}`);

console.log('\n── Отказы ──');
const night = new Date(new Date(neighbour).setHours(3, 0, 0, 0)).toISOString();
const atNight = await pat(`/me/appointments/${aid}/reschedule`, {
  method:'POST', body: JSON.stringify({ startsAt: night }) });
ok(atNight.status === 409, 'ночью перенести нельзя', `${atNight.status} ${atNight.body.error ?? ''}`);
const past = await pat(`/me/appointments/${aid}/reschedule`, {
  method:'POST', body: JSON.stringify({ startsAt: new Date(Date.now() - 864e5).toISOString() }) });
ok(past.status === 409, 'в прошлое перенести нельзя', `${past.status}`);

console.log('\n── Уборка ──');
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён', del.error?.message ?? '');
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`, `tg:${STRANGER}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Подтверждение и перенос работают.'}`);
if (problems.length) process.exit(1);
