/** Подписка: пробный период, заморозка, продление, идемпотентность. */
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
const problems: string[] = [];
const ok = (c: boolean, l: string, d='') => { console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c) problems.push(l); };

const DOC = 990001, PAT = 990002;
await sb.from('memberships').delete().eq('subject', `tg:${DOC}`);
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`]);
const doc = as(DOC);

console.log('── Пробный период ──');
const reg = await doc('/onboarding/register', { method:'POST',
  body: JSON.stringify({ name: 'Кабинет Подписки', template: 'therapist' }) });
ok(reg.status === 200, 'кабинет создан');
const tid = reg.body.tenantId as string;
const bill = await doc('/billing');
ok(bill.body.subscription.status === 'trial', 'пробный период включён');
ok(bill.body.subscription.daysLeft >= 13, 'даётся 14 дней', `${bill.body.subscription.daysLeft} дн.`);
ok((bill.body.plans ?? []).length === 3, 'планы предлагаются',
  (bill.body.plans ?? []).map((p:any)=>`${p.name_ru} ${p.price_uzs}`).join(', '));
ok((await doc('/doctor/calendar')).status === 200, 'кабинет работает');

console.log('\n── Заморозка ──');
await sb.from('subscriptions').update({ paid_until: new Date(Date.now() - 864e5).toISOString() }).eq('tenant_id', tid);
const frozen = await doc('/doctor/calendar');
ok(frozen.status === 402 && frozen.body.frozen === true, 'календарь закрыт', String(frozen.body.error));
ok((await doc('/doctor/stock')).status === 402, 'склад закрыт');
ok((await doc('/doctor/reports/margin')).status === 402, 'отчёты закрыты');
ok((await doc('/billing')).status === 200, 'страница подписки ОСТАЁТСЯ доступной — иначе не оплатить');

const link = (await sb.from('tenants').select('public_token').eq('id', tid).single()).data!.public_token;
await sb.from('tenants').update({ contact_phone: '+998901234567' }).eq('id', tid);
const pat = as(PAT, link);
const paused = await pat('/book/info');
ok(paused.status === 503 && paused.body.paused === true, 'пациент видит паузу, а не долг', String(paused.body.error));
ok(paused.body.phone === '+998901234567', 'пациенту дан телефон кабинета', String(paused.body.phone));

console.log('\n── Записи пациентов не страдают ──');
const { count: apptsLeft } = await sb.from('appointments').select('*', { count:'exact', head:true })
  .eq('tenant_id', tid).eq('status', 'scheduled');
ok((apptsLeft ?? 0) > 0, 'назначенные записи не отменены', `${apptsLeft} записей`);
const { data: due } = await sb.rpc('due_reminders', {});
ok(Array.isArray(due), 'механизм напоминаний по ним продолжает работать');

console.log('\n── Продление ──');
const paid = await sb.rpc('credit_subscription', {
  p_tenant_id: tid, p_months: 1, p_provider: 'telegram_stars',
  p_external_id: 'charge_test_1', p_amount: 1000, p_currency: 'XTR',
  p_paid_by: `tg:${DOC}`, p_plan_code: 'monthly' });
ok((paid.data as any)?.credited === true, 'оплата зачтена');
ok((await doc('/doctor/calendar')).status === 200, 'кабинет открылся');
const again = await sb.rpc('credit_subscription', {
  p_tenant_id: tid, p_months: 1, p_provider: 'telegram_stars',
  p_external_id: 'charge_test_1', p_amount: 1000, p_currency: 'XTR',
  p_paid_by: `tg:${DOC}`, p_plan_code: 'monthly' });
ok((again.data as any)?.credited === false, 'повтор вебхука не продлевает дважды',
  String((again.data as any)?.reason));

console.log('\n── Предупреждения ──');
await sb.from('subscriptions').update({
  paid_until: new Date(Date.now() + 2 * 864e5).toISOString(), notified_stage: null }).eq('tenant_id', tid);
const { data: notices } = await sb.rpc('due_subscription_notices', {});
const mine = ((notices ?? []) as any[]).find((n) => n.tenant_id === tid);
ok(mine?.stage === 'd3', 'за три дня готовится предупреждение', String(mine?.stage));
await sb.rpc('mark_subscription_notified', { p_tenant_id: tid, p_stage: 'd3' });
const { data: again2 } = await sb.rpc('due_subscription_notices', {});
ok(!((again2 ?? []) as any[]).some((n) => n.tenant_id === tid),
  'повторно то же предупреждение не шлётся');

console.log('\n── Уборка ──');
await sb.from('subscription_payments').delete().eq('tenant_id', tid);
const del = await sb.rpc('delete_tenant', { p_tenant_id: tid });
ok(!del.error, 'кабинет удалён', del.error?.message ?? '');
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'Подписка работает.'}`);
if (problems.length) process.exit(1);
