const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "stickerUpdate",
  async execute(oldSticker, newSticker, client) {
    try {
      if (!newSticker.guild) return; // Only log guild stickers

      // Detect changes
      const changes = [];

      if (oldSticker.name !== newSticker.name) {
        changes.push({
          field: "Name",
          old: oldSticker.name,
          new: newSticker.name,
        });
      }

      if (oldSticker.description !== newSticker.description) {
        changes.push({
          field: "Description",
          old: oldSticker.description || "None",
          new: newSticker.description || "None",
        });
      }

      if (oldSticker.tags !== newSticker.tags) {
        changes.push({
          field: "Tags",
          old: oldSticker.tags || "None",
          new: newSticker.tags || "None",
        });
      }

      // Only log if there are actual changes
      if (changes.length === 0) return;

      const config = await db.getServerConfig(newSticker.guild.id);
      if (!config || !config.mod_log_channel) return;

      const logChannel = newSticker.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      // Try to get audit log to find who updated it
      let updatedBy = "Unknown";
      try {
        const auditLogs = await newSticker.guild.fetchAuditLogs({
          type: 91, // STICKER_UPDATE
          limit: 1,
        });
        const updateLog = auditLogs.entries.first();
        if (
          updateLog &&
          updateLog.target.id === newSticker.id &&
          Date.now() - updateLog.createdTimestamp < 5000
        ) {
          updatedBy = `<@${updateLog.executor.id}> (${updateLog.executor.tag})`;
        }
      } catch (error) {
        logger.debug("stickerUpdate", "Could not fetch audit logs");
      }

      const embed = {
        color: 0xfaa61a, // Orange
        title: "🎨 Sticker Updated",
        fields: [
          {
            name: "Sticker",
            value: newSticker.name,
            inline: true,
          },
          {
            name: "Updated By",
            value: updatedBy,
            inline: true,
          },
          ...changes.map((change) => ({
            name: change.field,
            value: `**Before:** ${change.old}\n**After:** ${change.new}`,
            inline: true,
          })),
        ],
        thumbnail: {
          url: newSticker.url,
        },
        timestamp: new Date().toISOString(),
        footer: {
          text: `Sticker ID: ${newSticker.id}`,
        },
      };

      await logChannel.send({ embeds: [embed] }).catch(() => {});

      // Enhanced logging to database
      if (client.enhancedLogging) {
        await client.enhancedLogging.log(newSticker.guild.id, {
          type: "sticker_update",
          category: "server",
          action: "Sticker Updated",
          details: `Sticker "${newSticker.name}" was updated`,
          metadata: {
            stickerId: newSticker.id,
            stickerName: newSticker.name,
            changes: changes,
            updatedBy: updatedBy,
          },
        });
      }
    } catch (error) {
      logger.error("stickerUpdate", "Error handling sticker update:", error);
    }
  },
};
