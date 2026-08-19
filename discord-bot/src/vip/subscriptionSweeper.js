import { EmbedBuilder, time } from 'discord.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { SUBSCRIPTION_STATUS, dueReminder, isExpired } from '../lib/subscriptions.js';
import { TIER_NAMES, formatMoney } from '../lib/tiers.js';
import { fetchSubscriptionState } from '../payments/stripe.js';
import { sendDm, sendLog } from './notify.js';
import { revokeTierRoles } from './roles.js';
import { endSubscription, markReminded } from './subscriptions.js';

const log = createLogger('subs');

function renewHint(tier, config) {
  return `Renew with \`/vip buy tier:${tier}\` (${formatMoney(config.tiers[tier].priceCents)} for ${config.subscriptionDays} days).`;
}

function reminderEmbed(subscription, threshold, config) {
  return new EmbedBuilder()
    .setColor(COLORS.pending)
    .setTitle(`Your ${TIER_NAMES[subscription.tier]} ends in ${threshold} day${threshold === 1 ? '' : 's'}`)
    .setDescription(
      [
        `This is a **${config.subscriptionDays}-day membership**. Yours expires ${time(Math.floor(subscription.expiresAt / 1000), 'R')} (${time(Math.floor(subscription.expiresAt / 1000), 'f')}).`,
        '',
        'If it is not renewed by then, the bot removes your VIP roles automatically.',
        renewHint(subscription.tier, config),
      ].join('\n'),
    )
    .setTimestamp();
}

function expiredEmbed(subscription, config, removed) {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('Your VIP membership expired')
    .setDescription(
      [
        `Your **${TIER_NAMES[subscription.tier]}** ran out, so ${removed ? 'your VIP roles were removed' : 'your access ended'}.`,
        '',
        `Thanks for the ${subscription.renewals > 0 ? `${subscription.renewals + 1} periods` : 'support'} — you can come back any time.`,
        renewHint(subscription.tier, config),
      ].join('\n'),
    )
    .setTimestamp();
}

/**
 * One pass over every membership: warns the ones about to run out and takes the
 * roles back from the ones that already did.
 *
 * Safe to run often — reminders are recorded so they are sent once, and an
 * expired membership is only processed the first time.
 *
 * @returns {Promise<{reminded: number, expired: number, failed: number}>}
 */
export async function sweepSubscriptions(client, store, config, now = Date.now(), stripe = null) {
  const result = { reminded: 0, expired: 0, failed: 0, reconciled: 0 };

  const open = store.listSubscriptions(
    (subscription) => subscription.status === SUBSCRIPTION_STATUS.ACTIVE,
  );

  for (const subscription of open) {
    try {
      if (isExpired(subscription, now, config.subscriptionGraceDays)) {
        // A card membership renews itself. Before taking anyone's roles, ask
        // Stripe directly — a webhook we never received must not cost a paying
        // member their access.
        if (stripe && subscription.stripeSubscriptionId) {
          const state = await fetchSubscriptionState(stripe, subscription.stripeSubscriptionId).catch(
            () => null,
          );
          if (state?.active && state.currentPeriodEnd > now) {
            subscription.expiresAt = state.currentPeriodEnd;
            subscription.autoRenew = !state.cancelAtPeriodEnd;
            subscription.remindersSent = [];
            store.putSubscription(subscription);
            result.reconciled += 1;
            log.warn(
              `Missed renewal webhook for ${subscription.userId}; Stripe says paid through ${new Date(state.currentPeriodEnd).toISOString()}`,
            );
            continue;
          }
        }

        const guild = await client.guilds.fetch(subscription.guildId);
        const revoked = await revokeTierRoles(guild, subscription.userId, subscription.tier, config);

        endSubscription(store, subscription, { status: SUBSCRIPTION_STATUS.EXPIRED, reason: 'not renewed', now });
        result.expired += 1;

        await sendDm(client, subscription.userId, expiredEmbed(subscription, config, revoked.removed.length > 0));
        await sendLog(
          client,
          config,
          new EmbedBuilder()
            .setColor(COLORS.warning)
            .setTitle('Membership expired')
            .setDescription(`<@${subscription.userId}> lost **${TIER_NAMES[subscription.tier]}**`)
            .addFields(
              { name: 'Roles removed', value: String(revoked.removed.length), inline: true },
              { name: 'Still in server', value: revoked.absent ? 'no' : 'yes', inline: true },
            )
            .setTimestamp(),
        );

        log.info(`Subscription expired: ${subscription.userId} (${revoked.removed.length} role(s) removed)`);
        continue;
      }

      // A card subscription bills itself, so nagging about renewal would be
      // wrong. Reminders come back if the member cancels auto-renew.
      if (subscription.autoRenew) continue;

      const reminder = dueReminder(subscription, now, config.reminderDaysBefore);
      if (reminder) {
        const sent = await sendDm(client, subscription.userId, reminderEmbed(subscription, reminder.send, config));
        // Mark it either way: a user with closed DMs should not be retried forever.
        markReminded(store, subscription, reminder.cover);
        if (sent) result.reminded += 1;
        log.info(`Reminder (${reminder.send}d) for ${subscription.userId}: ${sent ? 'sent' : 'DMs closed'}`);
      }
    } catch (error) {
      result.failed += 1;
      log.error(`Could not process the membership of ${subscription.userId}: ${error.message}`);
    }
  }

  return result;
}
