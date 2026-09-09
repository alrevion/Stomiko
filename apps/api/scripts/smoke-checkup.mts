/** Профилактический осмотр: есть у всех, стоит первым, записывает без выбора. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} });
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
const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };

const DOC = 998101, PAT = 998102;
for (const uid of [DOC, PAT]) {
  const { data } = await sb.from('memberships').select('tenant_id').eq('subject', `tg:${uid}`);
  for (const m of data ?? []) await sb.rpc('delete_tenant', { p_tenant_id: m.tenant_id });
  await sb.from('app_users').delete().eq('subject', `tg:${uid}`);
}
const doc = as(DOC);

console.log('── Осмотр приезжает с любым справочником ──');
for (const tpl of ['therapist','surgeon','orthopedist','orthodontist','pediatric','periodontist']) {
  const { data: t } = await sb.from('catalog_templates').select('id').eq('code', tpl).single();
  const { count } = await sb.from('template_services').select('*', { count:'exact', head:true })
    .eq('template_id', t!.id).eq('code', 'A01.07.001');
  ok((count ?? 0) === 1, `${tpl}: осмотр в справочнике`);
}

console.log('\n── Кабинет и запись ──');
const reg = await doc('/onboarding/register', { method:'POST', body: JSON.stringify({
  name:'Кабинет Осмотра', doctorName:'Проверкин П.П.', template:'surgeon' }) });
const tid = reg.body.tenantId as string;
await doc('/onboarding/finish', { method:'POST' });
const { data: svc } = await sb.from('services').select('duration_minutes, price, techcard_version_id')
  .eq('tenant_id', tid).eq('code','A01.07.001').single();
ok(!!svc, 'осмотр доехал до кабинета хирурга');
ok(svc?.duration_minutes === 15, 'на осмотр отведено 15 минут', `${svc?.duration_minutes}`);
ok(!!svc?.techcard_version_id, 'у осмотра есть техкарта — приём закроется с себестоимостью');

const link = (await sb.from('tenants').select('public_token').eq('id', tid).single()).data!.public_token;
const pat = as(PAT, link);
await pat('/me');
await sb.rpc('set_verified_phone', { p_subject: `tg:${PAT}`, p_phone: '+998900998102' });
const info = await pat('/book/info');
const первая = (info.body.services ?? [])[0];
ok(первая?.checkup === true, 'осмотр стоит ПЕРВЫМ в списке услуг', String(первая?.name));
ok(первая?.durationMinutes === 15 && Number(первая?.price) > 0,
  'у осмотра есть время и цена', `${первая?.durationMinutes} мин, ${первая?.price}`);
ok((info.body.services ?? []).filter((s: any) => s.checkup).length === 1,
  'осмотр в списке ровно один');

const slots = await pat(`/book/slots?serviceId=${первая.id}&days=14`);
const day = (slots.body.days ?? [])[0];
ok(!!day?.times?.length, 'свободное время под осмотр есть', `${slots.body.days?.length} дней`);
const booked = await pat('/book', { method:'POST', body: JSON.stringify({
  serviceId: первая.id, startsAt: day.times[0], name:'Проверкин Пациент' }) });
ok(booked.status === 200, 'пациент записался, не выбирая услугу', String(booked.body.error ?? ''));

const cal = await doc(`/doctor/calendar?from=${day.date}&to=${day.date}`);
const запись = (cal.body.appointments ?? []).find((a: any) => a.startsAt === day.times[0]);
ok(!!запись, 'запись видна врачу в календаре');
ok(String(запись?.service ?? '').includes('осмотр'), 'врач видит, что это осмотр', String(запись?.service));
const минут = запись ? (new Date(запись.endsAt).getTime() - new Date(запись.startsAt).getTime()) / 60000 : 0;
ok(минут === 15, 'в календаре занято ровно 15 минут', `${минут}`);

console.log('\n── Уборка ──');
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён', del.error?.message ?? '');
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Профилактический осмотр работает.'}`);
if (problems.length) process.exit(1);
