import { loadVipConfig } from './config.js';
import { registerCommands } from './bots/vipBot.js';

const config = loadVipConfig();
await registerCommands(config);
console.log('Comandos /vip y /vip-admin registrados en el servidor', config.guildId);
