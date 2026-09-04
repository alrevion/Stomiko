import { Hono } from 'hono';
import { closeVisit } from '../close.js';
import type { Env, Identity, TenantScope } from '../db.js';
import { acknowledgeShortfall } from '../stock.js';
import { notifyCancelled, notifyPlanReady, notifyReminder, type CancelNotice } from '../notify.js';

type Vars = { scope: TenantScope; identity: Identity };
export const doctor = new Hono<{ Bindings: Env; Variables: Vars }>();

const TZ = 'Asia/Tashkent';
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** Кресло кабинета: единица дефицита, к которой привязано всё расписание. */
async function chairId(scope: TenantScope): Promise<string> {
  const { data } = await scope.select('resources', 'id').eq('kind', 'chair').limit(1);
  const row = (data ?? [])[0];
  if (!row) throw new Error('в кабинете не заведено кресло');
  return String(row.id);
}

// ── Календарь ───────────────────────────────────────────────────────────────

/**
 * Неделя врача одним запросом: записи, рабочие часы и правки на даты.
 * Клиент рисует сетку сам — так он может показать пустые дни как «выходной»,
 * а не как «нет записей», и это разные вещи для врача.
 */
doctor.get('/calendar', async (c) => {
  const scope = c.get('scope');
  const from = c.req.query('from') ?? todayLocal();
  const to = c.req.query('to') ?? new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });

  const [appointments, hours, overrides, settings, shortest] = await Promise.all([
    scope.select('appointments',
      'id, starts_at, ends_at, status, source, note, confirmed_at, patient_id, patients(full_name, phone, telegram_subject), services(name_ru, duration_minutes, price)')
      .gte('starts_at', `${from}T00:00:00+05:00`)
      .lte('starts_at', `${to}T23:59:59+05:00`)
      .order('starts_at'),
    scope.select('working_hours', 'weekday, starts_at, ends_at').order('weekday'),
    scope.select('schedule_overrides', 'id, on_date, is_closed, starts_at, ends_at, reason')
      .gte('on_date', from).lte('on_date', to),
    scope.select('booking_settings', '*').maybeSingle(),
    // Самая короткая услуга задаёт минимальное окно, которое вообще имеет
    // смысл показывать врачу как свободное.
    scope.select('services', 'duration_minutes').eq('bookable', true)
      .order('duration_minutes').limit(1),
  ]);

  // Приёмы, уже начатые по этим записям: врач должен видеть, что закрыто.
  const ids = (appointments.data ?? []).map((a) => String(a.id));
  const visits = ids.length
    ? (await scope.select('visits', 'id, appointment_id, status').in('appointment_id', ids)).data ?? []
    : [];
  const visitByAppt = new Map(visits.map((v) => [String(v.appointment_id), v]));

  return c.json({
    from, to,
    appointments: (appointments.data ?? []).map((a) => {
      const v = visitByAppt.get(String(a.id));
      return {
        id: a.id,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
        status: a.status,
        source: a.source,
        note: a.note,
        patientId: a.patient_id,
        patient: (a.patients as { full_name?: string } | null)?.full_name ?? '—',
        phone: (a.patients as { phone?: string } | null)?.phone ?? null,
        service: (a.services as { name_ru?: string } | null)?.name_ru ?? null,
        price: (a.services as { price?: number } | null)?.price ?? null,
        // Подтвердил ли пациент, что придёт. Смысл не в галочке: врач
        // обзванивает не всех, а тех, кто промолчал после напоминания.
        confirmed: a.confirmed_at != null,
        // Есть ли кому нажимать кнопку. Без этого «не подтвердил» висело бы
        // над каждым, кто записался по телефону и бота в глаза не видел.
        reachable: (a.patients as { telegram_subject?: string | null } | null)?.telegram_subject != null,
        visitId: v ? v.id : null,
        visitStatus: v ? v.status : null,
      };
    }),
    workingHours: hours.data ?? [],
    overrides: overrides.data ?? [],
    settings: settings.data ?? null,
    minServiceMinutes: Number((shortest.data ?? [])[0]?.duration_minutes ?? 20),
  });
});

// ── Расписание ──────────────────────────────────────────────────────────────

