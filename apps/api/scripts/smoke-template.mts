/** Кабинет из шаблона должен не «выглядеть похоже», а СЧИТАТЬ себестоимость. */
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

const UID = 970002;
await sb.from('memberships').delete().eq('subject', `tg:${UID}`);
await sb.from('app_users').delete().eq('subject', `tg:${UID}`);

console.log('── Кабинет создаётся из шаблона ──');
const { data: prov, error } = await sb.rpc('provision_tenant', {
  p_subject: `tg:${UID}`, p_name: 'Кабинет Проверки', p_template_code: 'therapist', p_doctor_name: 'Петров П.П.' });
ok(!error, 'кабинет создан', error ? error.message : (prov as any).name);
if (error) process.exit(1);
const tid = (prov as any).tenantId as string;

const doc = as(UID);
const me = await doc('/me');
ok(me.body.mode === 'doctor' && me.body.cabinet === 'Кабинет Проверки', 'врач сразу внутри своего кабинета');
ok(/^d_[A-Za-z0-9_-]{20,}$/.test((prov as any).publicToken), 'ссылка для пациентов длинная и URL-безопасная');

const stock = await doc('/doctor/stock');
ok(stock.body.summary.total === 53, 'склад наполнен справочником', `${stock.body.summary.total} материалов`);
ok(stock.body.summary.needsPrice === 0, 'у всех материалов есть цена');
ok(stock.body.summary.outOfStock === 53, 'остатков пока нет — так и должно быть у нового кабинета');

console.log('\n── Приход и приём ──');
for (const m of stock.body.materials as any[]) {
  await doc(`/doctor/stock/${m.id}/receive`, { method:'POST',
    body: JSON.stringify({ qty: 100, totalPrice: (m.referencePrice ?? 1000) * 100, expiresAt: null }) });
}
const after = await doc('/doctor/stock');
ok(after.body.summary.outOfStock === 0, 'приход прошёл по всем материалам');

const { services } = (await doc('/doctor/services')).body;
const svc = services.find((s: any) => String(s.name_ru).includes('Пломба фотополимером II/III')) ?? services[0];
const wi = await doc('/doctor/walk-in', { method:'POST', body: JSON.stringify({ name:'Пациент Проверки', serviceId: svc.id }) });
ok(wi.status === 200, 'приём начат', String(wi.body.visitId ?? wi.body.error));

const closed = await doc(`/doctor/visits/${wi.body.visitId}/close`, { method:'POST' });
ok(closed.status === 200, 'приём закрыт', String(closed.body.error ?? `${closed.body.consumptions} списаний`));
ok(Number(closed.body.materialsTotal) > 0, 'себестоимость посчиталась, а не вышла нулём',
  `${Math.round(Number(closed.body.materialsTotal)).toLocaleString('ru-RU')} сум`);
ok(closed.body.shortfalls === 0, 'недостач нет — техкарта сошлась со складом');

const bd = await doc(`/doctor/visits/${wi.body.visitId}/cost-breakdown`);
ok(bd.body.reconciles === true, 'раскладка сходится со снимком до копейки');
ok((bd.body.lines ?? []).length > 10, 'в раскладке видны позиции', `${(bd.body.lines ?? []).length}`);
ok((bd.body.lines ?? []).every((l: any) => !l.unpriced), 'позиций без цены нет');
const health = await doc('/doctor/stock/health');
ok(health.body.reconcileMismatches === 0, 'остатки сходятся с журналом движений');

console.log('\n── Второй кабинет тому же человеку ──');
const dup = await sb.rpc('provision_tenant', { p_subject: `tg:${UID}`, p_name: 'Ещё один', p_template_code: 'therapist' });
ok(Boolean(dup.error), 'второй кабинет одному владельцу не создаётся', dup.error?.message ?? 'СОЗДАЛСЯ');

console.log('\n── Уборка ──');
// Порядок удаления диктуют внешние ключи, а не здравый смысл: услуги держат
// версии техкарт, блоки держат материалы. Поштучное удаление тихо не
// срабатывало и оставляло кабинет-призрак — поэтому одна функция на всё.
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён целиком', del.error?.message ?? String((del.data as any)?.deleted));
await sb.from('app_users').delete().eq('subject', `tg:${UID}`);
const { count: left } = await sb.from('materials').select('*', { count:'exact', head:true }).eq('tenant_id', tid);
ok((left ?? 0) === 0, 'следов кабинета не осталось');
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Кабинет из шаблона работает.'}`);
if (problems.length) process.exit(1);
