/**
 * Справочники всех специализаций: каждый должен доехать до кабинета целиком
 * и посчитать себестоимость флагманской услуги без «неизвестной цены».
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} });
const initData = (uid: number) => {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender', user: JSON.stringify({ id: uid, first_name:'T' }) };
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
};
const as = (uid: number) => async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': initData(uid), ...(init.headers??{}) } });
  return { status: r.status, body: (await r.json().catch(()=>({}))) as any };
};
const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };
const money = (n: number) => new Intl.NumberFormat('ru-RU').format(Math.round(n));

// Флагманская услуга каждого справочника: на ней и проверяем расчёт.
const ГЛАВНОЕ: Record<string, string> = {
  therapist:    'A16.07.002.011',
  surgeon:      'A16.07.054',
  orthopedist:  'A16.07.004.002',
  orthodontist: 'A16.07.048',
  pediatric:    'A16.07.057',
  periodontist: 'A16.07.038',
};

let uid = 997000;
for (const [tpl, главный] of Object.entries(ГЛАВНОЕ)) {
  uid += 1;
  const doc = as(uid);
  const { data: old_ } = await sb.from('memberships').select('tenant_id').eq('subject', `tg:${uid}`);
  for (const m of old_ ?? []) await sb.rpc('delete_tenant', { p_tenant_id: m.tenant_id });
  await sb.from('app_users').delete().eq('subject', `tg:${uid}`);

  console.log(`\n── ${tpl} ──`);
  const reg = await doc('/onboarding/register', { method:'POST', body: JSON.stringify({
    name: `Кабинет ${tpl}`, template: tpl, doctorName: 'Проверкин П.П.' }) });
  const tid = reg.body.tenantId as string;
  ok(reg.status === 200, 'кабинет создан', String(reg.body.error ?? ''));
  if (!tid) continue;

  const { count: svcN } = await sb.from('services').select('*', { count:'exact', head:true }).eq('tenant_id', tid);
  const { count: matN } = await sb.from('materials').select('*', { count:'exact', head:true }).eq('tenant_id', tid);
  ok((svcN ?? 0) >= 6 && (matN ?? 0) >= 30, 'услуги и материалы доехали', `${svcN} услуг, ${matN} материалов`);

  // Каждая услуга должна иметь техкарту, иначе приём закроется «без цены».
  const { data: noTc } = await sb.from('services').select('name_ru')
    .eq('tenant_id', tid).is('techcard_version_id', null);
  ok((noTc ?? []).length === 0, 'у каждой услуги есть техкарта',
    (noTc ?? []).map((x: any) => x.name_ru).join(', '));

  // Себестоимость флагманской услуги: считаем тем же путём, что и на приёме.
  const { data: svc } = await sb.from('services').select('id, name_ru, price')
    .eq('tenant_id', tid).eq('code', главный).maybeSingle();
  ok(!!svc, `флагманская услуга ${главный} на месте`, String(svc?.name_ru ?? ''));
  if (!svc) continue;

  const tc = await doc(`/doctor/techcard/${svc.id}`);
  const своих = (tc.body.lines ?? []).length;
  const блоков = (tc.body.blocks ?? []).length;
  ok(tc.status === 200 && (своих + блоков) > 0, 'техкарта не пустая',
    `${своих} своих строк, ${блоков} блоков`);
  const безЦены = (tc.body.materials ?? []).filter((m: any) => m.reference_price == null);
  ok(безЦены.length === 0, 'у всех материалов кабинета есть цена',
    безЦены.map((m: any) => m.name_ru).slice(0, 3).join(', '));

  // Считает ли распределитель. Себестоимость берётся из партий на складе, а
  // не из справочной цены: демо-приёмы закрываются тем же расчётом, что и
  // настоящие, и врач в первый же день видит не ноль.
  const { data: snap } = await sb.from('visit_costs')
    .select('materials_total, has_unpriced, unpriced_lines_count')
    .eq('tenant_id', tid).is('superseded_at', null);
  const снимков = (snap ?? []).length;
  const сУнпрайс = (snap ?? []).filter((x: any) => x.has_unpriced).length;
  const сумма = (snap ?? []).reduce((s: number, x: any) => s + Number(x.materials_total ?? 0), 0);
  ok(снимков > 0, 'себестоимость демо-приёмов посчитана', `${снимков} приёмов`);
  ok(сУнпрайс === 0, 'ни одного приёма с неизвестной ценой материала',
    `${сУнпрайс} из ${снимков}`);
  ok(сумма > 0, 'материалы списаны и оценены', `${money(сумма)} сум за всё демо`);

  // Отчёт «сверх материалов» — то, ради чего продукт и берут: он должен
  // показывать положительную разницу, а не убыток из выдуманных норм.
  const margin = await doc('/doctor/reports/margin');
  const t = margin.body.totals ?? {};
  ok(margin.status === 200 && Number(t.revenue ?? 0) > 0,
    'отчёт «сверх материалов» считается', `выручка ${money(Number(t.revenue ?? 0))}`);
  ok(Number(t.margin ?? 0) > 0 && Number(t.cost ?? 0) < Number(t.revenue ?? 0),
    'материалы дешевле выручки, а не наоборот',
    `материалы ${money(Number(t.cost ?? 0))} при выручке ${money(Number(t.revenue ?? 0))} (${
      Math.round(Number(t.cost ?? 0) / Math.max(1, Number(t.revenue ?? 0)) * 100)}%)`);

  await sb.rpc('delete_tenant', { p_tenant_id: tid });
  await sb.from('app_users').delete().eq('subject', `tg:${uid}`);
}

console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Справочники всех специализаций работают.'}`);
if (problems.length) process.exit(1);
