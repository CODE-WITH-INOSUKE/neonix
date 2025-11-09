import 'dotenv/config';
import { Client } from 'discord.js-selfbot-v13';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadDatabase, saveDatabase } from './functions/database.js';
import Lavalink from './functions/lavalink.js';
import queueManager from './functions/queue.js';
import { pendingCloneOperations } from './commands/tools/clone.js';
import { initializeRPC } from './commands/tools/rpc.js';
import { initializeCloners } from './commands/tools/msgclone.js';
import { initializeAutoReact } from './commands/tools/autoreact.js';
import { initializeWelcome } from './commands/tools/welcome.js';
import { initializeAutoMod } from './commands/tools/automod.js';
import { initializeGiveaways } from './commands/tools/giveaway.js';
import { initializeAI } from './commands/ai/chat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  checkUpdate: false
});

// Initialize Lavalink
const lavalink = new Lavalink({
  restHost: process.env.LAVALINK_REST,
  wsHost: process.env.LAVALINK_WS,
  password: process.env.LAVALINK_PASSWORD,
  clientName: process.env.CLIENT_NAME || 'NeonixSelfbot',
});

// Voice states storage
const voiceStates = {};

// Initialize collections
client.commands = new Map();
client.aliases = new Map();
client.cooldowns = new Map();
client.deletedMessages = new Map();

// Attach lavalink, queue, and voiceStates to client
client.lavalink = lavalink;
client.queueManager = queueManager;
client.voiceStates = voiceStates;

// Load database
client.db = loadDatabase();

// Initialize no-prefix mode if not exists
if (client.db.noPrefixMode === undefined) {
  client.db.noPrefixMode = false;
  saveDatabase(client.db);
}

// Load all commands from categories
const categoriesPath = path.join(__dirname, 'commands');
const categories = fs.readdirSync(categoriesPath).filter(file => {
  return fs.statSync(path.join(categoriesPath, file)).isDirectory();
});

console.log('╭─────────────────────────╮');
console.log('│  Loading Commands...    │');
console.log('╰─────────────────────────╯\n');

for (const category of categories) {
  const commandsPath = path.join(categoriesPath, category);
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = await import(`file://${filePath}`);
    const cmd = command.default;
    
    if (cmd.name) {
      client.commands.set(cmd.name, cmd);
      console.log(`✓ Loaded: ${cmd.name} (${category})`);
      
      // Register aliases
      if (cmd.aliases && Array.isArray(cmd.aliases)) {
        cmd.aliases.forEach(alias => {
          client.aliases.set(alias, cmd.name);
        });
      }
    }
  }
}

console.log(`\n✓ Loaded ${client.commands.size} files\n`);

// Store deleted messages for snipe command
client.on('messageDelete', message => {
  if (!message || !message.channel || message.partial || !message.content) return;
  
  const channelId = message.channel.id;
  client.deletedMessages.set(channelId, {
    content: message.content,
    author: message.author.tag,
    authorId: message.author.id,
    timestamp: Date.now()
  });
  
  // Clear after 60 seconds
  setTimeout(() => {
    client.deletedMessages.delete(channelId);
  }, 60000);
});

// Voice state handling for Lavalink
client.ws.on('VOICE_STATE_UPDATE', (packet) => {
  if (packet.user_id !== client.user.id) return;
  
  const guildId = packet.guild_id;
  if (!voiceStates[guildId]) voiceStates[guildId] = {};
  voiceStates[guildId].sessionId = packet.session_id;
  console.log(`[Voice] State update for guild ${guildId}`);
});

client.ws.on('VOICE_SERVER_UPDATE', (packet) => {
  const guildId = packet.guild_id;
  if (!voiceStates[guildId]) voiceStates[guildId] = {};
  voiceStates[guildId].token = packet.token;
  voiceStates[guildId].endpoint = packet.endpoint;
  console.log(`[Voice] Server update for guild ${guildId}`);
});

// Lavalink event handlers
lavalink.on('ready', () => {
  console.log('[Lavalink] Session established');
});

lavalink.on('event', async (evt) => {
  console.log(`[Lavalink Event] Type: ${evt.type}, Guild: ${evt.guildId}`);
  
  if (evt.type === 'TrackEndEvent') {
    if (evt.reason === 'finished' || evt.reason === 'loadFailed') {
      const queue = queueManager.get(evt.guildId);
      if (!queue) return;
      
      const nextSong = queueManager.getNext(evt.guildId);
      
      if (!nextSong) {
        await lavalink.destroyPlayer(evt.guildId);
        queueManager.delete(evt.guildId);
        if (queue.textChannel) {
          queue.textChannel.send('``````');
        }
        return;
      }
      
      queue.nowPlaying = nextSong;
      const voiceState = voiceStates[evt.guildId];
      
      if (voiceState && voiceState.token && voiceState.sessionId && voiceState.endpoint) {
        try {
          await lavalink.updatePlayer(evt.guildId, nextSong, voiceState, {
            volume: queue.volume,
            filters: queue.filters
          });
          
          if (queue.textChannel) {
            let nowPlayingMsg = '```js\n';
            nowPlayingMsg += '╭─[ NOW PLAYING ]─╮\n\n';
            nowPlayingMsg += `  🎵 ${nextSong.info.title}\n`;
            nowPlayingMsg += `  👤 ${nextSong.info.author}\n`;
            nowPlayingMsg += '\n╰──────────────────────────────────╯\n```';
            queue.textChannel.send(nowPlayingMsg);
          }
        } catch (err) {
          console.error('[Auto-play Error]:', err);
          if (queue.textChannel) {
            queue.textChannel.send('``````');
          }
        }
      }
    }
  }
});

