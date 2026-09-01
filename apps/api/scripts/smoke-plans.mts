/** План лечения, себестоимость наперёд и деньги: полный путь до боевого воркера. */
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
const sum = (n: any) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n)));

const DOC = 990301, PAT = 990302, OTHER = 990303;
await sb.from('memberships').delete().in('subject', [`tg:${DOC}`, `tg:${OTHER}`]);
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`, `tg:${OTHER}`]);
const doc = as(DOC);

console.log('── Подготовка ──');
const reg = await doc('/onboarding/register', { method:'POST',
  body: JSON.stringify({ name: 'Кабинет Планов', template: 'therapist' }) });
ok(reg.status === 200, 'кабинет создан', String(reg.body.error ?? ''));
const tid = reg.body.tenantId as string;
await doc('/onboarding/finish', { method: 'POST' }).catch(() => {});

const link = (await sb.from('tenants').select('public_token').eq('id', tid).single()).data!.public_token;
const pat = as(PAT, link);
await sb.rpc('set_verified_phone', { p_subject: `tg:${PAT}`, p_phone: '+998900990302' });

const info = await pat('/book/info');
const svc = (info.body.services ?? []).find((s: any) => !s.consultation) ?? info.body.services[0];
const slots = await pat(`/book/slots?serviceId=${svc.id}&days=21`);
const booked = await pat('/book', { method:'POST', body: JSON.stringify({
  serviceId: svc.id, startsAt: slots.body.days[0].times[0], name: 'Пациент Планов' }) });
ok(booked.status === 200, 'пациент записан', String(booked.body.error ?? ''));
const patientId = booked.body.patientId as string;

console.log('\n── Себестоимость наперёд ──');
const withCost = await doc('/doctor/services?withCost=1');
const s1 = withCost.body.services.find((x: any) => x.id === svc.id);
ok(s1.costBase > 0 || s1.costPerUnit > 0, 'у услуги посчитаны материалы',
  `постоянная ${sum(s1.costBase)}, на единицу ${sum(s1.costPerUnit)}`);
ok(s1.unpricedLines === 0, 'все материалы техкарты с ценой');
const plain = await doc('/doctor/services');
ok(plain.body.services[0].costBase === undefined,
  'без запроса себестоимость не считается — список услуг открывается и при наборе приёма');

console.log('\n── Врач собирает план ──');
const second = withCost.body.services.find((x: any) => x.id !== svc.id && Number(x.price) > 0);
const made = await doc('/doctor/plans', { method:'POST', body: JSON.stringify({
  patientId, title: 'Лечение 26 зуба', status: 'draft',
  items: [
    { serviceId: svc.id, tooth: '26', quantity: 1, stage: 1 },
    { serviceId: second.id, tooth: '26', quantity: 2, stage: 2 },
  ] }) });
ok(made.status === 200, 'план сохранён', String(made.body.error ?? ''));
const planId = made.body.planId as string;
ok(made.body.activated === false, 'черновик пациенту НЕ отправлен');

const plan = await doc(`/doctor/plans/${planId}`);
const t = plan.body.totals;
ok(Number(t.stages) === 2, 'этапов два');
const expected = (s1.costBase + s1.costPerUnit) + (second.costBase + second.costPerUnit * 2);
ok(Math.abs(Number(t.cost) - expected) < 0.5,
  'себестоимость плана = сумма по техкартам с учётом кратности',
  `${sum(t.cost)} против ${sum(expected)}`);
ok(Number(t.revenue) - Number(t.cost) === Number(t.margin), 'маржа сходится',
  `${sum(t.revenue)} − ${sum(t.cost)} = ${sum(t.margin)}`);
ok(Number(t.doneRevenue) === 0, 'выполненного пока нет');

console.log('\n── Пациент видит только то, что ему показали ──');
ok((await pat('/me/plans')).body.plans.length === 0, 'черновик пациенту не виден');
const shown = await doc('/doctor/plans', { method:'POST', body: JSON.stringify({
  planId, title: 'Лечение 26 зуба', status: 'active',
  items: plan.body.items.map((i: any) => ({ serviceId: i.serviceId, tooth: i.tooth,
    quantity: i.quantity, price: Number(i.price), stage: i.stage })) }) });
ok(shown.body.activated === true, 'план показан пациенту — уведомление уходит один раз');
const again = await doc('/doctor/plans', { method:'POST', body: JSON.stringify({
  planId, title: 'Лечение 26 зуба', status: 'active',
  items: plan.body.items.map((i: any) => ({ serviceId: i.serviceId, tooth: i.tooth,
    quantity: i.quantity, price: Number(i.price), stage: i.stage })) }) });
ok(again.body.activated === false, 'повторное сохранение второго уведомления не шлёт');

const mine = await pat('/me/plans');
ok(mine.body.plans.length === 1, 'пациент видит свой план');
ok(JSON.stringify(mine.body).search(/cost|margin|себестоим/i) === -1,
  'СЕБЕСТОИМОСТИ в выдаче пациента нет ни в каком виде');
ok(mine.body.plans[0].stages.length === 2, 'этапы видны пациенту');

console.log('\n── Чужой кабинет ──');
const other = as(OTHER);
const reg2 = await other('/onboarding/register', { method:'POST',
  body: JSON.stringify({ name: 'Чужой Кабинет', template: 'therapist' }) });
const tid2 = reg2.body.tenantId as string;
const stolen = await other(`/doctor/plans/${planId}`);
ok(stolen.status === 404, 'чужой врач не открывает план', `${stolen.status}`);
const stolenPay = await other(`/doctor/patients/${patientId}/payments`, {
  method:'POST', body: JSON.stringify({ amount: 1 }) });
ok(stolenPay.status === 400 || stolenPay.status === 404,
  'чужой врач не проводит платёж чужому пациенту', String(stolenPay.body.error ?? stolenPay.status));

console.log('\n── Приём закрывает пункт плана сам ──');
const started = await doc(`/doctor/appointments/${booked.body.appointmentId}/start`, { method:'POST' });
ok(started.status === 200, 'приём начат');
const closed = await doc(`/doctor/visits/${started.body.visitId}/close`, { method:'POST' });
ok(closed.status === 200, 'приём закрыт', String(closed.body.error ?? ''));

const after = await doc(`/doctor/plans/${planId}`);
ok(after.body.items.filter((i: any) => i.status === 'done').length === 1,
  'ровно один пункт плана закрылся');
ok(after.body.items.find((i: any) => i.status === 'done').serviceId === svc.id,
  'закрылся тот пункт, услугу которого оказали');
ok(Number(after.body.totals.doneRevenue) === Number(svc.price),
  'выполненная часть сошлась', sum(after.body.totals.doneRevenue));

console.log('\n── Деньги ──');
const money1 = await doc(`/doctor/patients/${patientId}/plans`);
ok(Number(money1.body.balance.debt) === Number(svc.price),
  'долг появился после закрытия приёма', sum(money1.body.balance.debt));
const half = Math.round(Number(svc.price) / 2);
const paid = await doc(`/doctor/patients/${patientId}/payments`, { method:'POST',
  body: JSON.stringify({ amount: half, method: 'cash', note: 'аванс' }) });
ok(Number(paid.body.balance.debt) === Number(svc.price) - half,
  'частичная оплата уменьшила долг', sum(paid.body.balance.debt));
const bad = await doc(`/doctor/patients/${patientId}/payments`, { method:'POST',
  body: JSON.stringify({ amount: 0 }) });
ok(bad.status === 400, 'нулевой платёж отклонён', String(bad.body.error ?? ''));
ok(Number((await pat('/me/plans')).body.plans[0].balance.debt) === Number(svc.price) - half,
  'пациент видит тот же долг');

console.log('\n── Правка и удаление ──');
const del = await doc(`/doctor/plans/${planId}`, { method:'DELETE' });
ok(del.status === 400, 'план с выполненной работой удалить нельзя', String(del.body.error ?? ''));
const edited = await doc('/doctor/plans', { method:'POST', body: JSON.stringify({
  planId, title: 'Лечение 26 зуба', status: 'active',
  items: [{ serviceId: second.id, tooth: '27', quantity: 1, stage: 2 }] }) });
ok(edited.status === 200, 'состав переписан');
const afterEdit = await doc(`/doctor/plans/${planId}`);
ok(afterEdit.body.items.filter((i: any) => i.status === 'done').length === 1,
  'выполненное правка не тронула');
const badTooth = await doc('/doctor/plans', { method:'POST', body: JSON.stringify({
  patientId, title: 'Мимо', status: 'draft',
  items: [{ serviceId: svc.id, tooth: '99', stage: 1 }] }) });
ok(badTooth.status === 400, 'зуб «99» не принят — такого по FDI нет', String(badTooth.body.error ?? ''));

console.log('\n── Уборка ──');
for (const id of [tid, tid2]) {
  const d = await sb.rpc('delete_tenant', { p_tenant_id: id });
  ok(!d.error, `кабинет ${id === tid ? 'основной' : 'чужой'} удалён`, d.error?.message ?? '');
}
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`, `tg:${OTHER}`]);
console.log(`\n${problems.length ? `НЕ ПРОШЛО: ${problems.join('; ')}` : 'План лечения и деньги работают.'}`);
if (problems.length) process.exit(1);
