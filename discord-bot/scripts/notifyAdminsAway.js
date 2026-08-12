import { Client, GatewayIntentBits } from 'discord.js';
import { loadVipConfig } from '../src/config.js';

/**
 * A one-off, not a permanent bot command on purpose. Rodrigo lost phone and
 * Discord access and asked for a single DM to whoever holds an admin role,
 * saying he'll be back in a few days — nothing about money, nothing that
 * needs a standing "DM any role anything" capability sitting in the bot
 * forever. Run once via `node scripts/notifyAdminsAway.js` in the same
 * environment the bot itself runs in (it reuses VIP_BOT_TOKEN, VIP_GUILD_ID
 * and the already-configured admin/mod role ids — nothing new to set).
 */

const MESSAGE = [
  "Hey my dear admins, I'm in a really uncomfortable position right now. My phone just died and I'm basically unreachable at the moment.",
  "I'm using my work computer, which has Discord blocked.",
  "If any of you could spot me $50, which is what I need to get access to a phone again, I'd really appreciate it.",
  "I have my physical cards, but my money is in savings, so I can't access it right now.",
  "If someone's willing to help me out, you can use my Cash App.",
  "",
  "Love you all. If nobody can help me out, I'll see you guys again in 2-3 days.",
  "",
  "-Rodrigo"
].join('\n');

async function main() {
  const config = loadVipConfig();
  if (!config.modRoleIds?.length) {
    console.error('No admin/mod role configured (VIP_MOD_ROLE_IDS / VIP_ADMIN_ROLE_IDS) — nothing to send to.');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  await client.login(config.token);
  await new Promise((resolve) => client.once('ready', resolve));

  const guild = await client.guilds.fetch(config.guildId);
  const members = await guild.members.fetch();
  const targets = members.filter((member) => config.modRoleIds.some((roleId) => member.roles.cache.has(roleId)));

  console.log(`Found ${targets.size} member(s) with an admin role.`);

  let sent = 0;
  let failed = 0;
  for (const member of targets.values()) {
    try {
      await member.send(MESSAGE);
      console.log(`Sent to ${member.user.tag} (${member.id})`);
      sent += 1;
    } catch (error) {
      console.log(`FAILED for ${member.user.tag} (${member.id}): ${error.message}`);
      failed += 1;
    }
  }

  console.log(`Done. ${sent} sent, ${failed} failed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`Script failed: ${error.message}`);
  process.exit(1);
});