// Helper function to load allowed users from allowedUsers.json
function loadAllowedUsers() {
  try {
    const allowedUsersPath = path.join(__dirname, 'database', 'allowedUsers.json');
    if (fs.existsSync(allowedUsersPath)) {
      const data = JSON.parse(fs.readFileSync(allowedUsersPath, 'utf8'));
      return data.allowedUsers || [];
    }
  } catch (error) {
    console.error('[Allowed Users] Error loading:', error);
  }
  return [];
}

// Helper function to check if user is allowed
function isAllowedUser(userId) {
  // Owner always allowed
  if (userId === process.env.OWNER_ID) return true;
  
  // Check allowedUsers.json
  const allowedUsers = loadAllowedUsers();
  return allowedUsers.includes(userId);
}

// Ready event
client.on('ready', async () => {
  console.log('╭─────────────────────────╮');
  console.log('│   Selfbot Connected!    │');
  console.log('╰─────────────────────────╯');
  console.log(`Username: ${client.user.username}`);
  console.log(`User ID: ${client.user.id}`);
  console.log(`Prefix: ${process.env.PREFIX}`);
  console.log(`Owner ID: ${process.env.OWNER_ID}`);
  
  // Load and display allowed users count
  const allowedUsers = loadAllowedUsers();
  console.log(`Allowed Users: ${allowedUsers.length}`);
  
  console.log(`No-Prefix Mode: ${client.db.noPrefixMode ? 'Enabled' : 'Disabled'}`);
  console.log('─────────────────────────\n');
  
  // Connect to Lavalink
  lavalink.connect(client.user.id);
  
  // Initialize all systems
  await initializeRPC(client);
  await initializeCloners(client);
  await initializeAutoReact(client);
  await initializeWelcome(client);
  await initializeAutoMod(client);
  await initializeGiveaways(client);
  await initializeAI(client);
});

// Message handler
client.on('messageCreate', async (message) => {
  // Check if user is allowed (owner or in allowedUsers.json)
  if (!isAllowedUser(message.author.id)) return;
  
  // Handle clone confirmations FIRST
  if (pendingCloneOperations.has(message.author.id)) {
    const operation = pendingCloneOperations.get(message.author.id);
    
    if (operation.channelId !== message.channel.id) return;
    
    const response = message.content.toLowerCase().trim();
    
    if (operation.step === 'confirmProceed') {
      if (response === 'y' || response === 'yes') {
        operation.step = 'confirmEmojis';
        pendingCloneOperations.set(message.author.id, operation);
        await message.channel.send('``````');
        
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        return;
      } else if (response === 'n' || response === 'no') {
        pendingCloneOperations.delete(message.author.id);
        await message.channel.send('``````');
        
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        return;
      }
    } else if (operation.step === 'confirmEmojis') {
      if (response === 'y' || response === 'yes' || response === 'n' || response === 'no') {
        const cloneEmojis = (response === 'y' || response === 'yes');
        pendingCloneOperations.delete(message.author.id);
        
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        
        const cloneCommand = client.commands.get('clone');
        await cloneCommand.executeClone(
          client,
          message.channel,
          operation.sourceGuildId,
          operation.targetGuildId,
          cloneEmojis
        );
        return;
      }
    }
  }
  
  const prefix = process.env.PREFIX;
  const noPrefixMode = client.db.noPrefixMode;
  let content = message.content;
  let hasPrefix = content.startsWith(prefix);
  
  // Check for nop command (always with prefix)
  if (hasPrefix && content.slice(prefix.length).trim().toLowerCase().startsWith('nop')) {
    const args = content.slice(prefix.length).trim().split(/ +/);
    const command = client.commands.get('nop');
    
    if (command) {
      try {
        if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
          await message.delete().catch(() => {});
        }
        await command.execute(message, args.slice(1), client);
      } catch (error) {
        console.error(`Error executing nop command:`, error);
      }
      return;
    }
  }
  
  // Determine if we should process the command
  let shouldProcess = false;
  let commandArgs = [];
  
  if (noPrefixMode) {
    shouldProcess = true;
    commandArgs = content.trim().split(/ +/);
  } else if (hasPrefix) {
    shouldProcess = true;
    commandArgs = content.slice(prefix.length).trim().split(/ +/);
  }
  
  if (!shouldProcess || commandArgs.length === 0) return;
  
  const commandName = commandArgs[0].toLowerCase();
  const args = commandArgs.slice(1);
  
  const command = client.commands.get(commandName) ||
                  client.commands.get(client.aliases.get(commandName));
  
  if (!command) return;
  
  // Delete command message if owner or selfbot user
  if ((message.author.id === process.env.OWNER_ID || message.author.id === client.user.id) && message.deletable) {
    await message.delete().catch(() => {});
  }
  
  try {
    await command.execute(message, args, client);
  } catch (error) {
    console.error(`Error executing ${commandName}:`, error);
    message.channel.send(`\`\`\`js\n❌ Error: ${error.message}\n\`\`\``).catch(() => {});
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Login
client.login(process.env.TOKEN).catch((error) => {
  console.error('Failed to login:', error);
  process.exit(1);
});
