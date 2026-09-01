/**
 * Выгрузка применённых миграций из Supabase в packages/db/sql.
 *
 * Миграции 007–026 применялись прямо в облако и на диске не сохранились:
 * схема существовала только в одной живой базе. Второй кабинет было бы
 * не из чего поднять, а потеря проекта означала бы потерю схемы.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const DEV = new URL('../.dev.vars', import.meta.url).pathname;
const env = (k: string) => {
  for (const l of readFileSync(DEV, 'utf8').split('\n')) if (l.trim().startsWith(`${k}=`)) return l.trim().slice(k.length + 1).trim();
  throw new Error(k);
};
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const { data, error } = await sb.rpc('_dump_migrations');
if (error) throw new Error(error.message);

const dir = new URL('../../../packages/db/sql/', import.meta.url).pathname;
let written = 0;
for (const m of data as { version: string; name: string; statements: string[] }[]) {
  const n = m.name.match(/^(\d{3})/)?.[1];
  if (!n) continue;
  const file = `${dir}${m.name}.sql`;
  if (existsSync(file)) continue;
  writeFileSync(file, `-- ${m.name} (применена ${m.version})\n\n${(m.statements ?? []).join(';\n\n')};\n`);
  console.log(`записана ${m.name}.sql`);
  written += 1;
}
console.log(written ? `\nвыгружено ${written}` : '\nвсё уже на диске');
