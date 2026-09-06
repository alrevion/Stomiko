import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mintTenantToken } from './tenantjwt.js';

/**
 * Доступ к данным. Изоляция кабинетов держится на двух независимых слоях.
 *
 * СЛОЙ 1 — код: `TenantScope` подставляет `tenant_id` в каждый запрос, а
 * функции требуют его отдельным аргументом и сверяют с владельцем строки
 * (см. audit_tenant_guards). Прямой `supabase.from(...)` вне этого модуля
 * запрещён.
 *
 * СЛОЙ 2 — база: обращения к таблицам идут под токеном с claim `tenant_id`,
 * и политика отсекает чужое сама. Нужен потому, что первый слой держится на
 * аккуратности: он верен ровно до следующего маршрута, где кто-то забудет
 * фильтр. Со вторым слоем такая ошибка отдаёт НОЛЬ строк вместо чужих
 * данных — становится заметной, а не опасной.
 *
 * Второй слой включается, когда в окружении есть SUPABASE_JWT_SECRET и
 * SUPABASE_ANON_KEY. Без них воркер работает по-старому, под service_role:
 * включение обратимо и ничего не ломает.
 *
 * Функции остаются на service_role намеренно — часть из них по смыслу
 * пересекает кабинеты (приглашения, реестр людей, шаблоны, платежи).
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Токен платёжного провайдера из BotFather. Пусто — платим звёздами. */
  TELEGRAM_PROVIDER_TOKEN?: string;
  /**
   * Секрет подписи JWT проекта (панель Supabase → Settings → API → JWT).
   * Есть — обращения к таблицам идут под токеном кабинета, и изоляцию
   * держит сама база. Нет — работаем как раньше, под service_role.
   */
  SUPABASE_JWT_SECRET?: string;
  SUPABASE_ANON_KEY?: string;
  MINIAPP_URL?: string;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

