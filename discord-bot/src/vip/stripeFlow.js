import { EmbedBuilder, time } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { SUBSCRIPTION_STATUS } from '../lib/subscriptions.js';
import { TIER_NAMES } from '../lib/tiers.js';
import { fetchSubscriptionState } from '../payments/stripe.js';
import { sendDm, sendLog } from './notify.js';
import { processPayment } from './paymentFlow.js';
import { revokeTierRoles } from './roles.js';
import { endSubscription } from './subscriptions.js';

const log = createLogger('stripe-flow');

function findByStripeId(store, subscriptionId) {
  return store.listSubscriptions((sub) => sub.stripeSubscriptionId === subscriptionId)[0] ?? null;
}

/**
 * Applies one interpreted Stripe event.
 *
 * Activation goes through the same processPayment path as Zelle, so card and
 * bank payments grant roles, write the audit log and DM the buyer identically.
 * The difference is what happens afterwards: a card membership renews itself,
 * so it is flagged autoRenew and its expiry follows Stripe's billing period.
 */
export async function applyStripeIntent(client, store, config, intent, stripe) {
  switch (intent.action) {
    case 'activate': {
      if (!intent.code) return { status: 'no_code', reason: 'checkout without an order code' };

      const result = await processPayment(client, store, config, {
        codes: [intent.code],
        amountCents: intent.amountCents,
        source: 'stripe',
        senderName: 'Card payment',
        reference: intent.subscriptionId ?? null,
      });
      if (result.status !== 'granted') return result;

      const subscription = result.subscription;
      subscription.source = 'stripe';
      subscription.autoRenew = true;
      subscription.stripeSubscriptionId = intent.subscriptionId ?? null;
      subscription.stripeCustomerId = intent.customerId ?? null;

      // Let Stripe's billing period drive the expiry when we can read it.
      if (stripe && intent.subscriptionId) {
        const state = await fetchSubscriptionState(stripe, intent.subscriptionId).catch(() => null);
        if (state?.currentPeriodEnd) subscription.expiresAt = state.currentPeriodEnd;
      }
      store.putSubscription(subscription);

      log.info(`Card membership active for ${subscription.userId} (${intent.subscriptionId})`);
      return { status: 'granted', subscription };
    }

    case 'renew': {
      const subscription = findByStripeId(store, intent.subscriptionId);
      if (!subscription) return { status: 'unknown_subscription', reason: intent.subscriptionId };

      subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
      subscription.expiresAt = intent.periodEnd
        ? intent.periodEnd * 1000
        : subscription.expiresAt + config.subscriptionDays * 86400000;
      subscription.renewedAt = Date.now();
      subscription.renewals = (subscription.renewals ?? 0) + 1;
      subscription.remindersSent = [];
      subscription.endedAt = null;
      subscription.endedReason = null;
      store.putSubscription(subscription);

      await sendLog(
        client,
        config,
        new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('Card membership renewed')
          .setDescription(`<@${subscription.userId}> — **${TIER_NAMES[subscription.tier]}**`)
          .addFields({ name: 'Paid through', value: time(Math.floor(subscription.expiresAt / 1000), 'f') })
          .setTimestamp(),
      );

      log.info(`Card membership renewed for ${subscription.userId} until ${new Date(subscription.expiresAt).toISOString()}`);
      return { status: 'renewed', subscription };
    }

    case 'cancel': {
      const subscription = findByStripeId(store, intent.subscriptionId);
      if (!subscription) return { status: 'unknown_subscription', reason: intent.subscriptionId };
      if (subscription.status !== SUBSCRIPTION_STATUS.ACTIVE) {
        return { status: 'already_ended', subscription };
      }

      const guild = await client.guilds.fetch(subscription.guildId);
      const revoked = await revokeTierRoles(guild, subscription.userId, subscription.tier, config, 'Card subscription ended');
      endSubscription(store, subscription, {
        status: SUBSCRIPTION_STATUS.EXPIRED,
        reason: intent.reason ?? 'stripe cancelled',
      });

      await sendDm(
        client,
        subscription.userId,
        new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('Your card membership ended')
          .setDescription(
            `Your **${TIER_NAMES[subscription.tier]}** subscription is no longer active, so the roles were removed.\n` +
              'You can start again any time with `/vip buy`.',
          )
          .setTimestamp(),
      );

      await sendLog(
        client,
        config,
        new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('Card membership cancelled')
          .setDescription(`<@${subscription.userId}> lost **${TIER_NAMES[subscription.tier]}** — ${intent.reason}`)
          .addFields({ name: 'Roles removed', value: String(revoked.removed.length), inline: true })
          .setTimestamp(),
      );

      log.info(`Card membership cancelled for ${subscription.userId}: ${intent.reason}`);
      return { status: 'revoked', subscription };
    }

    case 'autorenew_off': {
      const subscription = findByStripeId(store, intent.subscriptionId);
      if (!subscription) return { status: 'unknown_subscription', reason: intent.subscriptionId };

      // Access runs to the end of the paid period, but it will not renew — so
      // the normal countdown reminders should start firing again.
      subscription.autoRenew = false;
      if (intent.periodEnd) subscription.expiresAt = intent.periodEnd * 1000;
      subscription.remindersSent = [];
      store.putSubscription(subscription);

      log.info(`Auto-renew off for ${subscription.userId}; access until ${new Date(subscription.expiresAt).toISOString()}`);
      return { status: 'autorenew_off', subscription };
    }

    default:
      return { status: 'ignored', reason: intent.reason };
  }
}
