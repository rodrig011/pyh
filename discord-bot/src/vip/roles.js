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

/**
 * Takes back the roles of a tier (and the tiers below it) when a membership
 * ends. A member who already left the guild is not an error: there is nothing
 * to take back.
 *
 * @returns {Promise<{removed: string[], absent: boolean, failed: {roleId: string, error: string}[]}>}
 */
export async function revokeTierRoles(guild, userId, tier, config, reason = 'VIP subscription expired') {
  const result = { removed: [], absent: false, failed: [] };
  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) {
    result.absent = true;
    log.info(`${userId} is no longer in guild ${guild.id}; nothing to revoke`);
    return result;
  }

  for (const roleId of roleIdsForTier(tier, config.tiers)) {
    if (!member.roles.cache.has(roleId)) continue;
    try {
      await member.roles.remove(roleId, reason);
      result.removed.push(roleId);
    } catch (error) {
      result.failed.push({ roleId, error: error.message });
      log.error(`Could not remove role ${roleId} from ${userId}: ${error.message}`);
    }
  }

  return result;
}

/**
 * Two tiers pointing at the same role is almost always a copy-paste slip, and a
 * costly one: the higher tier would deliver exactly what the cheaper one does,
 * with nothing to tell the buyers apart. Worth shouting about at startup.
 *
 * @returns {string[]} one line per clash
 */
export function duplicateRoleProblems(tiersConfig) {
  const seen = new Map();
  const problems = [];

  for (const tier of Object.keys(tiersConfig).map(Number).sort((a, b) => a - b)) {
    const roleId = tiersConfig[tier]?.roleId;
    if (!roleId) continue;
    if (seen.has(roleId)) {
      problems.push(
        `Tier ${tier} uses the same role as tier ${seen.get(roleId)} (${roleId}): ` +
          `buyers of both tiers would end up with identical access. Give each tier its own role.`,
      );
    } else {
      seen.set(roleId, tier);
    }
  }

  return problems;
}

/** On startup, check that the configured roles exist and can be assigned. */
export async function checkRoleSetup(guild, config) {
  const problems = [...duplicateRoleProblems(config.tiers)];
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
