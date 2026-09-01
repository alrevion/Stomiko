/**
 * Выгрузка справочника-шаблона в статический сид.
 *
 * Миграция 037 снимает шаблон с ДЕЙСТВУЮЩЕГО кабинета — это правильно один
 * раз, но на чистой базе снимать нечего, и новый врач получил бы пустой
 * склад. Здесь шаблон превращается в обычные INSERT-ы, которые ложатся
 * рядом с миграциями и работают где угодно.
 *
 *   pnpm exec tsx scripts/dump-template.mts
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => {
  for (const l of readFileSync(DEV, 'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length + 1).trim();
  throw new Error(`нет ${k}`);
};
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const q = (v: unknown) =>
  v === null || v === undefined ? 'null'
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

const tpl = (await sb.from('catalog_templates').select('*').eq('code', 'therapist').single()).data!;
const pick = async (table: string, filter: (b: any) => any) =>
  ((await filter(sb.from(table).select('*'))).data ?? []) as any[];

const units    = await pick('template_units',        (b: any) => b.eq('template_id', tpl.id).order('code'));
const mats     = await pick('template_materials',    (b: any) => b.eq('template_id', tpl.id).order('name_ru'));
const groups   = await pick('template_analog_groups',(b: any) => b.eq('template_id', tpl.id).order('name'));
const members  = await pick('template_analog_members',(b: any) => b.order('material_name'));
const blocks   = await pick('template_blocks',       (b: any) => b.eq('template_id', tpl.id).order('code'));
const blines   = await pick('template_block_lines',  (b: any) => b.order('material_name'));
const svcs     = await pick('template_services',     (b: any) => b.eq('template_id', tpl.id).order('name_ru'));
const tlines   = await pick('template_techcard_lines',(b: any) => b.order('id'));

const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
const blockById = byId(blocks); const svcById = byId(svcs); const grpById = byId(groups);

const out: string[] = [
  '-- Справочник терапевта как статический сид.',
  '--',
  '-- Сгенерировано scripts/dump-template.mts из шаблонных таблиц. Нужен для',
  '-- ЧИСТОЙ базы: миграция 037 снимает шаблон с действующего кабинета, а там',
  '-- его нет. Правится не здесь, а в шаблонных таблицах, с новой выгрузкой.',
  '',
  'do $$', 'declare tpl uuid;', 'begin',
  `  select id into tpl from catalog_templates where code = 'therapist';`,
  '  if tpl is not null then return; end if;   -- уже наполнено',
  `  insert into catalog_templates (code, name_ru, specialty)`,
  `       values (${q(tpl.code)}, ${q(tpl.name_ru)}, ${q(tpl.specialty)}) returning id into tpl;`,
  '',
];

for (const u of units)
  out.push(`  insert into template_units (template_id, code, name_ru, name_uz, factor, divisible) values (tpl, ${q(u.code)}, ${q(u.name_ru)}, ${q(u.name_uz)}, ${q(u.factor)}, ${q(u.divisible)});`);
out.push('');
for (const m of mats)
  out.push(`  insert into template_materials (template_id, name_ru, name_uz, category, unit_code, reference_price) values (tpl, ${q(m.name_ru)}, ${q(m.name_uz)}, ${q(m.category)}, ${q(m.unit_code)}, ${q(m.reference_price)});`);
out.push('');
for (const g of groups)
  out.push(`  insert into template_analog_groups (template_id, name) values (tpl, ${q(g.name)});`);
for (const mem of members) {
  const g = grpById.get(mem.group_id); if (!g) continue;
  out.push(`  insert into template_analog_members (group_id, material_name, priority) select id, ${q(mem.material_name)}, ${q(mem.priority)} from template_analog_groups where template_id = tpl and name = ${q(g.name)};`);
}
out.push('');
for (const b of blocks)
  out.push(`  insert into template_blocks (template_id, code, name_ru, name_uz) values (tpl, ${q(b.code)}, ${q(b.name_ru)}, ${q(b.name_uz)});`);
for (const l of blines) {
  const b = blockById.get(l.block_id); if (!b) continue;
  out.push(`  insert into template_block_lines (block_id, material_name, norm_qty, unit_code, scales_with_quantity) select id, ${q(l.material_name)}, ${q(l.norm_qty)}, ${q(l.unit_code)}, ${q(l.scales_with_quantity)} from template_blocks where template_id = tpl and code = ${q(b.code)};`);
}
out.push('');
for (const s of svcs)
  out.push(`  insert into template_services (template_id, code, name_ru, name_uz, price, unit_of_norm, duration_minutes, bookable, techcard_name_ru) values (tpl, ${q(s.code)}, ${q(s.name_ru)}, ${q(s.name_uz)}, ${q(s.price)}, ${q(s.unit_of_norm)}, ${q(s.duration_minutes)}, ${q(s.bookable)}, ${q(s.techcard_name_ru)});`);
for (const l of tlines) {
  const s = svcById.get(l.service_id); if (!s) continue;
  out.push(`  insert into template_techcard_lines (service_id, material_name, analog_group_name, block_code, norm_qty, unit_code, scales_with_quantity) select id, ${q(l.material_name)}, ${q(l.analog_group_name)}, ${q(l.block_code)}, ${q(l.norm_qty)}, ${q(l.unit_code)}, ${q(l.scales_with_quantity)} from template_services where template_id = tpl and name_ru = ${q(s.name_ru)};`);
}
out.push('end $$;', '');

const path = new URL('../../../packages/db/sql/037b_template_data_therapist.sql', import.meta.url).pathname;
writeFileSync(path, out.join('\n'));
console.log(`записано ${path}`);
console.log(`единиц ${units.length}, материалов ${mats.length}, блоков ${blocks.length} (${blines.length} строк), услуг ${svcs.length}, строк техкарт ${tlines.length}`);
