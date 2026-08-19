import { loadVipConfig } from './config.js';
import { registerCommands } from './bots/vipBot.js';

const config = loadVipConfig();
await registerCommands(config);
console.log('/vip and /vip-admin registered in guild', config.guildId);
