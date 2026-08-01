import { roleIdsForTier } from '../lib/tiers.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('roles');

/**
 * Otorga los roles de un tier y de todos los tiers inferiores.
 * Tier 3 -> roles 1, 2 y 3. Tier 2 -> roles 1 y 2. Tier 1 -> rol 1.
 *
 * @returns {Promise<{added: string[], already: string[], missing: string[], failed: {roleId: string, error: string}[]}>}
 */
export async function grantTierRoles(guild, userId, tier, config, reason = 'Pago VIP confirmado') {
  const wanted = roleIdsForTier(tier, config.tiers);
  const result = { added: [], already: [], missing: [], failed: [] };

  const member = await guild.members.fetch(userId);

  for (const roleId of wanted) {
    const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      result.missing.push(roleId);
      log.warn(`El rol ${roleId} no existe en el servidor ${guild.id}`);
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
      log.error(`No se pudo asignar el rol ${roleId} a ${userId}: ${error.message}`);
    }
  }

  return result;
}

/** Comprueba al arrancar que los roles configurados existen y son asignables. */
export async function checkRoleSetup(guild, config) {
  const problems = [];
  const me = await guild.members.fetchMe();

  for (const [tier, tierConfig] of Object.entries(config.tiers)) {
    if (!tierConfig.roleId) {
      problems.push(`Tier ${tier}: falta ROLE_TIER_${tier} en el .env`);
      continue;
    }
    const role = await guild.roles.fetch(tierConfig.roleId).catch(() => null);
    if (!role) {
      problems.push(`Tier ${tier}: el rol ${tierConfig.roleId} no existe en el servidor`);
      continue;
    }
    if (role.position >= me.roles.highest.position) {
      problems.push(
        `Tier ${tier}: el rol "${role.name}" esta por encima del rol del bot; muevelo mas abajo o el bot no podra asignarlo`,
      );
    }
  }

  return problems;
}
