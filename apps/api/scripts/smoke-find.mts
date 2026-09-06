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

// Публикация теперь требует проверенной лицензии: кабинет в поиске — это
// совет платформы незнакомому человеку, и он должен быть проверен. Здесь
// проходим тот же путь, что и живой врач: подал номер — проверяющий сверил.
const checker = as(Number(env('PLATFORM_OWNERS').replace('tg:', '')));
const licensed = async (who: ReturnType<typeof as>, tenantId: string, number: string) => {
  await who('/doctor/license', { method: 'PUT', body: JSON.stringify({ number }) });
  return checker(`/admin/licenses/${tenantId}`, { method: 'POST',
    body: JSON.stringify({ verdict: 'verified', validUntil: '2030-01-01' }) });
};

console.log('\n── Публикация ──');
const noLicense = await open('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', phone:'+998901112233', listed:true }) });
ok(noLicense.status === 400, 'без проверенной лицензии в поиск не пускают',
  String(noLicense.body.error ?? ''));
ok((await licensed(open, t1, '47895138')).status === 200, 'лицензия первого кабинета проверена');
ok((await licensed(shut, t2, '47895139')).status === 200, 'лицензия второго кабинета проверена');
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
ok(fields === 'address,city,consultPrice,distanceKm,doctor,landmark,name,nextSlot,phone,tenantId',
  'в выдаче нет полей сверх согласованных', fields);
ok(mine?.distanceKm === null, 'без места человека расстояние не выдумывается', String(mine?.distanceKm));

console.log('\n── Фильтры ──');
ok((await pat('/find?city=Ташкент')).body.cabinets.some((x: any) => x.tenantId === t1), 'фильтр по городу');
ok(!(await pat('/find?city=Самарканд')).body.cabinets.some((x: any) => x.tenantId === t1), 'чужой город пуст');
ok((await pat('/find?q=Чорсу')).body.cabinets.some((x: any) => x.tenantId === t1), 'поиск по ориентиру');
ok((await pat('/find')).body.cities.some((c: any) => c.city === 'Ташкент'), 'город попал в фильтр');

console.log('\n── Профиль: ФИО и место ──');
const noName = await pat('/me/profile', { method:'PUT', body: JSON.stringify({ fullName:'К' }) });
ok(noName.status === 400, 'имя из одной буквы не принимается', String(noName.body.error ?? ''));
const half = await pat('/me/profile', { method:'PUT', body: JSON.stringify({ lat: 41.31 }) });
ok(half.status === 200 && half.body.lat === null,
  'широта без долготы не сохраняется как место', JSON.stringify(half.body));
const named = await pat('/me/profile', { method:'PUT', body: JSON.stringify({ fullName:'Каримов Азиз' }) });
ok(named.status === 200 && named.body.fullName === 'Каримов Азиз', 'ФИО сохранено');
const placed = await pat('/me/profile', { method:'PUT', body: JSON.stringify({ lat: 41.31, lon: 69.24 }) });
ok(placed.body.fullName === 'Каримов Азиз', 'отправка места не стирает ФИО', String(placed.body.fullName));
ok(placed.body.lat === 41.31 && placed.body.lon === 69.24, 'место сохранено');
const meNamed = await pat('/me');
ok(meNamed.body.fullName === 'Каримов Азиз' && meNamed.body.lat === 41.31,
  'ФИО и место приходят при входе — второй раз не спросят');

console.log('\n── Ближайшие сверху ──');
// Свой кабинет — рядом; чужой публикуем далеко, в Самарканде.
await open('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Ташкент', address:'ул. Амира Темура, 12', landmark:'напротив Чорсу',
  phone:'+998901112233', listed:true, lat: 41.32, lon: 69.25 }) });
await shut('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Самарканд', address:'ул. Регистан, 1', phone:'+998907776655',
  listed:true, lat: 39.65, lon: 66.96 }) });
const near = (await pat('/find')).body.cabinets ?? [];
const iNear = near.findIndex((x: any) => x.tenantId === t1);
const iFar = near.findIndex((x: any) => x.tenantId === t2);
ok(iNear >= 0 && iFar >= 0 && iNear < iFar, 'ближний кабинет выше дальнего', `${iNear} < ${iFar}`);
ok(near[iNear]?.distanceKm != null && near[iNear].distanceKm < 3,
  'до ближнего — километры, а не сотни', String(near[iNear]?.distanceKm));
ok(near[iFar]?.distanceKm > 200 && near[iFar]?.distanceKm < 350,
  'до Самарканда честные сотни километров', String(near[iFar]?.distanceKm));
// Кабинет без точки участвует в поиске, просто без расстояния.
await sb.from('tenants').update({ lat: null, lon: null }).eq('id', t2);
const mixed = (await pat('/find')).body.cabinets ?? [];
ok(mixed.some((x: any) => x.tenantId === t2 && x.distanceKm === null),
  'кабинет без точки не выпадает из поиска');
ok(mixed.findIndex((x: any) => x.tenantId === t1) < mixed.findIndex((x: any) => x.tenantId === t2),
  'кабинет с расстоянием идёт раньше кабинета без него');
await shut('/doctor/listing', { method:'PUT', body: JSON.stringify({
  city:'Самарканд', address:'ул. Регистан, 1', phone:'+998907776655', listed:false }) });

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

console.log('\n── Свой кабинет открыт, даже если не в поиске ──');
// Большинство частных кабинетов в поиске не показываются — работают по
// ссылке. Вернуться к своему стоматологу человек должен всё равно.
// Пациент уже лечится в первом кабинете — заводим ему там карточку.
const ins = await sb.from('patients').insert({ tenant_id: t1,
  full_name: 'Свой Пациент', telegram_subject: `tg:${PAT}` });
ok(!ins.error, 'карточка пациента в кабинете заведена', ins.error?.message ?? '');
await sb.from('tenants').update({ listed: false }).eq('id', t1);
const backOwn = await pat('/me/choose', { method: 'POST', body: JSON.stringify({ tenantId: t1 }) });
ok(backOwn.status === 200, 'к СВОЕМУ кабинету можно вернуться без публикации',
   String(backOwn.body.error ?? backOwn.body.cabinet));
const alienShut = await pat('/me/choose', { method: 'POST', body: JSON.stringify({ tenantId: t2 }) });
ok(alienShut.status === 400, 'в ЧУЖОЙ закрытый кабинет по-прежнему нельзя', `${alienShut.status}`);

console.log('\n── Уборка ──');
for (const id of [t1, t2]) { const d = await sb.rpc('delete_tenant', { p_tenant_id: id }); ok(!d.error, 'кабинет удалён', d.error?.message ?? ''); }
await sb.from('app_users').delete().in('subject', [`tg:${OPEN}`, `tg:${SHUT}`, `tg:${PAT}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Поиск стоматолога работает.'}`);
if (problems.length) process.exit(1);
