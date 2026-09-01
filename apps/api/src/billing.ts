import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './db.js';

/**
 * Подписка.
 *
 * Ядро не знает о провайдерах. Единственный вопрос, который задаёт
 * приложение, — «оплачено до какого числа», и это локальное чтение: на
 * горячем пути ни одного обращения наружу, поэтому подвисший провайдер не
 * может уронить приём пациента.
 *
 * Провайдер — адаптер с тремя обязанностями: выставить счёт, принять
 * подтверждение, опознать плательщика. Все они сходятся в одну функцию
 * `credit_subscription`, идемпотентную по паре (провайдер, внешний id).
 */

export interface SubscriptionState {
  status: 'trial' | 'active';
  paidUntil: string;
  frozen: boolean;
  daysLeft: number;
  lastDay: boolean;
  plan: string | null;
}

export interface Plan {
  code: string;
  name_ru: string;
  months: number;
  price_uzs: number;
  price_stars: number | null;
}

export async function subscriptionState(
  sb: SupabaseClient, tenantId: string,
): Promise<SubscriptionState | null> {
  const { data } = await sb.rpc('subscription_state', { p_tenant_id: tenantId });
  return (data as SubscriptionState | null) ?? null;
}

/**
 * Счёт на оплату.
 *
 * Без подключённого платёжного провайдера Telegram умеет принимать только
 * звёзды: у них валюта XTR и пустой provider_token. Это единственный способ,
 * который работает БЕЗ договора и юрлица, поэтому он и стоит по умолчанию.
 * Появится договор с Payme или Click — сюда придёт второй адаптер, ядро
 * не изменится.
 */
export async function sendInvoice(
  env: Env, chatId: string, tenantId: string, plan: Plan,
): Promise<{ ok: boolean; error?: string }> {
  const fiat = env.TELEGRAM_PROVIDER_TOKEN;
  const useStars = !fiat;

  if (useStars && !plan.price_stars) {
    return { ok: false, error: 'у этого плана нет цены в звёздах' };
  }

  const body = {
    chat_id: chatId,
    title: `Stomiko — ${plan.name_ru}`,
    description: `Доступ к кабинету на ${plan.months === 1 ? 'месяц'
      : plan.months === 12 ? 'год' : `${plan.months} месяцев`}`,
    // Полезная нагрузка возвращается в подтверждении оплаты и по ней мы
    // опознаём плательщика. Идентификатор кабинета берём отсюда, а не из
    // чата: платить может и приглашённый сотрудник.
    payload: JSON.stringify({ t: tenantId, p: plan.code, m: plan.months }),
    provider_token: useStars ? '' : fiat,
    currency: useStars ? 'XTR' : 'UZS',
    prices: [{
      label: plan.name_ru,
      // У звёзд amount — это число звёзд; у фиата — минорные единицы.
      amount: useStars ? plan.price_stars! : Math.round(Number(plan.price_uzs) * 100),
    }],
  };

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendInvoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);

  const json = (await res?.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (json?.ok) return { ok: true };
  return { ok: false, error: json?.description ?? 'Telegram не принял счёт' };
}

/**
 * Подтверждение оплаты от Telegram.
 *
 * Клиенту не верим никогда: Mini App не может сказать «я оплатил». Сюда
 * приходит сервер Telegram, и только он.
 *
 * `telegram_payment_charge_id` служит внешним идентификатором: повторный
 * вебхук при таймауте не должен продлевать подписку дважды.
 */
export async function creditTelegramPayment(
  sb: SupabaseClient,
  payment: {
    invoice_payload?: string;
    total_amount?: number;
    currency?: string;
    telegram_payment_charge_id?: string;
  },
  paidBy: string,
): Promise<{ credited: boolean; paidUntil?: string; error?: string }> {
  let parsed: { t?: string; p?: string; m?: number };
  try {
    parsed = JSON.parse(payment.invoice_payload ?? '{}');
  } catch {
    return { credited: false, error: 'нераспознанная нагрузка счёта' };
  }
  if (!parsed.t || !parsed.m) return { credited: false, error: 'в счёте нет кабинета' };

  const charge = payment.telegram_payment_charge_id;
  if (!charge) return { credited: false, error: 'нет идентификатора платежа' };

  const { data, error } = await sb.rpc('credit_subscription', {
    p_tenant_id: parsed.t,
    p_months: parsed.m,
    p_provider: payment.currency === 'XTR' ? 'telegram_stars' : 'telegram',
    p_external_id: charge,
    p_amount: payment.total_amount ?? null,
    p_currency: payment.currency ?? null,
    p_paid_by: paidBy,
    p_plan_code: parsed.p ?? null,
  });
  if (error) return { credited: false, error: error.message };

  const r = data as { credited: boolean; paidUntil: string };
  return { credited: r.credited, paidUntil: r.paidUntil };
}