export function createServiceClient(env: Env): SupabaseClient {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('не заданы SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Область кабинета с двумя слоями изоляции.
 *
 * Если секрет подписи настроен, обращения к таблицам пойдут под токеном
 * с claim `tenant_id`, и политика в базе отсечёт чужое сама. Если нет —
 * работаем как раньше: включение безопасно и обратимо.
 */
export async function scopeFor(
  env: Env, sb: SupabaseClient, tenantId: string,
): Promise<TenantScope> {
  const secret = env.SUPABASE_JWT_SECRET;
  const anon = env.SUPABASE_ANON_KEY;
  if (!secret || !anon) return new TenantScope(sb, tenantId);

  const token = await mintTenantToken(secret, tenantId);
  const scoped = createClient(env.SUPABASE_URL, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return new TenantScope(sb, tenantId, scoped);
}

/** Строка результата до появления сгенерированных типов схемы. */
export type Row = Record<string, unknown>;

/**
 * Минимальная поверхность построителя запросов, которой пользуется API.
 * Держим её узкой намеренно: чем меньше методов, тем меньше способов
 * случайно обойти фильтр по тенанту.
 */
export interface PostgrestFilterBuilder<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  eq(column: string, value: unknown): PostgrestFilterBuilder<T>;
  gte(column: string, value: unknown): PostgrestFilterBuilder<T>;
  lte(column: string, value: unknown): PostgrestFilterBuilder<T>;
  lt(column: string, value: unknown): PostgrestFilterBuilder<T>;
  in(column: string, values: readonly unknown[]): PostgrestFilterBuilder<T>;
  is(column: string, value: unknown): PostgrestFilterBuilder<T>;
  or(filter: string): PostgrestFilterBuilder<T>;
  order(column: string, opts?: { ascending?: boolean }): PostgrestFilterBuilder<T>;
  limit(n: number): PostgrestFilterBuilder<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

/** Таблицы, у которых есть `tenant_id`. Только они доступны через tenantScoped. */
type TenantTable =
  | 'locations' | 'memberships' | 'resources' | 'patients' | 'appointments'
  | 'appointment_resources' | 'visits' | 'units' | 'materials' | 'analog_groups'
  | 'batches' | 'techcard_blocks' | 'techcards' | 'services' | 'visit_services'
  | 'stock_movements' | 'visit_costs'
  | 'working_hours' | 'schedule_overrides' | 'booking_settings';

export class TenantScope {
  constructor(
    private readonly sb: SupabaseClient,
    readonly tenantId: string,
    /**
     * Клиент, ограниченный политикой на таблице.
     *
     * Обращения к таблицам идут через него, если настроен секрет подписи.
     * Тогда изоляцию держат ДВА независимых слоя: фильтр в коде и политика
     * в базе. Забытый фильтр отдаёт ноль строк вместо чужих данных —
     * ошибка становится заметной, а не опасной.
     *
     * Функции остаются на service_role: часть из них по смыслу пересекает
     * кабинеты (приглашения, реестр людей, шаблоны), и тенант у них
     * проверяется явно — см. audit_tenant_guards.
     */
    private readonly scoped: SupabaseClient = sb,
  ) {}

  /** Клиент для таблиц: ограниченный, если он есть. */
  private get t(): SupabaseClient { return this.scoped; }

  /**
   * Чтение: фильтр по тенанту навешен всегда, забыть его невозможно.
   *
   * Результат типизирован как `Record<string, unknown>[]`, а не выведен из схемы:
   * без сгенерированных типов supabase-js не может разобрать строку колонок и
   * отдаёт `GenericStringError`. ponytail: точная типизация — это
   * `supabase gen types` в CI с перегенерацией после каждой миграции; заводить
   * этот контур стоит, когда схема перестанет меняться каждый час.
   */
  select(table: TenantTable, columns = '*') {
    return this.t.from(table).select(columns).eq('tenant_id', this.tenantId) as unknown as
      PostgrestFilterBuilder<Row>;
  }

  /** Удаление — тоже только в пределах тенанта. */
  async delete(table: TenantTable, column: string, value: unknown) {
    const { error } = await this.t.from(table).delete()
      .eq('tenant_id', this.tenantId).eq(column, value);
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  /** Обновление в пределах тенанта. */
  async update(table: TenantTable, match: Record<string, unknown>, patch: Record<string, unknown>) {
    let q = this.t.from(table).update(patch).eq('tenant_id', this.tenantId);
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  /** Запись: `tenant_id` проставляется здесь, а не вызывающим кодом. */
  async insert<T extends Record<string, unknown>>(table: TenantTable, rows: T | T[]) {
    const payload = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      ...r,
      tenant_id: this.tenantId,
    }));
    const { data, error } = await this.t.from(table).insert(payload).select();
    if (error) throw new Error(`${table}: ${error.message}`);
    return data ?? [];
  }

  /**
   * RPC. `p_tenant_id` подставляется здесь, а не вызывающим кодом.
   *
   * Раньше функции принимали голый идентификатор и владельца строки не
   * проверяли: врач одного кабинета читал приёмы другого, подставив чужой id
   * в адрес. Теперь каждая функция, достижимая из HTTP, требует тенант и
   * сверяет его со строкой, а подставляется он централизованно — забыть
   * его в новом маршруте невозможно.
   */
  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, { ...args, p_tenant_id: this.tenantId });
    if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { pgCode: error.code });
    return data as T;
  }
}

/**
 * Кто открыл приложение.
 *
 * Роль больше не ВЫВОДИТСЯ из данных. Раньше наличие членства навсегда делало
 * человека врачом — и стоматолог не мог записаться к коллеге: приложение
 * показывало ему его собственный кабинет. Теперь роль это ВЫБРАННЫЙ режим,
 * а данные лишь говорят, какие режимы доступны.
 *
 * Ссылка задаёт КОНТЕКСТ (какой кабинет), право даёт членство в базе. Роль из
 * параметра ссылки не берётся никогда: иначе её подобрали бы.
 */
