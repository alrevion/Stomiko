/** Путь врача с нуля: регистрация → демо → знакомство → очистка. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
function initData(uid: number) {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender', user: JSON.stringify({ id: uid, first_name:'Новый' }) };
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

const UID = 980001;
await sb.from('memberships').delete().eq('subject', `tg:${UID}`);
await sb.from('app_users').delete().eq('subject', `tg:${UID}`);
const doc = as(UID);

console.log('── Незнакомый человек ──');
const fresh = await doc('/me');
ok(fresh.body.needsChoice === true, 'спрашиваем, кто он');
const tpls = await doc('/onboarding/templates');
ok((tpls.body.templates ?? []).length > 0, 'справочники предлагаются', (tpls.body.templates ?? []).map((t:any)=>t.name_ru).join(', '));

console.log('\n── Регистрация ──');
const t0 = Date.now();
const reg = await doc('/onboarding/register', { method:'POST',
  body: JSON.stringify({ name: 'Кабинет Нового Врача', doctorName: 'Каримов А.А.', template: 'therapist' }) });
ok(reg.status === 200, 'кабинет создан', `${Math.round((Date.now()-t0)/100)/10} с`);
ok(reg.body.demo === true, 'демо-данные наполнены', String(reg.body.demoError ?? ''));
const tid = reg.body.tenantId as string;

const me = await doc('/me');
ok(me.body.mode === 'doctor' && me.body.cabinet === 'Кабинет Нового Врача', 'врач сразу в своём кабинете');
ok(me.body.onboarding?.active === true, 'знакомство включено');
ok(me.body.catalogReviewed === false, 'справочник ещё не сверен');

console.log('\n── Кабинет живой, а не пустой ──');
const cal = await doc('/doctor/calendar?from=' + new Date(Date.now()-14*864e5).toISOString().slice(0,10) + '&to=' + new Date(Date.now()+7*864e5).toISOString().slice(0,10));
ok((cal.body.appointments ?? []).length > 10, 'календарь наполнен', `${(cal.body.appointments ?? []).length} записей`);
const margin = await doc('/doctor/reports/margin');
ok((margin.body.rows ?? []).length > 0, 'отчёт по марже считается',
  `сверх материалов ${Math.round(margin.body.totals?.margin ?? 0).toLocaleString('ru-RU')} сум`);
ok(Number(margin.body.totals?.cost) > 0, 'себестоимость не нулевая — приёмы реально закрыты');
const health = await doc('/doctor/stock/health');
ok(health.body.reconcileMismatches === 0, 'остатки сходятся с журналом');
const { count: closed } = await sb.from('visits').select('*', { count:'exact', head:true }).eq('tenant_id', tid).eq('status','closed');
ok((closed ?? 0) > 5, 'демо-приёмы закрыты настоящим распределителем', `${closed} закрытых`);

console.log('\n── Знакомство ──');
// Раньше здесь просто постились шесть отметок. Проверялась бухгалтерия, а не
// то, что врач вообще МОЖЕТ дойти до этих экранов, — и знакомство,
// не открывавшее ни одного раздела, спокойно прошло эту проверку.
// Теперь идём тем же путём, которым ведёт кнопка шага.
const today = new Date().toISOString().slice(0, 10);
const step: Record<string, () => Promise<number>> = {
  calendar: async () => (await doc(`/doctor/calendar?from=${today}&to=${today}`)).status,
  stock: async () => (await doc('/doctor/stock')).status,
  margin: async () => (await doc('/doctor/reports/margin')).status,
  link: async () => (await doc('/doctor/link')).status,
  techcards: async () => (await doc('/doctor/services')).status,
  // Самый длинный путь: приёмы лежат внутри карточки пациента, и шаг
  // «Приём» обязан довести до конкретного закрытого приёма сам.
  visit: async () => {
    const { body: list } = await doc('/doctor/patients');
    const who = (list.patients ?? []).find((x: any) => x.visits > 0);
    if (!who) return 0;
    const { body: card } = await doc(`/doctor/patients/${who.id}`);
    const v = (card.visits ?? []).find((x: any) => x.status === 'closed') ?? (card.visits ?? [])[0];
    if (!v) return 0;
    return (await doc(`/doctor/visits/${v.id}`)).status;
  },
};
for (const scr of ['calendar','visit','stock','techcards','margin','link']) {
  const code = await step[scr]!();
  ok(code === 200, `шаг «${scr}» открывается`, `${code}`);
  await doc('/onboarding/seen', { method:'POST', body: JSON.stringify({ screen: scr }) });
}
const seen = await doc('/me');
ok((seen.body.onboarding?.seen ?? []).length === 6, 'пройденные экраны отмечены',
  `${(seen.body.onboarding?.seen ?? []).length} из 6`);
const bogus = await doc('/onboarding/seen', { method:'POST', body: JSON.stringify({ screen: 'выдумка' }) });
ok((bogus.body.onboarding?.seen ?? []).length === 6, 'выдуманный экран не засчитывается');

console.log('\n── Очистка выдуманного ──');
// Сколько услуг в справочнике — берём до завершения, а не числом в тесте:
// справочник пополняется (профилактический осмотр приехал миграцией 082),
// и зашитая восьмёрка ловила не поломку, а собственное устаревание.
const beforeSvc = ((await doc('/doctor/services')).body.services ?? []).length;
const fin = await doc('/onboarding/finish', { method:'POST' });
ok(fin.status === 200, 'обучение завершено',
  `стёрто ${fin.body.wiped.visits} приёмов, ${fin.body.wiped.patients} пациентов`);

const afterStock = await doc('/doctor/stock');
ok(afterStock.body.summary.total === 53, 'СПРАВОЧНИК ОСТАЛСЯ', `${afterStock.body.summary.total} материалов`);
ok(afterStock.body.summary.outOfStock === 53, 'партии стёрты — склад пуст');
const afterSvc = await doc('/doctor/services');
ok((afterSvc.body.services ?? []).length === beforeSvc,
  'услуги и техкарты остались', `${beforeSvc} услуг`);
const afterCal = await doc('/doctor/calendar?from=' + new Date(Date.now()-14*864e5).toISOString().slice(0,10) + '&to=' + new Date(Date.now()+7*864e5).toISOString().slice(0,10));
ok((afterCal.body.appointments ?? []).length === 0, 'выдуманные записи стёрты');
const { count: pLeft } = await sb.from('patients').select('*', { count:'exact', head:true }).eq('tenant_id', tid);
ok((pLeft ?? 0) === 0, 'выдуманные пациенты стёрты');
const { count: mvLeft } = await sb.from('stock_movements').select('*', { count:'exact', head:true }).eq('tenant_id', tid);
ok((mvLeft ?? 0) === 0, 'движения склада стёрты');
const done = await doc('/me');
ok(done.body.onboarding?.active === false, 'знакомство выключено');

await doc('/onboarding/reviewed', { method:'POST' });
ok((await doc('/me')).body.catalogReviewed === true, 'отметка о сверке справочника ставится');

console.log('\n── Уборка ──');
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён', del.error?.message ?? '');
await sb.from('app_users').delete().eq('subject', `tg:${UID}`);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Путь врача с нуля работает.'}`);
if (problems.length) process.exit(1);
