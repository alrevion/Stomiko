/** Специализации: список, мультивыбор, поиск по ним, имя врача из профиля. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} });
function initData(uid: number) {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender', user: JSON.stringify({ id: uid, first_name:'T' }) };
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}
const as = (uid: number) => async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': initData(uid), ...(init.headers??{}) } });
  return { status: r.status, body: (await r.json().catch(()=>({}))) as any };
};
const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };

const DOC = 996001, PAT = 996002;
const checker = as(Number(env('PLATFORM_OWNERS').replace('tg:', '')));
for (const uid of [DOC, PAT]) {
  const { data } = await sb.from('memberships').select('tenant_id').eq('subject', `tg:${uid}`);
  for (const m of data ?? []) await sb.rpc('delete_tenant', { p_tenant_id: m.tenant_id });
  await sb.from('app_users').delete().eq('subject', `tg:${uid}`);
}
const doc = as(DOC), pat = as(PAT);

console.log('── ФИО не спрашивают дважды ──');
await doc('/me');
await sb.rpc('set_person_profile', { p_subject: `tg:${DOC}`, p_full_name: 'Каримов Азиз Акмалович' });
const tpl = await doc('/onboarding/templates');
ok((tpl.body.specialties ?? []).length >= 9, 'специализации приходят списком',
  `${(tpl.body.specialties ?? []).length} шт.`);
const reg = await doc('/onboarding/register', { method:'POST', body: JSON.stringify({
  name:'Кабинет Специализаций', template:'therapist',
  specialties:['therapist','orthopedist','surgeon'] }) });
const tid = reg.body.tenantId as string;
ok(reg.status === 200, 'кабинет создан без второго ввода ФИО', String(reg.body.error ?? ''));
await doc('/onboarding/finish', { method:'POST' });
const l0 = await doc('/doctor/listing');
ok(l0.body.doctor === 'Каримов Азиз Акмалович',
  'имя врача взято из профиля платформы', String(l0.body.doctor));

console.log('\n── Мультивыбор ──');
ok(JSON.stringify(l0.body.specialties) === JSON.stringify(['orthopedist','surgeon','therapist']),
  'сохранены все три специализации', JSON.stringify(l0.body.specialties));
ok((l0.body.specialtyList ?? []).some((x: any) => x.code === 'pediatric'),
  'справочник специализаций доехал до экрана');
const empty = await doc('/doctor/profile', { method:'PUT', body: JSON.stringify({ specialties: [] }) });
ok(empty.status === 400, 'пустой список не принимается', String(empty.body.error ?? ''));
const junk = await doc('/doctor/profile', { method:'PUT', body: JSON.stringify({ specialties: ['косметолог'] }) });
ok(junk.status === 400, 'выдуманная специализация не сохраняется', String(junk.body.error ?? ''));
const mixed = await doc('/doctor/profile', { method:'PUT', body: JSON.stringify({
  specialties: ['pediatric', 'выдумка', 'pediatric'] }) });
ok(mixed.status === 200 && JSON.stringify(mixed.body.specialties) === JSON.stringify(['pediatric']),
  'из смеси остаётся только известное, без повторов', JSON.stringify(mixed.body.specialties));

console.log('\n── Имя врача правится, не ломая карточку ──');
const short = await doc('/doctor/profile', { method:'PUT', body: JSON.stringify({ doctor: 'К' }) });
ok(short.status === 400, 'имя из одной буквы не принимается', String(short.body.error ?? ''));
const renamed = await doc('/doctor/profile', { method:'PUT', body: JSON.stringify({
  specialties: ['therapist','orthodontist'], doctor: 'Каримов А.А.' }) });
ok(renamed.body.doctor === 'Каримов А.А.', 'имя изменилось', String(renamed.body.doctor));

console.log('\n── Пациент видит специализации и ищет по ним ──');
await doc('/doctor/license', { method:'PUT', body: JSON.stringify({ number:'47895138' }) });
await checker(`/admin/licenses/${tid}`, { method:'POST', body: JSON.stringify({
  verdict:'verified', validUntil:'2030-01-01' }) });
await doc('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', phone:'+998901112233', listed:true }) });
const found = await pat('/find');
const mine = (found.body.cabinets ?? []).find((x: any) => x.tenantId === tid);
ok(!!mine, 'кабинет найден');
ok(JSON.stringify(mine?.specialties) === JSON.stringify(['orthodontist','therapist']),
  'специализации доехали до выдачи', JSON.stringify(mine?.specialties));
ok((found.body.specialties ?? []).some((x: any) => x.code === 'orthodontist' && x.nameRu === 'Ортодонт'),
  'словарь названий приехал вместе с выдачей');
const bySpec = await pat('/find?q=Ортодонт');
ok((bySpec.body.cabinets ?? []).some((x: any) => x.tenantId === tid),
  'поиск по названию специализации находит кабинет');
const byOther = await pat('/find?q=Пародонтолог');
ok(!(byOther.body.cabinets ?? []).some((x: any) => x.tenantId === tid),
  'по чужой специализации кабинет не находится');

console.log('\n── Уборка ──');
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён', del.error?.message ?? '');
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Специализации работают.'}`);
if (problems.length) process.exit(1);
