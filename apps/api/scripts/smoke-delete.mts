/** Удаление кабинета: право, объём и то, что после него остаётся. */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const BASE = process.env.WORKER_URL ?? 'https://stomiko-api.alrevion.workers.dev';
const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env=(k:string)=>{for(const l of readFileSync(DEV,'utf8').split('\n'))if(l.trim().startsWith(`${k}=`))return l.trim().slice(k.length+1).trim();throw new Error(k)};
const token=env('TELEGRAM_BOT_TOKEN');
const sb=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
function initData(uid:number,sp?:string){const f:Record<string,string>={auth_date:String(Math.floor(Date.now()/1000)),chat_instance:'-1',chat_type:'sender',user:JSON.stringify({id:uid,first_name:'T'})};
if(sp)f.start_param=sp;const dcs=Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join('\n');
const sec=createHmac('sha256','WebAppData').update(token).digest();f.hash=createHmac('sha256',sec).update(dcs).digest('hex');return new URLSearchParams(f).toString()}
const as=(uid:number,sp?:string)=>async(p:string,init:RequestInit={})=>{const r=await fetch(`${BASE}/api${p}`,{...init,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':initData(uid,sp),...(init.headers??{})}});return{status:r.status,body:await r.json().catch(()=>({})) as any}};
const problems:string[]=[]; const ok=(c:boolean,l:string,d='')=>{console.log(`  ${c?'✓':'✗'} ${l}${d?` — ${d}`:''}`); if(!c)problems.push(l)};

const OWNER=990601, STAFF=990602, OUTSIDER=990603;
await sb.from('memberships').delete().in('subject',[`tg:${OWNER}`,`tg:${STAFF}`,`tg:${OUTSIDER}`]);
await sb.from('app_users').delete().in('subject',[`tg:${OWNER}`,`tg:${STAFF}`,`tg:${OUTSIDER}`]);
const owner=as(OWNER);

console.log('── Подготовка ──');
const reg=await owner('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Кабинет Удаления',template:'therapist'})});
const tid=reg.body.tenantId as string;
ok(reg.status===200,'кабинет создан');
const scale=await owner('/doctor/cabinet/scale');
ok(scale.status===200,'объём удаления посчитан',
  `${scale.body.patients} пациентов, ${scale.body.visits} приёмов, ${scale.body.materials} материалов`);
ok(scale.body.role==='owner','владелец опознан');
ok(Number(scale.body.patients)>0,'демо-данные попали в счёт — человеку есть что терять');

console.log('\n── Право ──');
const inv=await owner('/doctor/invite',{method:'POST'});
const staff=as(STAFF, inv.body.token ?? inv.body.code);
await staff('/me');
const staffScale=await staff('/doctor/cabinet/scale');
ok(staffScale.body.role!=='owner','сотрудник не считается владельцем', String(staffScale.body.role));
const staffKill=await staff('/doctor/cabinet',{method:'DELETE'});
ok(staffKill.status===400,'сотрудник кабинет НЕ удаляет', String(staffKill.body.error ?? staffKill.status));
const ownerLeave=await owner('/doctor/cabinet/leave',{method:'POST'});
ok(ownerLeave.status===400,'владелец не может «выйти» — кабинет не остаётся без хозяина',
  String(ownerLeave.body.error ?? ''));
const left=await staff('/doctor/cabinet/leave',{method:'POST'});
ok(left.status===200,'сотрудник выходит', String(left.body.error ?? ''));
// Вышедший открывает приложение уже БЕЗ ссылки-приглашения: она одноразовая
// и погашена. Проверяем оба пути — по старой ссылке и обычным входом.
const withOldLink = await staff('/doctor/calendar');
ok(withOldLink.status !== 200, 'по погашенной ссылке кабинет не открывается', `${withOldLink.status}`);
const plain = as(STAFF);
const back = await plain('/me');
ok(back.status === 200 && !back.body.tenantId,
  'вышедший входит как пациент, а не в ошибку', JSON.stringify({mode:back.body.mode,tenantId:back.body.tenantId}));
ok((await plain('/doctor/calendar')).status === 403, 'врачебные маршруты ему закрыты');
const { count: alive } = await sb.from('patients').select('*',{count:'exact',head:true}).eq('tenant_id',tid);
ok((alive??0)>0,'выход сотрудника НЕ тронул данные кабинета', `${alive} пациентов на месте`);

console.log('\n── Удаление ──');
const kill=await owner('/doctor/cabinet',{method:'DELETE'});
ok(kill.status===200,'владелец удалил кабинет', String(kill.body.error ?? kill.body.deleted));
const { data: gone } = await sb.from('tenants').select('id').eq('id',tid).maybeSingle();
ok(!gone,'кабинета в базе нет');
for (const t of ['patients','appointments','visits','treatment_plans','payments','materials'] as const) {
  const { count } = await sb.from(t).select('*',{count:'exact',head:true}).eq('tenant_id',tid);
  ok((count??0)===0,`${t}: ничего не осталось`, `${count}`);
}
const after=await owner('/me');
ok(after.body.needsChoice===true || after.body.tenantId===null,
  'бывший владелец не заперт в несуществующем кабинете', JSON.stringify({mode:after.body.mode,tenantId:after.body.tenantId}));

await sb.from('app_users').delete().in('subject',[`tg:${OWNER}`,`tg:${STAFF}`,`tg:${OUTSIDER}`]);
console.log(`\n${problems.length?`НЕ ПРОШЛО: ${problems.join('; ')}`:'Удаление кабинета работает.'}`);
if(problems.length) process.exit(1);
