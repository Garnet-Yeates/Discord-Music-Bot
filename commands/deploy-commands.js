import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v9';

export * from '../configure-environment.js';

import commands from './commands.js'

// This section of code loads up the command dictionary that is exported from commands.js and reads
// each key (same as command name) and pushes its corresponding builder as JSON to be deployed below

const commandBuilders = [];

for (let key in commands)
	commandBuilders.push(commands[key].commandBuilder.toJSON())

// This section of code does the actual deploying

const clientId = process.env.CLIENT_ID;
const guildId = process.env.DEV_GUILD_ID;
const token = process.env.BOT_TOKEN;

const rest = new REST({ version: '9' }).setToken(token);
rest.put(Routes.applicationGuildCommands(clientId, 721203380059373588n), { body: commandBuilders })
	.then(() => console.log('Successfully registered application commands.'))
	.catch(console.error);

rest.put(Routes.applicationGuildCommands(clientId, 924083165612613672n), { body: commandBuilders })
	.then(() => console.log('Successfully registered application commands.'))
	.catch(console.error);

rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandBuilders })
	.then(() => console.log('Successfully registered application commands.'))
	.catch(console.error);