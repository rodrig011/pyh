import Stripe from 'stripe';
import { createLogger } from '../lib/logger.js';
import { tierTitle } from '../lib/tiers.js';

const log = createLogger('stripe');

export function createStripeClient(config) {
  if (!config.stripe.enabled) return null;
  if (!config.stripe.secretKey) {
    log.warn('STRIPE_SECRET_KEY missing: card payments stay off');
    return null;
  }
  return new Stripe(config.stripe.secretKey);
}

/**
 * Opens a card checkout that bills automatically every period.
 *
 * The price is built inline from TIER_n_PRICE and SUBSCRIPTION_DAYS, so nothing
 * has to be set up by hand in the Stripe dashboard and the card plan can never
 * drift away from the Zelle one.
 *
 * The order code travels in client_reference_id and in the subscription
 * metadata, which is what ties a Stripe customer back to a Discord member.
 */
export async function createSubscriptionCheckout(stripe, { config, order }) {
  const tier = config.tiers[order.tier];
  const metadata = {
    code: order.code,
    guildId: order.guildId,
    userId: order.userId,
    tier: String(order.tier),
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    client_reference_id: order.code,
    metadata,
    subscription_data: { metadata },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: config.stripe.currency,
          unit_amount: tier.priceCents,
          recurring: { interval: 'day', interval_count: config.subscriptionDays },
          product_data: {
            name: tierTitle(order.tier, config.tiers),
            description: (tier.perks ?? []).join(' · ').replace(/\*\*/g, '').slice(0, 300) || undefined,
          },
        },
      },
    ],
    success_url: config.stripe.successUrl,
    cancel_url: config.stripe.cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });

  return session;
}

/**
 * Turns a Stripe webhook event into an intent this bot understands.
 * Pure on purpose: every branch here is worth testing without touching Stripe.
 *
 * @returns {{action: 'activate'|'renew'|'cancel'|'autorenew_off'|'ignore', reason?: string, [key: string]: any}}
 */
export function interpretStripeEvent(event) {
  const object = event?.data?.object ?? {};

  switch (event?.type) {
    case 'checkout.session.completed': {
      if (object.mode !== 'subscription') return { action: 'ignore', reason: 'not a subscription checkout' };
      if (object.payment_status === 'unpaid') return { action: 'ignore', reason: 'checkout not paid' };
      return {
        action: 'activate',
        code: object.client_reference_id ?? object.metadata?.code ?? null,
        guildId: object.metadata?.guildId ?? null,
        userId: object.metadata?.userId ?? null,
        tier: object.metadata?.tier ? Number(object.metadata.tier) : null,
        subscriptionId: typeof object.subscription === 'string' ? object.subscription : object.subscription?.id,
        customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id,
        amountCents: object.amount_total ?? null,
      };
    }

    case 'invoice.paid': {
      // The first invoice arrives with the checkout; activation already handled it.
      if (object.billing_reason === 'subscription_create') {
        return { action: 'ignore', reason: 'first invoice, handled by checkout' };
      }
      const subscriptionId =
        typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
      if (!subscriptionId) return { action: 'ignore', reason: 'invoice without subscription' };
      return {
        action: 'renew',
        subscriptionId,
        amountCents: object.amount_paid ?? null,
        periodEnd: object.lines?.data?.[0]?.period?.end ?? object.period_end ?? null,
      };
    }

    case 'customer.subscription.deleted':
      return { action: 'cancel', subscriptionId: object.id, reason: 'subscription ended at Stripe' };

    case 'customer.subscription.updated': {
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(object.status)) {
        return { action: 'cancel', subscriptionId: object.id, reason: `subscription is ${object.status}` };
      }
      if (object.cancel_at_period_end) {
        return {
          action: 'autorenew_off',
          subscriptionId: object.id,
          periodEnd: object.current_period_end ?? null,
          reason: 'member cancelled; access runs to the end of the period',
        };
      }
      return { action: 'ignore', reason: `subscription is ${object.status}` };
    }

    default:
      return { action: 'ignore', reason: `unhandled event ${event?.type}` };
  }
}

/** Asks Stripe whether a subscription is still live. Used before revoking anyone. */
export async function fetchSubscriptionState(stripe, subscriptionId) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  return {
    active: ['active', 'trialing', 'past_due'].includes(subscription.status),
    status: subscription.status,
    currentPeriodEnd: subscription.current_period_end ? subscription.current_period_end * 1000 : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  };
}

/** Cancels at Stripe so a revoked member is not charged again. */
export async function cancelStripeSubscription(stripe, subscriptionId) {
  try {
    await stripe.subscriptions.cancel(subscriptionId);
    return true;
  } catch (error) {
    log.warn(`Could not cancel Stripe subscription ${subscriptionId}: ${error.message}`);
    return false;
  }
}
