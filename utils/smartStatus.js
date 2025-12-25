// Smart status messages that auto-update with live stats
const logger = require("./logger");
const { version } = require("../package.json");
const seasonalSystem = require("./seasonalSystem");

class SmartStatus {
  constructor(client) {
    this.client = client;
    this.currentIndex = 0;
    this.updateInterval = null;
  }

  // Status message templates
  getStatusMessages() {
    const serverCount = this.client.guilds.cache.size;
    const userCount = this.client.guilds.cache.reduce(
      (acc, guild) => acc + guild.memberCount,
      0
    );

    const season = seasonalSystem.getSeasonalData();
    const seasonalEmoji = season.emoji;

    // Base status messages
    const baseMessages = [
      {
        type: "WATCHING",
        name: `${serverCount} servers | /help`,
      },
      {
        type: "WATCHING",
        name: `${userCount.toLocaleString()} users protected`,
      },
      {
        type: "PLAYING",
        name: `nexusbot-official.github.io/nexus | v${version}`,
      },
      {
        type: "WATCHING",
        name: `for threats | ${serverCount} servers`,
      },
      {
        type: "PLAYING",
        name: `Free & Open Source 💜`,
      },
      {
        type: "WATCHING",
        name: `raids and nukes | Beyond Wick`,
      },
      {
        type: "PLAYING",
        name: `/setup to get started`,
      },
      {
        type: "STREAMING",
        name: `${serverCount} servers | Join us!`,
        url: "https://nexusbot-official.github.io/nexus",
      },
    ];

    // Add seasonal status messages (2-3 per rotation)
    const seasonalMessages = season.statusMessages.slice(0, 3).map(msg => ({
      type: "PLAYING",
      name: msg.replace('{servers}', serverCount),
    }));

    // Combine base and seasonal messages
    return [...baseMessages, ...seasonalMessages];
  }

  // Update bot status
  async updateStatus() {
    try {
      const messages = this.getStatusMessages();
      const status = messages[this.currentIndex];

      await this.client.user.setPresence({
        activities: [
          {
            name: status.name,
            type:
              status.type === "WATCHING"
                ? 3
                : status.type === "PLAYING"
                  ? 0
                  : status.type === "STREAMING"
                    ? 1
                    : 0,
            url: status.url || undefined,
          },
        ],
        status: "online",
      });

      // Status updated silently - no need to log every 2 minutes

      // Move to next message
      this.currentIndex = (this.currentIndex + 1) % messages.length;
    } catch (error) {
      logger.error("[Smart Status] Failed to update status:", error);
    }
  }

  // Start auto-rotating status (every 2 minutes)
  start(intervalMinutes = 2) {
    // Update immediately
    this.updateStatus();

    // Then update every interval
    this.updateInterval = setInterval(
      () => {
        this.updateStatus();
      },
      intervalMinutes * 60 * 1000
    );

    logger.info(
      "Smart Status",
      `Auto-rotating status started (every ${intervalMinutes} minutes)`
    );
  }

  // Stop auto-rotating
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info("[Smart Status] Auto-rotating status stopped");
    }
  }

  // Manually set a status
  async setCustomStatus(type, message, url = null) {
    try {
      await this.client.user.setPresence({
        activities: [
          {
            name: message,
            type:
              type === "WATCHING"
                ? 3
                : type === "PLAYING"
                  ? 0
                  : type === "STREAMING"
                    ? 1
                    : 0,
            url: url || undefined,
          },
        ],
        status: "online",
      });

      logger.info(`[Smart Status] Custom status set: ${message}`);
    } catch (error) {
      logger.error("[Smart Status] Failed to set custom status:", error);
    }
  }
}

module.exports = SmartStatus;
