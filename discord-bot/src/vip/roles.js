import { roleIdsForTier } from '../lib/tiers.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('roles');

/**
 * Grants the roles for a tier plus every lower tier.
 * Tier 3 -> roles 1, 2 and 3. Tier 2 -> roles 1 and 2. Tier 1 -> role 1.
 *
 * @returns {Promise<{added: string[], already: string[], missing: string[], failed: {roleId: string, error: string}[]}>}
 */
export async function grantTierRoles(guild, userId, tier, config, reason = 'VIP payment confirmed') {
  const wanted = roleIdsForTier(tier, config.tiers);
  const result = { added: [], already: [], missing: [], failed: [] };

  const member = await guild.members.fetch(userId);

  for (const roleId of wanted) {
    const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      result.missing.push(roleId);
      log.warn(`Role ${roleId} does not exist in guild ${guild.id}`);
      continue;
    }
    if (member.roles.cache.has(roleId)) {
      result.already.push(roleId);
      continue;
    }
    try {
      await member.roles.add(role, reason);
      result.added.push(roleId);
    } catch (error) {
      result.failed.push({ roleId, error: error.message });
      log.error(`Could not add role ${roleId} to ${userId}: ${error.message}`);
    }
  }

  return result;
}

/** On startup, check that the configured roles exist and can be assigned. */
export async function checkRoleSetup(guild, config) {
  const problems = [];
  const me = await guild.members.fetchMe();

  for (const [tier, tierConfig] of Object.entries(config.tiers)) {
    if (!tierConfig.roleId) {
      problems.push(`Tier ${tier}: ROLE_TIER_${tier} is missing from .env`);
      continue;
    }
    const role = await guild.roles.fetch(tierConfig.roleId).catch(() => null);
    if (!role) {
      problems.push(`Tier ${tier}: role ${tierConfig.roleId} does not exist in this server`);
      continue;
    }
    if (role.position >= me.roles.highest.position) {
      problems.push(
        `Tier ${tier}: role "${role.name}" sits above the bot's own role; move it below or the bot cannot assign it`,
      );
    }
  }

  return problems;
}