export interface Cabinet {
  tenantId: string;
  name: string;
  token: string;
  onboarding?: { active: boolean; seen: string[] } | null;
  catalogReviewed?: boolean;
  role?: string;
  lastVisit?: string | null;
  upcoming?: number;
}

export interface Identity {
  subject: string;
  /** Имя из Telegram: им подписан раздел «Ещё» у пациента. */
  firstName: string | null;
  mode: 'patient' | 'doctor';
  /** null означает «идти некуда» — новый человек без ссылки и без истории. */
  tenantId: string | null;
  tenantName: string;
  publicToken: string;
  canBeDoctor: boolean;
  staffOf: Cabinet[];
  patientOf: Cabinet[];
  /** Владелец открыл собственную ссылку для пациентов. */
  ownLink: boolean;
  /** Человек здесь впервые: показываем выбор «я пациент / я врач». */
  needsChoice: boolean;
  phone: string | null;
  /** Состояние знакомства с кабинетом: активно ли и какие экраны пройдены. */
  onboarding: { active: boolean; seen: string[] } | null;
  catalogReviewed: boolean;
}

interface UserContext {
  subject: string;
  firstName: string | null;
  phone: string | null;
  phoneVerified: boolean;
  activeMode: 'patient' | 'doctor';
  activeTenantId: string | null;
  modeChosen: boolean;
  /**
   * Кабинет, выбранный в поиске.
   *
   * Отдаётся базой только если человек вправе им пользоваться. Нужен потому,
   * что пациентом кабинета человек становится с ПЕРВОЙ ЗАПИСЬЮ, а выбрать
   * кабинет он должен раньше — иначе замкнутый круг.
   */
  activeCabinet: Cabinet | null;
  staffOf: Cabinet[];
  patientOf: Cabinet[];
}

