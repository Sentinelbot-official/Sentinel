const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "stickerDelete",
  async execute(sticker, client) {
    try {
      if (!sticker.guild) return; // Only log guild stickers

      const config = await db.getServerConfig(sticker.guild.id);
      if (!config || !config.mod_log_channel) return;

      const logChannel = sticker.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      // Try to get audit log to find who deleted it
      let deletedBy = "Unknown";
      try {
        const auditLogs = await sticker.guild.fetchAuditLogs({
          type: 92, // STICKER_DELETE
          limit: 1,
        });
        const deleteLog = auditLogs.entries.first();
        if (
          deleteLog &&
          deleteLog.target.id === sticker.id &&
          Date.now() - deleteLog.createdTimestamp < 5000
        ) {
          deletedBy = `<@${deleteLog.executor.id}> (${deleteLog.executor.tag})`;
        }
      } catch (error) {
        logger.debug("stickerDelete", "Could not fetch audit logs");
      }

      const embed = {
        color: 0xed4245, // Red
        title: "🎨 Sticker Deleted",
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
            name: "Deleted By",
            value: deletedBy,
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
          type: "sticker_delete",
          category: "server",
          action: "Sticker Deleted",
          details: `Sticker "${sticker.name}" was deleted`,
          metadata: {
            stickerId: sticker.id,
            stickerName: sticker.name,
            description: sticker.description,
            tags: sticker.tags,
            format: sticker.format,
            deletedBy: deletedBy,
          },
        });
      }
    } catch (error) {
      logger.error("stickerDelete", "Error handling sticker deletion:", error);
    }
  },
};