doctor.get('/schedule', async (c) => {
  const scope = c.get('scope');
  const [hours, overrides, settings, tenant] = await Promise.all([
    scope.select('working_hours', 'id, weekday, starts_at, ends_at').order('weekday'),
    scope.select('schedule_overrides', 'id, on_date, is_closed, starts_at, ends_at, reason')
      .gte('on_date', todayLocal()).order('on_date'),
    scope.select('booking_settings', '*').maybeSingle(),
    scope.select('locations', 'id, name').limit(1),
  ]);
  return c.json({
    workingHours: hours.data ?? [],
    overrides: overrides.data ?? [],
    settings: settings.data ?? null,
    location: (tenant.data ?? [])[0] ?? null,
  });
});

/**
 * Замена недельного расписания целиком.
 *
 * Именно замена, а не правка по строкам: у врача в голове «мои рабочие дни»,
 * а не набор интервалов с идентификаторами. Частичное редактирование тут
 * породило бы состояния, которых врач не заказывал.
 *
 * Замена идёт одной транзакцией в БД. Раньше здесь были отдельные delete
 * и insert: сбой между ними оставлял кабинет вообще без рабочих часов —
 * а это мгновенная остановка онлайн-записи, причём молча.
 */
doctor.put('/schedule', async (c) => {
  const scope = c.get('scope');
  const body = await c.req.json<{
    hours: { weekday: number; startsAt: string; endsAt: string }[];
    settings?: { slotStepMinutes?: number; minNoticeMinutes?: number; maxDaysAhead?: number; bufferMinutes?: number };
  }>();

  try {
    const res = await scope.rpc<{ days: number }>('save_schedule', {
      p_tenant_id: scope.tenantId,
      p_resource_id: await chairId(scope),
      p_hours: body.hours ?? [],
      p_settings: body.settings ?? null,
    });
    return c.json({ ok: true, days: res.days });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Разовая правка на дату: закрыть день или открыть его с другими часами. */
doctor.post('/schedule/override', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ date: string; isClosed: boolean; startsAt?: string; endsAt?: string; reason?: string }>();
  const chair = await chairId(scope);

  // Повторная правка на ту же дату заменяет предыдущую, а не копится рядом.
  const { data: existing } = await scope.select('schedule_overrides', 'id')
    .eq('resource_id', chair).eq('on_date', b.date);
  for (const row of existing ?? []) await scope.delete('schedule_overrides', 'id', row.id);

  const [row] = await scope.insert('schedule_overrides', {
    resource_id: chair,
    on_date: b.date,
    is_closed: b.isClosed,
    starts_at: b.isClosed ? null : b.startsAt,
    ends_at: b.isClosed ? null : b.endsAt,
    reason: b.reason ?? null,
  });
  return c.json({ override: row });
});

doctor.delete('/schedule/override/:id', async (c) => {
  await c.get('scope').delete('schedule_overrides', 'id', c.req.param('id'));
  return c.json({ ok: true });
});

// ── Записи ──────────────────────────────────────────────────────────────────

/**
 * Кто занимает промежуток. Врач обязан увидеть это ДО того, как займёт время:
 * молча отменить чужую запись нельзя, а если пациент уже назначен — нужна
 * причина, которую он прочитает.
 */
doctor.get('/conflicts', async (c) => {
  const scope = c.get('scope');
  const startsAt = c.req.query('startsAt');
  const endsAt = c.req.query('endsAt');
  if (!startsAt || !endsAt) return c.json({ error: 'не задан промежуток' }, 400);

  const rows = await scope.rpc<Record<string, unknown>[]>('appointments_in_range', {
    p_tenant_id: scope.tenantId,
    p_resource_id: await chairId(scope),
    p_starts_at: startsAt,
    p_ends_at: endsAt,
  });

  return c.json({
    conflicts: (rows ?? []).map((r) => ({
      appointmentId: r.appointment_id,
      patient: r.patient_name,
      phone: r.patient_phone,
      service: r.service_name,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      // Уведомить можно только тех, кто записывался через Telegram.
      // Остальным придётся звонить — и врач должен знать об этом заранее.
      notifiable: Boolean(r.telegram_subject),
    })),
  });
});

/**
 * Занять промежуток («обед», «уехал»). Если внутри есть чужие записи, они
 * отменяются — но только с причиной, и каждому пациенту уходит сообщение.
 */
doctor.post('/block', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');
  const b = await c.req.json<{ startsAt: string; endsAt: string; reason?: string; cancelReason?: string }>();

  const chair = await chairId(scope);
  const conflicts = await scope.rpc<Record<string, unknown>[]>('appointments_in_range', {
    p_tenant_id: scope.tenantId, p_resource_id: chair,
    p_starts_at: b.startsAt, p_ends_at: b.endsAt,
  });

  if ((conflicts ?? []).length && !b.cancelReason?.trim()) {
    return c.json({
      error: 'на это время есть записи — укажите причину отмены, её увидит пациент',
      conflicts: (conflicts ?? []).length,
    }, 409);
  }

  const notified: { patient: string; ok: boolean; reason: string; phone: string | null }[] = [];
  for (const conflict of conflicts ?? []) {
    const notice = await scope.rpc<CancelNotice & { alreadyCancelled: boolean }>('cancel_appointment', {
      p_appointment_id: conflict.appointment_id,
      p_by: 'врач',
      p_reason: b.cancelReason!.trim(),
    });
    if (notice.alreadyCancelled) continue;
    const result = await notifyCancelled(c.env.TELEGRAM_BOT_TOKEN, notice, identity.tenantName);
    notified.push({ patient: notice.patientName, ok: result === 'sent', reason: result, phone: notice.patientPhone });
  }

  try {
    const id = await scope.rpc<string>('block_time', {
      p_tenant_id: scope.tenantId,
      p_resource_id: chair,
      p_starts_at: b.startsAt,
      p_ends_at: b.endsAt,
      p_reason: b.reason?.trim() || 'занято',
    });
    return c.json({ appointmentId: id, cancelled: notified });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

/** Приём без записи: имя и телефон, без системных диалогов. */
doctor.post('/walk-in', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ name: string; phone?: string; serviceId?: string }>();
  if (!b.name?.trim()) return c.json({ error: 'укажите имя пациента' }, 400);

  const { data: locs } = await scope.select('locations', 'id').limit(1);
  const phone = (b.phone ?? '').replace(/[^\d+]/g, '') || null;

  let patientId: string | null = null;
  if (phone) {
    const { data: found } = await scope.select('patients', 'id').eq('phone', phone).maybeSingle();
    if (found) patientId = String(found.id);
  }
  if (!patientId) {
    const [p] = await scope.insert('patients', { full_name: b.name.trim(), phone });
    patientId = String((p as { id: string }).id);
  }

  const [visit] = await scope.insert('visits', {
    location_id: String((locs ?? [])[0]?.id),
    patient_id: patientId,
  });
  const visitId = String((visit as { id: string }).id);

  if (b.serviceId) {
    const { data: svc } = await scope
      .select('services', 'id, price, techcard_version_id').eq('id', b.serviceId).maybeSingle();
    if (svc) {
      await scope.insert('visit_services', {
        visit_id: visitId, service_id: svc.id, quantity: 1,
        price: Number(svc.price), techcard_version_id: svc.techcard_version_id,
      });
    }
  }
  return c.json({ visitId });
});

doctor.post('/appointments/:id/cancel', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');
  const b = await c.req.json<{ reason?: string }>().catch(() => ({ reason: '' }));
  if (!b.reason?.trim()) {
    return c.json({ error: 'укажите причину — её увидит пациент' }, 400);
  }
  try {
    const notice = await scope.rpc<CancelNotice & { alreadyCancelled: boolean }>('cancel_appointment', {
      p_appointment_id: c.req.param('id'),
      p_by: 'врач',
      p_reason: b.reason.trim(),
    });
    if (notice.alreadyCancelled) return c.json({ ok: true, notified: false });
    const result = await notifyCancelled(c.env.TELEGRAM_BOT_TOKEN, notice, identity.tenantName);
    // Врач обязан знать, дошло ли сообщение и почему нет: если пациент не
    // начинал чат с ботом, написать ему нельзя — остаётся звонить.
    return c.json({
      ok: true, notified: result === 'sent', reason: result,
      phone: notice.patientPhone, patient: notice.patientName,
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * Начать приём по записи: создаётся визит и в него сразу подставляется услуга,
 * ради которой пациент записывался. Врач не выбирает её заново — он её уже знает.
 */
doctor.post('/appointments/:id/start', async (c) => {
  const scope = c.get('scope');
  const apptId = c.req.param('id');

  const { data: appt } = await scope
    .select('appointments', 'id, patient_id, service_id, status')
    .eq('id', apptId).maybeSingle();
  if (!appt) return c.json({ error: 'запись не найдена' }, 404);

  const { data: already } = await scope
    .select('visits', 'id').eq('appointment_id', apptId).maybeSingle();
  if (already) return c.json({ visitId: already.id, existing: true });

  const { data: locs } = await scope.select('locations', 'id').limit(1);
  const [visit] = await scope.insert('visits', {
    location_id: String((locs ?? [])[0]?.id),
    appointment_id: apptId,
    patient_id: appt.patient_id,
  });

  if (appt.service_id) {
    const { data: svc } = await scope
      .select('services', 'id, price, techcard_version_id, unit_of_norm')
      .eq('id', appt.service_id).maybeSingle();
    if (svc) {
      await scope.insert('visit_services', {
        visit_id: (visit as { id: string }).id,
        service_id: svc.id,
        quantity: 1,
        price: Number(svc.price),
        techcard_version_id: svc.techcard_version_id,
      });
    }
  }
  await scope.update('appointments', { id: apptId }, { status: 'done' });
  return c.json({ visitId: (visit as { id: string }).id, existing: false });
});

/** Отметка «не пришёл». Слот освобождается, но это не отмена по просьбе. */
doctor.post('/appointments/:id/no-show', async (c) => {
  try {
    await c.get('scope').rpc('mark_no_show', { p_appointment_id: c.req.param('id') });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── Приём и пациенты ────────────────────────────────────────────────────────

/**
 * Один приём по идентификатору.
 *
 * Раньше экран приёма искал визит в ленте дня — и вчерашний приём открыть
 * было нельзя вообще. Именно вчерашний врач и открывает: «что я делал этому
 * человеку в прошлый раз».
 */
doctor.get('/visits/:id', async (c) => {
  const visit = await c.get('scope').rpc<Record<string, unknown> | null>('visit_detail', {
    p_visit_id: c.req.param('id'),
    p_actor: c.get('identity').subject,
  });
  if (!visit) return c.json({ error: 'приём не найден' }, 404);
  return c.json({ visit });
});

/**
 * База пациентов с историей.
 *
 * Самый частый вопрос стоматолога — не «сколько я заработал», а «кто это и
 * когда он был у меня в прошлый раз». Без этого экрана приложение остаётся
 * калькулятором себестоимости, а не рабочим местом.
 */
doctor.get('/patients', async (c) => {
  const scope = c.get('scope');
  const rows = await scope.rpc<Record<string, unknown>[]>('patients_overview', {
    p_tenant_id: scope.tenantId,
    p_query: c.req.query('q') ?? '',
    p_limit: 60,
    p_actor: c.get('identity').subject,
  });
  return c.json({
    patients: (rows ?? []).map((r) => ({
      id: r.id,
      name: r.full_name,
      phone: r.phone,
      visits: Number(r.visits),
      lastVisit: r.last_visit,
      totalRevenue: Number(r.total_revenue),
      nextAt: r.next_at,
      inTelegram: Boolean(r.in_telegram),
    })),
  });
});

doctor.get('/patients/:id', async (c) => {
  const scope = c.get('scope');
  const card = await scope.rpc<Record<string, unknown> | null>('patient_card', {
    p_tenant_id: scope.tenantId,
    p_patient_id: c.req.param('id'),
    p_actor: c.get('identity').subject,
  });
  if (!card) return c.json({ error: 'пациент не найден' }, 404);

  // Кто ещё открывал карту. Показываем, только если в кабинете не один
  // человек: строка «вы, двенадцать раз» — это шум, а не подотчётность.
  const { data: staff } = await scope.select('memberships', 'subject');
  const log = (staff ?? []).length > 1
    ? await scope.rpc<Record<string, unknown>[]>('patient_access_log', {
        p_patient_id: c.req.param('id'), p_limit: 20 })
    : [];
  return c.json({ ...(card as object), accessLog: log });
});

/**
 * История лечения человека — та, что он принёс с собой.
 *
 * Отдельным маршрутом, а не полем карточки: это единственное место, где
 * кабинет видит записи ЧУЖИХ кабинетов, и открывается оно осознанным
 * нажатием. Иначе журнал доступа заполнялся бы автоматическими обращениями
 * и перестал бы что-либо значить.
 *
 * Subject берётся из карточки этого кабинета, а не из запроса: иначе врач
 * подставил бы чужой и прочитал историю человека, который к нему не ходит.
 * Право всё равно проверяет функция БД — здесь оно проверяется дважды.
 */
doctor.get('/patients/:id/record', async (c) => {
  const scope = c.get('scope');
  const { data } = await scope.select('patients', 'telegram_subject')
    .eq('id', c.req.param('id')).maybeSingle();
  const subject = (data as { telegram_subject?: string } | null)?.telegram_subject;
  if (!subject) {
    return c.json({ entries: [], noTelegram: true });
  }
  try {
    const entries = await scope.rpc<unknown[]>('person_record_for_doctor', {
      p_subject: subject, p_actor: c.get('identity').subject,
    });
    return c.json({ entries: entries ?? [] });
  } catch (err) {
    return c.json({ error: (err as Error).message.replace(/^person_record_for_doctor: /, '') }, 403);
  }
});

/** Дополнение к чужой записи. Исправить её нельзя — только уточнить рядом. */
doctor.post('/record/:entryId/amend', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  try {
    const res = await scope.rpc<Record<string, unknown>>('amend_clinical_entry', {
      p_entry_id: c.req.param('entryId'),
      p_note: b.note ?? '',
      p_actor: c.get('identity').subject,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message.replace(/^amend_clinical_entry: /, '') }, 400);
  }
});

/**
 * Зуб у оказанной услуги.
 *
 * Отдельным маршрутом: зуб чаще уточняют уже после того, как услугу внесли —
 * врач сначала записывает, что сделал, и только потом смотрит, на каком зубе.
 * Правило «пока приём открыт» держит функция БД.
 */
doctor.put('/visit-services/:id/tooth', async (c) => {
  const b = await c.req.json<{ tooth?: string | null }>().catch(() => ({} as { tooth?: string }));
  try {
    const res = await c.get('scope').rpc<Record<string, unknown>>('set_visit_service_tooth', {
      p_visit_service_id: c.req.param('id'), p_tooth: b.tooth ?? null,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message.replace(/^set_visit_service_tooth: /, '') }, 400);
  }
});

/** Заметка о пациенте: аллергия, особенности, о чём договорились. */
doctor.put('/patients/:id', async (c) => {
  const scope = c.get('scope');
  const b: { notes?: string; phone?: string; name?: string } =
    await c.req.json<{ notes?: string; phone?: string; name?: string }>().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (b.notes !== undefined) patch.notes = b.notes.trim() || null;
  if (b.phone !== undefined) patch.phone = b.phone.replace(/[^\d+]/g, '') || null;
  if (b.name?.trim()) patch.full_name = b.name.trim();
  if (!Object.keys(patch).length) return c.json({ ok: true });
  await scope.update('patients', { id: c.req.param('id') }, patch);
  await scope.rpc('log_access', {
    p_subject: c.get('identity').subject,
    p_action: 'patient_edit',
    p_target_id: c.req.param('id'),
    p_detail: Object.keys(patch).join(', '),
  }).catch(() => {});
  return c.json({ ok: true });
});

// ── Удаление кабинета ───────────────────────────────────────────────────────

/**
 * Что исчезнет вместе с кабинетом.
 *
 * Отдаётся ДО удаления и показывается в окне подтверждения. «Вы уверены?»
 * без цифр — вопрос ни о чём: человек не помнит, сколько у него пациентов.
 */
doctor.get('/cabinet/scale', async (c) => {
  const scope = c.get('scope');
  const scale = await scope.rpc<Record<string, unknown>>('cabinet_scale', {
    p_tenant_id: scope.tenantId,
  });
  const me = c.get('identity').staffOf.find((x) => x.tenantId === scope.tenantId);
  return c.json({ ...scale, role: me?.role ?? 'staff' });
});

/** Удаление кабинета. Право проверяет база, а не этот маршрут. */
doctor.delete('/cabinet', async (c) => {
  const scope = c.get('scope');
  try {
    const res = await scope.rpc<Record<string, unknown>>('delete_own_cabinet', {
      p_tenant_id: scope.tenantId, p_subject: c.get('identity').subject,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Выход сотрудника. Владельцу закрыт — кабинет не остаётся без хозяина. */
doctor.post('/cabinet/leave', async (c) => {
  const scope = c.get('scope');
  try {
    const res = await scope.rpc<Record<string, unknown>>('leave_cabinet', {
      p_tenant_id: scope.tenantId, p_subject: c.get('identity').subject,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── Показ кабинета в поиске ─────────────────────────────────────────────────

/**
 * Карточка кабинета для поиска: что о нём увидят посторонние.
 *
 * Отдаём и текущие значения, и признак публикации: врач должен видеть в
 * точности то, что показывается пациентам, а не догадываться.
 */
doctor.get('/listing', async (c) => {
  const scope = c.get('scope');
  const t = await scope.rpc<Record<string, unknown>>('cabinet_listing', {
    p_tenant_id: scope.tenantId,
  });
  return c.json({ ...t, listed: Boolean(t?.listed) });
});

doctor.put('/listing', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{
    city?: string; address?: string; landmark?: string; phone?: string; listed?: boolean;
  }>().catch(() => ({} as Record<string, never>));
  try {
    const res = await scope.rpc<Record<string, unknown>>('set_cabinet_listing', {
      p_tenant_id: scope.tenantId,
      p_city: b.city ?? null,
      p_address: b.address ?? null,
      p_landmark: b.landmark ?? null,
      p_phone: b.phone ?? null,
      p_listed: b.listed === true,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── План лечения и деньги ───────────────────────────────────────────────────

/**
 * Планы пациента, долг и история платежей — одним запросом.
 *
 * Три вещи вместе, потому что смотрят на них вместе: план без долга не
 * говорит, дошло ли дело до денег, а долг без плана — за что он.
 */
doctor.get('/patients/:id/plans', async (c) => {
  const scope = c.get('scope');
  const pid = c.req.param('id');
  const [plans, balance, payments] = await Promise.all([
    scope.rpc<Record<string, unknown>[]>('patient_plans', { p_tenant_id: scope.tenantId, p_patient_id: pid }),
    scope.rpc<Record<string, unknown>>('patient_balance', { p_tenant_id: scope.tenantId, p_patient_id: pid }),
    scope.rpc<Record<string, unknown>[]>('patient_payments', { p_tenant_id: scope.tenantId, p_patient_id: pid }),
  ]);
  return c.json({
    plans: (plans ?? []).map((p) => ({
      id: p.id, title: p.title, status: p.status, createdAt: p.created_at,
      items: p.items, done: p.done,
      revenue: Number(p.revenue), cost: Number(p.cost),
      margin: Number(p.revenue) - Number(p.cost),
    })),
    balance: {
      billed: Number(balance?.billed ?? 0),
      paid: Number(balance?.paid ?? 0),
      debt: Number(balance?.debt ?? 0),
    },
    payments: (payments ?? []).map((x) => ({
      id: x.id, amount: Number(x.amount), method: x.method, note: x.note, at: x.created_at,
    })),
  });
});

/** Один план целиком: позиции, себестоимость по техкартам, маржа. */
doctor.get('/plans/:id', async (c) => {
  const scope = c.get('scope');
  const plan = await scope.rpc<Record<string, unknown> | null>('treatment_plan', {
    p_tenant_id: scope.tenantId, p_plan_id: c.req.param('id'),
  });
  if (!plan) return c.json({ error: 'план не найден' }, 404);
  return c.json(plan);
});

/**
 * Сохранение плана целиком, а не по одной позиции.
 *
 * План — это документ: врач собирает его за один заход, глядя на итог. Правка
 * по строке заставляла бы сохранять после каждого касания и показывала бы
 * маржу, посчитанную на полпути.
 */
doctor.post('/plans', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{
    planId?: string; patientId?: string; title?: string; status?: string; note?: string;
    items?: { serviceId: string; tooth?: string; quantity?: number; price?: number; stage?: number }[];
  }>().catch(() => ({} as Record<string, never>));

  if (!b.planId && !b.patientId) return c.json({ error: 'не указан пациент' }, 400);
  try {
    const res = await scope.rpc<Record<string, unknown>>('save_treatment_plan', {
      p_tenant_id: scope.tenantId,
      p_plan_id: b.planId ?? null,
      p_patient_id: b.patientId ?? null,
      p_title: b.title ?? '',
      p_status: b.status ?? null,
      p_note: b.note ?? null,
      p_items: b.items ?? [],
      p_by: c.get('identity').subject,
    });

    // План стал виден пациенту впервые — говорим об этом один раз.
    // Сумму берём из свежесохранённого плана, а не из тела запроса: в теле
    // цены может не быть вовсе, они подставляются из прайса.
    if (res?.activated) {
      const plan = await scope.rpc<Record<string, any> | null>('treatment_plan', {
        p_tenant_id: scope.tenantId, p_plan_id: res.planId,
      });
      await notifyPlanReady(
        c.env.TELEGRAM_BOT_TOKEN,
        (res.telegramSubject as string | null) ?? null,
        String(res.cabinet ?? ''), String(res.title ?? ''),
        Number(plan?.totals?.revenue ?? 0),
        c.env.MINIAPP_URL ?? 'https://stomiko-api.alrevion.workers.dev',
      );
    }
    return c.json(res);
  } catch (err) {
    const msg = (err as Error).message;
    // Нарушение ограничения на номер зуба доходит сюда текстом Postgres.
    // Показывать его врачу — то же самое, что показать стектрейс.
    if (msg.includes('tooth_check')) {
      return c.json({ error: 'Номер зуба указан не по FDI. Квадрант 1–8, зуб 1–8: например 26.' }, 400);
    }
    return c.json({ error: msg }, 400);
  }
});

doctor.delete('/plans/:id', async (c) => {
  try {
    await c.get('scope').rpc('delete_treatment_plan', {
      p_tenant_id: c.get('scope').tenantId, p_plan_id: c.req.param('id'),
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Платёж пациента. Долг = оказано минус внесено, счетов здесь нет. */
doctor.post('/patients/:id/payments', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ amount?: number; method?: string; note?: string }>()
    .catch(() => ({} as { amount?: number; method?: string; note?: string }));
  try {
    const res = await scope.rpc<Record<string, unknown>>('record_payment', {
      p_tenant_id: scope.tenantId,
      p_patient_id: c.req.param('id'),
      p_amount: b.amount ?? 0,
      p_method: b.method ?? 'cash',
      p_note: b.note ?? null,
      p_by: c.get('identity').subject,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── Техкарта ────────────────────────────────────────────────────────────────

/**
 * Техкарта услуги для правки.
 *
 * Отдаются ИСХОДНЫЕ строки версии, а не развёрнутый снимок: снимок неизменяем
 * по смыслу, и править его задним числом значило бы менять себестоимость уже
 * закрытых приёмов. Строки блоков показываются отдельно и только для чтения —
 * их состав правится на уровне библиотеки, иначе «сменил перчатки» превращается
 * в правку каждой карты по отдельности.
 */
doctor.get('/techcard/:serviceId', async (c) => {
  const scope = c.get('scope');
  const { data: svc } = await scope
    .select('services', 'id, name_ru, price, unit_of_norm, duration_minutes, techcard_version_id')
    .eq('id', c.req.param('serviceId')).maybeSingle();
  if (!svc) return c.json({ error: 'услуга не найдена' }, 404);

  const [ownRes, blockRes, materialsRes, unitsRes, groupsRes] = await Promise.all([
    scope.rpc<Record<string, unknown>[]>('techcard_own_lines', { p_version_id: svc.techcard_version_id }),
    scope.rpc<Record<string, unknown>[]>('techcard_block_summary', { p_version_id: svc.techcard_version_id }),
    scope.select('materials', 'id, name_ru, base_unit_id, reference_price').order('name_ru'),
    scope.select('units', 'id, code, name_ru, divisible'),
    scope.select('analog_groups', 'id, name'),
  ]);

  return c.json({
    service: svc,
    lines: ownRes,
    blocks: blockRes,
    materials: materialsRes.data ?? [],
    units: unitsRes.data ?? [],
    analogGroups: groupsRes.data ?? [],
  });
});

doctor.put('/techcard/:serviceId', async (c) => {
  const scope = c.get('scope');
  const body = await c.req.json<{
    lines: { materialId?: string | null; analogGroupId?: string | null; normQty: number; unitId: string; scalesWithQuantity?: boolean }[];
  }>();
  try {
    const res = await scope.rpc<Record<string, unknown>>('save_techcard_version', {
      p_service_id: c.req.param('serviceId'),
      p_lines: body.lines,
    });
    return c.json(res);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ── Склад ───────────────────────────────────────────────────────────────────

doctor.post('/shortfalls/:id/acknowledge', async (c) => {
  await acknowledgeShortfall(c.get('scope'), c.req.param('id'));
  return c.json({ ok: true });
});

// ── Публичная ссылка ────────────────────────────────────────────────────────

/**
 * Ссылка, по которой пациенты записываются сами.
 *
 * В URL уходит непрозрачный токен, а не id кабинета: по последовательному id
 * базу врачей перебрали бы инкрементом. Лимит Telegram — 64 символа base64url.
 */
doctor.get('/link', (c) => {
  const token = c.get('identity').publicToken;
  if (!token) return c.json({ error: 'ссылка не настроена' }, 404);
  const bot = c.env.TELEGRAM_BOT_USERNAME ?? 'stomiko_bot';
  return c.json({ token, link: `https://t.me/${bot}?startapp=${token}` });
});

/**
 * Одноразовое приглашение в кабинет.
 *
 * Живёт сутки и гаснет после первого использования. Постоянная ссылка на роль
 * врача — это постоянный доступ к выручке, себестоимости и базе пациентов.
 */
doctor.post('/invite', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');
  const token = await scope.rpc<string>('create_staff_invite', {
    p_tenant_id: scope.tenantId,
    p_created_by: identity.subject,
    p_hours: 24,
  });
  const bot = c.env.TELEGRAM_BOT_USERNAME ?? 'stomiko_bot';
  return c.json({ token, link: `https://t.me/${bot}?startapp=${token}`, expiresHours: 24 });
});

/**
 * Отправить напоминание немедленно.
 *
 * Автоматические напоминания уходят за сутки и за два часа. Эта ручка нужна,
 * чтобы врач мог напомнить прямо сейчас — например, если пациент опаздывает
 * или подтверждения не было.
 */
doctor.post('/appointments/:id/remind', async (c) => {
  const scope = c.get('scope');
  const identity = c.get('identity');

  const { data: appt } = await scope
    .select('appointments', 'id, starts_at, patients(full_name, telegram_subject, phone), services(name_ru)')
    .eq('id', c.req.param('id')).maybeSingle();
  if (!appt) return c.json({ error: 'запись не найдена' }, 404);

  const p = appt.patients as { full_name?: string; telegram_subject?: string; phone?: string } | null;
  if (!p?.telegram_subject) {
    return c.json({
      notified: false, reason: 'no_chat', phone: p?.phone ?? null,
      error: 'пациент не начинал чат с ботом — позвоните',
    }, 200);
  }

  const result = await notifyReminder(
    c.env.TELEGRAM_BOT_TOKEN, p.telegram_subject, identity.tenantName,
    (appt.services as { name_ru?: string } | null)?.name_ru ?? null,
    String(appt.starts_at), 'hour',
  );
  return c.json({ notified: result === 'sent', reason: result, phone: p.phone ?? null });
});