export async function resolveIdentity(
  sb: SupabaseClient,
  subject: string,
  startParam: string | null,
  firstName?: string,
): Promise<Identity> {
  await sb.rpc('touch_app_user', { p_subject: subject, p_first_name: firstName ?? null });
  const { data: raw, error } = await sb.rpc('user_context', { p_subject: subject });
  if (error) throw new Error(`user_context: ${error.message}`);
  const ctx = raw as UserContext;

  const base = {
    subject,
    firstName: ctx.firstName ?? null,
    canBeDoctor: ctx.staffOf.length > 0,
    staffOf: ctx.staffOf,
    patientOf: ctx.patientOf,
    phone: ctx.phone,
    ownLink: false,
    needsChoice: false,
    onboarding: null,
    catalogReviewed: false,
  };
  const asCabinet = (c: Cabinet, mode: 'patient' | 'doctor'): Identity => ({
    ...base, mode, tenantId: c.tenantId, tenantName: c.name, publicToken: c.token,
    // Обучение живёт у кабинета, а не у человека: приглашённому ассистенту
    // показывать знакомство с уже настроенным кабинетом незачем.
    onboarding: mode === 'doctor' ? (c.onboarding ?? null) : null,
    catalogReviewed: Boolean(c.catalogReviewed),
  });

  // 1. Приглашение в кабинет. Одноразовое, гаснет через сутки.
  //
  // Telegram переотправляет тот же start_param при каждом открытии приложения
  // с той же ссылки. Значит врач, once вошедший по приглашению и открывший ту
  // же ссылку повторно, получал «приглашение уже использовано» и оставался за
  // дверью собственного кабинета. Поэтому погасшее приглашение — не ошибка
  // для того, у кого членство уже есть: просто идём обычным путём.
  if (startParam?.startsWith('inv_')) {
    // Ошибку вызова НЕЛЬЗЯ путать с отказом по приглашению. Однажды это уже
    // стоило времени: нарушение проверки в базе выглядело как «приглашение
    // недействительно», то есть ошибка кода читалась как испорченная ссылка.
    const { data, error: rpcError } = await sb.rpc('redeem_staff_invite', { p_token: startParam, p_subject: subject });
    if (rpcError) throw new Error(`не удалось принять приглашение: ${rpcError.message}`);
    const res = data as { ok: boolean; reason?: string; tenantId?: string; tenantName?: string; publicToken?: string } | null;
    if (!res?.ok && ctx.staffOf.length === 0) {
      throw new Error(res?.reason ?? 'приглашение недействительно');
    }
    if (!res?.ok) {
      const target = ctx.staffOf.find((c) => c.tenantId === ctx.activeTenantId) ?? ctx.staffOf[0]!;
      return asCabinet(target, 'doctor');
    }
    await sb.rpc('set_user_mode', { p_subject: subject, p_mode: 'doctor', p_tenant_id: res.tenantId });
    return {
      ...base, mode: 'doctor', tenantId: res.tenantId!, tenantName: res.tenantName ?? '',
      publicToken: res.publicToken ?? '', canBeDoctor: true,
      staffOf: [...ctx.staffOf, { tenantId: res.tenantId!, name: res.tenantName ?? '', token: res.publicToken ?? '', role: 'staff' }],
    };
  }

  // 2. Ссылка кабинета для пациентов. Токен непрозрачный: по id базу врачей
  //    перебрали бы инкрементом.
  if (startParam?.startsWith('d_')) {
    const { data } = await sb.from('tenants')
      .select('id, name, public_token').eq('public_token', startParam).maybeSingle();
    const t = data as { id: string; name: string; public_token: string } | null;
    if (!t) throw new Error('ссылка недействительна — попросите у врача новую');
    return {
      ...asCabinet({ tenantId: t.id, name: t.name, token: t.public_token }, 'patient'),
      // Врач открыл собственную ссылку — не оставляем его гадать, почему
      // вместо кабинета показывают запись.
      ownLink: ctx.staffOf.some((c) => c.tenantId === t.id),
    };
  }

  // 3. Вход без ссылки — по тому, что мы про человека знаем.
  const staffTarget = ctx.staffOf.find((c) => c.tenantId === ctx.activeTenantId) ?? ctx.staffOf[0];
  // Выбранный в поиске кабинет идёт вперёд запасного варианта: человек
  // только что указал, куда хочет, и подставлять ему вместо этого первый
  // попавшийся из истории — значит потерять его выбор.
  const patientTarget = ctx.patientOf.find((c) => c.tenantId === ctx.activeTenantId)
    ?? ctx.activeCabinet ?? ctx.patientOf[0];
  const nowhere: Identity = {
    ...base, mode: 'patient', tenantId: null, tenantName: '', publicToken: '', needsChoice: false,
  };

  // Человек выбрал режим сам — выбор уважается, даже если в нём пусто.
  // Иначе врач, нажавший «я пациент», возвращался бы в свой кабинет и решил,
  // что кнопка сломана.
  if (ctx.modeChosen) {
    if (ctx.activeMode === 'doctor' && staffTarget) return asCabinet(staffTarget, 'doctor');
    if (ctx.activeMode === 'patient') {
      return patientTarget ? asCabinet(patientTarget, 'patient') : nowhere;
    }
  }

  // Режим не выбирали — выводим из того, что есть. Членство конкретнее:
  // пациентом может быть каждый, а работает человек в определённом кабинете.
  if (staffTarget) return asCabinet(staffTarget, 'doctor');
  if (patientTarget) return asCabinet(patientTarget, 'patient');

  // Никогда здесь не был и ссылки нет. Демо-запасной путь «единственный
  // кабинет» удалён: на втором кабинете он молча приводил бы чужого пациента
  // к чужому врачу.
  return { ...nowhere, needsChoice: true };
}
