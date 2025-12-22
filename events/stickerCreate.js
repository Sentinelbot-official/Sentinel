const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "stickerCreate",
  async execute(sticker, client) {
    try {
      if (!sticker.guild) return; // Only log guild stickers

      const config = await db.getServerConfig(sticker.guild.id);
      if (!config || !config.mod_log_channel) return;

      const logChannel = sticker.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      // Try to get audit log to find who created it
      let createdBy = "Unknown";
      try {
        const auditLogs = await sticker.guild.fetchAuditLogs({
          type: 90, // STICKER_CREATE
          limit: 1,
        });
        const createLog = auditLogs.entries.first();
        if (
          createLog &&
          createLog.target.id === sticker.id &&
          Date.now() - createLog.createdTimestamp < 5000
        ) {
          createdBy = `<@${createLog.executor.id}> (${createLog.executor.tag})`;
        }
      } catch (error) {
        logger.debug("stickerCreate", "Could not fetch audit logs");
      }

      const embed = {
        color: 0x57f287, // Green
        title: "🎨 Sticker Created",
        fields: [
          {
            name: "Sticker Name",
            value: sticker.name,
            inline: true,
          },
          {
            name: "Description",
            value: sticker.description || "None",
            inline: true,
          },
          {
            name: "Created By",
            value: createdBy,
            inline: true,
          },
          {
            name: "Tags",
            value: sticker.tags || "None",
            inline: true,
          },
          {
            name: "Format",
            value:
              sticker.format === 1
                ? "PNG"
                : sticker.format === 2
                  ? "APNG"
                  : "LOTTIE",
            inline: true,
          },
        ],
        thumbnail: {
          url: sticker.url,
        },
        timestamp: new Date().toISOString(),
        footer: {
          text: `Sticker ID: ${sticker.id}`,
        },
      };

      await logChannel.send({ embeds: [embed] }).catch(() => {});

      // Enhanced logging to database
      if (client.enhancedLogging) {
        await client.enhancedLogging.log(sticker.guild.id, {
          type: "sticker_create",
          category: "server",
          action: "Sticker Created",
          details: `Sticker "${sticker.name}" was created`,
          metadata: {
            stickerId: sticker.id,
            stickerName: sticker.name,
            description: sticker.description,
            tags: sticker.tags,
            format: sticker.format,
            createdBy: createdBy,
          },
        });
      }
    } catch (error) {
      logger.error("stickerCreate", "Error handling sticker creation:", error);
    }
  },
};
