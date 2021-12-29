// Entry point for our bot
// First configures dotenv
// Then it loads client.js which initializes, logs in, and exports the client
// Afterwards it loads up all the commands/handlers as defined in commands.js

export * from './configure-environment.js';
export * from './client.js';
export * from './commands/commands.js';