const fs = require("fs");
const path = require("path");
const logger = require("./logger");

/**
 * Logs command usage to a detailed text file
 * @param {CommandInteraction} interaction - The command interaction
 */
async function logCommandToFile(interaction) {
  try {
    const logsDir = path.join(__dirname, "..", "logs");

    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create filename based on date (one file per day)
    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const logFile = path.join(logsDir, `commands-${dateStr}.txt`);

    // Fetch owner info
    let ownerInfo = "Unknown";
    let ownerAvatar = "Unknown";
    try {
      const owner = await interaction.guild.fetchOwner();
      ownerInfo = `${owner.user.tag} (${owner.user.id})`;
      ownerAvatar = owner.user.displayAvatarURL({ size: 256 });
    } catch (err) {
      ownerInfo = `Unknown (Failed to fetch)`;
      ownerAvatar = "Failed to fetch";
    }

    // Get server icon URL
    const serverIcon =
      interaction.guild.iconURL({ size: 256 }) || "No server icon";

    // Format timestamp
    const timestamp = new Date().toISOString();

    // Build log entry
    const logEntry = `
================================================================================
[${timestamp}]
COMMAND: /${interaction.commandName}
--------------------------------------------------------------------------------
USER:
  - Username: ${interaction.user.tag}
  - User ID: ${interaction.user.id}
  - Avatar: ${interaction.user.displayAvatarURL({ size: 256 })}
--------------------------------------------------------------------------------
SERVER:
  - Name: ${interaction.guild.name}
  - Server ID: ${interaction.guild.id}
  - Icon/PFP: ${serverIcon}
  - Member Count: ${interaction.guild.memberCount}
--------------------------------------------------------------------------------
OWNER:
  - ${ownerInfo}
  - Avatar: ${ownerAvatar}
--------------------------------------------------------------------------------
CHANNEL: #${interaction.channel.name} (${interaction.channel.id})
================================================================================

`;

    // Append to log file
    fs.appendFileSync(logFile, logEntry, "utf8");
  } catch (error) {
    logger.error(
      "CommandFileLogger",
      "Failed to log command to file:",
      error.message
    );
  }
}

module.exports = { logCommandToFile };
