const { REST, Routes } = require("discord.js");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const logger = require("./logger");

async function registerCommands(client) {
  if (!process.env.DISCORD_TOKEN) {
    logger.error("❌ DISCORD_TOKEN not found in .env file!");
    return;
  }

  if (!client.user) {
    logger.error("❌ Client not ready yet!");
    return;
  }

  const commands = [];
  const commandsPath = path.join(__dirname, "..", "commands");

  // Load all command files
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    try {
      const command = require(`../commands/${file}`);
      if (command.data) {
        commands.push(command.data.toJSON());
      }
    } catch (error) {
      logger.error(`⚠️ Failed to load command ${file}:`, {
        message: error?.message || String(error),
        stack: error?.stack,
        name: error?.name,
      });
    }
  }

  // Create REST client with timeout to prevent hanging requests
  const rest = new REST({
    version: "10",
    timeout: 10000, // 10 second timeout per request
  }).setToken(process.env.DISCORD_TOKEN);

  try {
    logger.info(
      "Commands",
      `Registering ${commands.length} slash commands globally...`
    );

    // Register commands globally (applies to all servers, ~1 hour to propagate)
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands,
    });

    logger.success(
      "Commands",
      `✅ Registered ${commands.length} global commands (will propagate within ~1 hour)`
    );
  } catch (error) {
    logger.error("❌ Error registering commands:", error);
  }
}

module.exports = { registerCommands };
