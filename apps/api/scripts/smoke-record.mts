/** Переносимая история: запечатывание, доступ врача, дополнение, живучесть. */
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

const A=990801, B=990802, PAT=990803;
await sb.from('memberships').delete().in('subject',[`tg:${A}`,`tg:${B}`]);
await sb.from('app_users').delete().in('subject',[`tg:${A}`,`tg:${B}`,`tg:${PAT}`]);
const docA=as(A), docB=as(B);

console.log('── Два кабинета и один человек ──');
const rA=await docA('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Первый Кабинет',doctorName:'Каримов А.А.',template:'therapist'})});
const rB=await docB('/onboarding/register',{method:'POST',body:JSON.stringify({name:'Второй Кабинет',doctorName:'Юсупов Б.Б.',template:'therapist'})});
const tA=rA.body.tenantId as string, tB=rB.body.tenantId as string;
await docA('/onboarding/finish',{method:'POST'}); await docB('/onboarding/finish',{method:'POST'});
ok(!!tA && !!tB,'кабинеты созданы');
const linkA=(await sb.from('tenants').select('public_token').eq('id',tA).single()).data!.public_token;
await sb.rpc('set_verified_phone',{p_subject:`tg:${PAT}`,p_phone:'+998900990803'});
const pat=as(PAT,linkA);

console.log('\n── Лечение в первом кабинете ──');
const info=await pat('/book/info');
const svc=(info.body.services??[])[0];
const slots=await pat(`/book/slots?serviceId=${svc.id}&days=21`);
const booked=await pat('/book',{method:'POST',body:JSON.stringify({serviceId:svc.id,startsAt:slots.body.days[0].times[0],name:'Носитель Истории'})});
ok(booked.status===200,'пациент записался',String(booked.body.error??''));
const patientId=booked.body.patientId as string;

const started=await docA(`/doctor/appointments/${booked.body.appointmentId}/start`,{method:'POST'});
ok(started.status===200,'приём начат');
const beforeClose=(await sb.from('clinical_entries').select('*',{count:'exact',head:true}).eq('person_subject',`tg:${PAT}`)).count;
ok((beforeClose??0)===0,'пока приём открыт истории нет — это черновик врача');
const closed=await docA(`/doctor/visits/${started.body.visitId}/close`,{method:'POST'});
ok(closed.status===200,'приём закрыт',String(closed.body.error??''));
const { data: sealed } = await sb.from('clinical_entries').select('*').eq('person_subject',`tg:${PAT}`);
ok((sealed??[]).length===1,'закрытие запечатало запись',`${(sealed??[]).length}`);
ok(sealed![0].author_cabinet==='Первый Кабинет','кабинет записан снимком',String(sealed![0].author_cabinet));
ok(sealed![0].author_doctor==='Каримов А.А.','врач записан снимком',String(sealed![0].author_doctor));
ok(sealed![0].sealed_at!=null,'момент запечатывания зафиксирован');

console.log('\n── Второй кабинет видит историю, но не всегда ──');
const before=await sb.rpc('doctor_may_see_person',{p_tenant_id:tB,p_subject:`tg:${PAT}`});
ok(before.data===false,'до записи второй кабинет истории не видит');
const linkB=(await sb.from('tenants').select('public_token').eq('id',tB).single()).data!.public_token;
const pat2=as(PAT,linkB);
const info2=await pat2('/book/info');
const svc2=(info2.body.services??[])[0];
const slots2=await pat2(`/book/slots?serviceId=${svc2.id}&days=21`);
const booked2=await pat2('/book',{method:'POST',body:JSON.stringify({serviceId:svc2.id,startsAt:slots2.body.days[0].times[0],name:'Носитель Истории'})});
ok(booked2.status===200,'пациент записался во второй кабинет',String(booked2.body.error??''));
const after=await sb.rpc('doctor_may_see_person',{p_tenant_id:tB,p_subject:`tg:${PAT}`});
ok(after.data===true,'ПОСЛЕ ЗАПИСИ доступ открылся — врач готовится заранее');
const rec=await sb.rpc('person_record_for_doctor',{p_tenant_id:tB,p_subject:`tg:${PAT}`,p_actor:`tg:${B}`});
ok(!rec.error && (rec.data as any[]).length===1,'второй врач видит лечение первого',String(rec.error?.message??''));
ok((rec.data as any[])[0].cabinet==='Первый Кабинет','видно, где лечили');

console.log('\n── Исправление дополнением ──');
const entry=sealed![0].id;
const am=await sb.rpc('amend_clinical_entry',{p_tenant_id:tB,p_entry_id:entry,p_note:'Зуб 26, а не 27',p_actor:`tg:${B}`});
ok(!am.error,'дополнение добавлено',String(am.error?.message??''));
const { data: all } = await sb.from('clinical_entries').select('id, amends, note').eq('person_subject',`tg:${PAT}`);
ok((all??[]).length===2,'записей стало две — исходная цела');
ok((all??[]).some(e=>e.amends===entry),'дополнение ссылается на исходную');
const orig=(all??[]).find(e=>e.id===entry);
ok(orig!=null && orig.note==null,'исходная запись НЕ переписана');

console.log('\n── Журнал доступа ──');
const { count: logged } = await sb.from('access_log').select('*',{count:'exact',head:true})
  .in('action',['clinical_record','clinical_amend']).eq('detail',`tg:${PAT}`);
ok((logged??0)>=2,'обращения к истории записаны',`${logged}`);

console.log('\n── Кабинет исчезает, история остаётся ──');
const killed=await docA('/doctor/cabinet',{method:'DELETE'});
ok(killed.status===200,'первый кабинет удалён',String(killed.body.error??''));
const { data: survived } = await sb.from('clinical_entries').select('*').eq('person_subject',`tg:${PAT}`);
ok((survived??[]).length===2,'записи целы после удаления кабинета',`${(survived??[]).length}`);
const first=(survived??[]).find(e=>e.id===entry)!;
ok(first.author_tenant_id===null,'ссылка на кабинет обнулена');
ok(first.author_cabinet==='Первый Кабинет','НО имя кабинета осталось — запись читаема');
ok(first.visit_id===null,'связь с приёмом обнулена');
const { count: patientsGone } = await sb.from('patients').select('*',{count:'exact',head:true}).eq('tenant_id',tA);
ok((patientsGone??0)===0,'работа кабинета стёрта полностью');

console.log('\n── Сверка ──');
const { data: health } = await sb.rpc('clinical_health',{});
ok((health as any).missing===0,'сторож истории: пропусков нет',JSON.stringify(health));

console.log('\n── Уборка ──');
await sb.from('clinical_entries').delete().eq('person_subject',`tg:${PAT}`);
const d=await sb.rpc('delete_tenant',{p_tenant_id:tB}); ok(!d.error,'второй кабинет удалён',d.error?.message??'');
await sb.from('app_users').delete().in('subject',[`tg:${A}`,`tg:${B}`,`tg:${PAT}`]);
console.log(`\n${problems.length?`НЕ ПРОШЛО: ${problems.join('; ')}`:'Переносимая история работает.'}`);
if(problems.length) process.exit(1);
