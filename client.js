

// Import the necessary discord.js classes
import { generateDependencyReport } from '@discordjs/voice';
import { Client, Intents } from 'discord.js'

import commands from './commands/commands.js'

console.log(generateDependencyReport())

// Create a new client instance
//"GUILD_MESSAGES", "DIRECT_MESSAGES"
const client = new Client({ intents: [Intents.FLAGS.GUILDS, "GUILD_MESSAGES", "DIRECT_MESSAGES", 'GUILD_VOICE_STATES'], partials: ["CHANNEL"] });

// This will read any incoming interactions for the bot. If the interaction is a command whose name is equal to any of the keys defined in the object above,
// then it will call the 'execute' function described in that command object, passing in the 'interaction' parameter 
client.on('interactionCreate', async (interaction) => {
    if (interaction.isCommand() && commands[interaction.commandName]) {
        await commands[interaction.commandName].execute(interaction);
    }
})

// When the client is ready, run this code (only once)
client.once('ready', () => {
	console.log('The bot is ready to listen to commands/messages!');
});

client.on("messageCreate", async msg => {
//	!msg.author.bot && msg.reply("Hi");

	if (!msg.author.bot)
	{
		// This is a test 'command' (not even rlly a command) just to make sure my getPlaylistTrackNamesAsync function works properly
		if (msg.content.startsWith("spotify "))
		{
			const url = msg.content.slice(8).trim();
			msg.reply("you give playlist link? here are the songs on it: ")

	
		}
	}
});

// Login to Discord with the client's token
await client.login(process.env.BOT_TOKEN);

export default client;