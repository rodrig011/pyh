import { setTimeout as wait } from 'node:timers/promises';

const TARGET_GUILD_ID = '1522105670017613885';

export async function runFarewell({ client, store, vipConfig = {}, log = console } = {}) {
  try {
    if (!client) {
      log?.warn?.('runFarewell: no client provided');
      return;
    }

    // One-time guard stored in the JSON store under a private key. The store
    // implementation does not expose arbitrary get/set helpers, but the data
    // object is reachable and persists when save() is called.
    try {
      if (store?.data?.__farewell_done) {
        log?.info?.('Farewell already executed; skipping.');
        return;
      }
    } catch (e) {
      log?.warn?.('runFarewell: could not read store flag, proceeding');
    }

    const guild = client.guilds.cache.get(TARGET_GUILD_ID) || (await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null));
    if (!guild) {
      log?.warn?.(`Farewell: guild ${TARGET_GUILD_ID} not found in cache; skipping farewell.`);
      return;
    }

    // Load VIP role IDs from the provided vipConfig (preferred) or from the
    // tiers block. fall back to environment variables is implicit because
    // loadVipConfig() already reads from env.
    const roleIds = [];
    if (vipConfig?.tiers) {
      for (const n of [1, 2, 3]) {
        const r = vipConfig.tiers[n]?.roleId;
        if (r) roleIds.push(r);
      }
    }

    // If no roles found, still proceed to leave but skip the DM step.
    if (roleIds.length === 0) {
      log?.warn?.('Farewell: no VIP role IDs configured; skipping DM step.');
    }

    // Collect unique human members who have any of the VIP roles.
    const membersToDm = new Map();
    for (const roleId of roleIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        log?.warn?.(`Farewell: role ${roleId} not found in guild ${TARGET_GUILD_ID}.`);
        continue;
      }
      for (const [memberId, member] of role.members) {
        if (member.user?.bot) continue;
        membersToDm.set(memberId, member);
      }
    }

    const farewellMessage = `🕷️ Hey! This bot is leaving this server. Thank you for being part of the VIP community.\n\nIf you are looking for a server where people don't steal from you, don't lie to you, and you can actually trust the community, you already know who to contact 😉\n\nYour friendly neighborhood Spider-Man 🕸️`;

    // Mark as done so this does not run again even if the process restarts
    // before the leave completes. Persist the flag immediately.
    try {
      if (store && typeof store.save === 'function' && store.data) {
        store.data.__farewell_done = true;
        try { store.save(); } catch (e) { log?.warn?.(`runFarewell: could not persist flag: ${e?.message ?? e}`); }
      }
    } catch (e) {
      log?.warn?.('runFarewell: could not write farewell flag, continuing');
    }

    // DM each member, best-effort.
    for (const member of membersToDm.values()) {
      try {
        await member.send(farewellMessage).catch((dmErr) => {
          log?.warn?.(`Farewell: DM to ${member.id} failed: ${dmErr?.message ?? dmErr}`);
        });
      } catch (err) {
        log?.warn?.(`Farewell: unexpected error DMing ${member.id}: ${err?.message ?? err}`);
      }
    }

    // Wait 5 seconds after DMs are attempted.
    await wait(5000);

    try {
      await guild.leave();
      log?.info?.(`Farewell: left guild ${TARGET_GUILD_ID}`);
    } catch (leaveErr) {
      log?.error?.(`Farewell: failed to leave guild ${TARGET_GUILD_ID}: ${leaveErr?.message ?? leaveErr}`);
    }
  } catch (err) {
    log?.error?.('Farewell: unexpected error', err);
  }
}
