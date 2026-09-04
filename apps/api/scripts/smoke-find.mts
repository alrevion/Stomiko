/** Поиск стоматолога: публикация кабинета врачом и запись пациента без ссылки. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
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

const OPEN = 990401, SHUT = 990402, PAT = 990403;
await sb.from('memberships').delete().in('subject', [`tg:${OPEN}`, `tg:${SHUT}`]);
await sb.from('app_users').delete().in('subject', [`tg:${OPEN}`, `tg:${SHUT}`, `tg:${PAT}`]);
const open = as(OPEN), shut = as(SHUT), pat = as(PAT);

console.log('── Два кабинета: один откроется, второй нет ──');
const r1 = await open('/onboarding/register', { method:'POST', body: JSON.stringify({ name:'Кабинет Открытый', doctorName:'Каримов А.А.', template:'therapist' }) });
const r2 = await shut('/onboarding/register', { method:'POST', body: JSON.stringify({ name:'Кабинет Закрытый', doctorName:'Юсупов Б.Б.', template:'therapist' }) });
const t1 = r1.body.tenantId as string, t2 = r2.body.tenantId as string;
ok(r1.status === 200 && r2.status === 200, 'кабинеты созданы');
await open('/onboarding/finish', { method:'POST' });
await shut('/onboarding/finish', { method:'POST' });

console.log('\n── Публикация ──');
const bad = await open('/doctor/listing', { method:'PUT', body: JSON.stringify({ listed: true }) });
ok(bad.status === 400, 'без города, адреса и телефона опубликовать нельзя', String(bad.body.error ?? ''));
const good = await open('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', landmark:'напротив Чорсу', phone:'+998901112233', listed:true }) });
ok(good.status === 200 && good.body.listed === true, 'кабинет опубликован');
const back = await open('/doctor/listing');
ok(back.body.city === 'Ташкент' && back.body.listed === true, 'карточка читается обратно',
  `${back.body.city}, ${back.body.landmark}`);

console.log('\n── Пациент без ссылки ──');
const me0 = await pat('/me');
ok(me0.body.mode === 'patient' || me0.body.needsChoice, 'новый человек — пациент по умолчанию');
const found = await pat('/find');
ok(found.status === 200, 'поиск отвечает без кабинета — до этого был тупик');
const mine = (found.body.cabinets ?? []).find((x: any) => x.tenantId === t1);
ok(!!mine, 'опубликованный кабинет найден');
ok(!(found.body.cabinets ?? []).some((x: any) => x.tenantId === t2),
  'НЕопубликованный кабинет в выдаче отсутствует');
ok(mine?.doctor === 'Каримов А.А.', 'показано имя врача, а не заглушка', String(mine?.doctor));
ok(mine?.landmark === 'напротив Чорсу', 'ориентир показан');
ok(typeof mine?.consultPrice === 'number' && mine.consultPrice > 0, 'цена приёма показана', String(mine?.consultPrice));
ok(!!mine?.nextSlot, 'ближайшее свободное время посчитано', String(mine?.nextSlot));
const fields = Object.keys(mine ?? {}).sort().join(',');
ok(fields === 'address,city,consultPrice,doctor,landmark,name,nextSlot,phone,tenantId',
  'в выдаче нет полей сверх согласованных', fields);

console.log('\n── Фильтры ──');
ok((await pat('/find?city=Ташкент')).body.cabinets.some((x: any) => x.tenantId === t1), 'фильтр по городу');
ok(!(await pat('/find?city=Самарканд')).body.cabinets.some((x: any) => x.tenantId === t1), 'чужой город пуст');
ok((await pat('/find?q=Чорсу')).body.cabinets.some((x: any) => x.tenantId === t1), 'поиск по ориентиру');
ok((await pat('/find')).body.cities.some((c: any) => c.city === 'Ташкент'), 'город попал в фильтр');

console.log('\n── Выбор и запись ──');
const stolen = await pat('/me/choose', { method:'POST', body: JSON.stringify({ tenantId: t2 }) });
ok(stolen.status === 400, 'закрытый кабинет по номеру не открывается', String(stolen.body.error ?? ''));
const chose = await pat('/me/choose', { method:'POST', body: JSON.stringify({ tenantId: t1 }) });
ok(chose.status === 200, 'кабинет выбран', String(chose.body.cabinet ?? chose.body.error));
const me1 = await pat('/me');
ok(me1.body.tenantId === t1, 'кабинет стал активным');
const info = await pat('/book/info');
ok(info.status === 200 && (info.body.services ?? []).length > 0, 'услуги видны — запись доступна',
  `${(info.body.services ?? []).length} услуг`);

console.log('\n── Заморозка убирает из поиска ──');
await sb.from('subscriptions').update({ paid_until: new Date(Date.now() - 864e5).toISOString() }).eq('tenant_id', t1);
ok(!(await pat('/find')).body.cabinets.some((x: any) => x.tenantId === t1),
  'замороженный кабинет исчез из выдачи — иначе пациента ведут в закрытую дверь');

console.log('\n── Уборка ──');
for (const id of [t1, t2]) { const d = await sb.rpc('delete_tenant', { p_tenant_id: id }); ok(!d.error, 'кабинет удалён', d.error?.message ?? ''); }
await sb.from('app_users').delete().in('subject', [`tg:${OPEN}`, `tg:${SHUT}`, `tg:${PAT}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Поиск стоматолога работает.'}`);
if (problems.length) process.exit(1);
