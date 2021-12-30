

// Import the necessary discord.js classes
import { Client, Intents } from 'discord.js'

import commands from './commands/commands.js'

let aye = [];
aye[90] = 4;

// Create a new client instance and give it the intents that we need for this bot
const client = new Client({ intents: [Intents.FLAGS.GUILDS, "GUILD_MESSAGES", 'GUILD_VOICE_STATES'], partials: ["CHANNEL"] });

// This block makes it so command names (keys inside commands.js) are mapped to their respective 'execute' function 
client.on('interactionCreate', async (interaction) => {
    if (interaction.isCommand() && commands[interaction.commandName]) {
        await commands[interaction.commandName].execute(interaction);
    }
})

// When the client is ready, run this code (only once)
client.once('ready', () => {
	console.log('The bot is ready to listen to commands/messages!');
});


// Login to Discord with the client's token
await client.login(process.env.BOT_TOKEN);

export default client;