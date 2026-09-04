/** Готовит кабинет для обхода интерфейса и печатает подписанный initData. */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => { for (const l of readFileSync(DEV,'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length+1).trim(); throw new Error(k); };
const token = env('TELEGRAM_BOT_TOKEN');
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const sign = (uid: number, name: string) => {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender',
    user: JSON.stringify({ id: uid, first_name: name }) };
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
};
const DOC = 992001, PAT = 992002;
const call = (uid: number) => async (p: string, init: RequestInit = {}) => {
  const r = await fetch(`http://localhost:8787/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': sign(uid,'QA'), ...(init.headers??{}) } });
  return { status: r.status, body: await r.json().catch(()=>({})) as any };
};
// Кабинет прошлого обхода удаляем целиком, а не только членство: осиротевший
// кабинет остаётся в поиске и роняет предполётную проверку «проверочных
// аккаунтов не осталось». Один раз уже уронил.
const { data: old_ } = await sb.from('memberships').select('tenant_id').eq('subject', `tg:${DOC}`);
for (const m of old_ ?? []) await sb.rpc('delete_tenant', { p_tenant_id: m.tenant_id });
await sb.from('memberships').delete().eq('subject', `tg:${DOC}`);
await sb.from('app_users').delete().in('subject', [`tg:${DOC}`, `tg:${PAT}`]);

const doc = call(DOC);
const reg = await doc('/onboarding/register', { method:'POST', body: JSON.stringify({ name:'Кабинет Обхода', doctorName:'Каримов А.А.', template:'therapist' }) });
if (reg.status !== 200) { console.error('регистрация:', reg.body); process.exit(1); }
const tid = reg.body.tenantId as string;
await doc('/doctor/listing', { method:'PUT', body: JSON.stringify({ city:'Ташкент', address:'ул. Амира Темура, 12', landmark:'напротив Чорсу', phone:'+998901112233', listed:true }) });

// Пациент с записью, чтобы было что смотреть на пациентских экранах.
await sb.rpc('set_verified_phone', { p_subject: `tg:${PAT}`, p_phone: '+998900992002' });
const link = (await sb.from('tenants').select('public_token').eq('id', tid).single()).data!.public_token;
const patCall = async (p: string, init: RequestInit = {}) => {
  const f: Record<string,string> = { auth_date: String(Math.floor(Date.now()/1000)), chat_instance:'-1', chat_type:'sender',
    user: JSON.stringify({ id: PAT, first_name: 'Пациент' }), start_param: link };
  const dcs = Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
  const sec = createHmac('sha256','WebAppData').update(token).digest();
  f.hash = createHmac('sha256',sec).update(dcs).digest('hex');
  const r = await fetch(`http://localhost:8787/api${p}`, { ...init, headers:{ 'Content-Type':'application/json','X-Telegram-Init-Data': new URLSearchParams(f).toString(), ...(init.headers??{}) } });
  return { status: r.status, body: await r.json().catch(()=>({})) as any };
};
const info = await patCall('/book/info');
const svc = (info.body.services ?? [])[0];
const slots = await patCall(`/book/slots?serviceId=${svc.id}&days=21`);
const booked = await patCall('/book', { method:'POST', body: JSON.stringify({ serviceId: svc.id, startsAt: slots.body.days[0].times[0], name:'Пациент Обхода' }) });
// Закрытый приём, чтобы «Моя карта» не была пустой на обходе: записи в ней
// появляются только при закрытии приёма.
const started = await doc(`/doctor/appointments/${booked.body.appointmentId}/start`, { method:'POST' });
await doc(`/doctor/visits/${started.body.visitId}/close`, { method:'POST' });
// И ещё одна запись впереди — иначе карта пациента закрыта для врача и
// кнопку «Открыть карту» на обходе не увидеть.
const slots2 = await patCall(`/book/slots?serviceId=${svc.id}&days=21`);
await patCall('/book', { method:'POST', body: JSON.stringify({ serviceId: svc.id, startsAt: slots2.body.days[0].times[0], name:'Пациент Обхода' }) });

// План лечения, чтобы было что смотреть.
const svcs = (await doc('/doctor/services?withCost=1')).body.services;
await doc('/doctor/plans', { method:'POST', body: JSON.stringify({ patientId: booked.body.patientId, title:'Лечение 26 зуба', status:'active',
  items: [{ serviceId: svcs[0].id, tooth:'26', stage:1 }, { serviceId: svcs[1].id, tooth:'26', quantity:2, stage:2 }] }) });

writeFileSync(new URL('../../../.qa.json', import.meta.url).pathname, JSON.stringify({
  tenantId: tid, doctor: sign(DOC,'Каримов'), patient: sign(PAT,'Пациент'), patientLink: link,
}, null, 2));
console.log('кабинет:', tid);
console.log('врач и пациент готовы, подписи в .qa.json');
