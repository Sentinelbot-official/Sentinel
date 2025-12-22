const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "threadUpdate",
  async execute(oldThread, newThread, client) {
    try {
      // Detect changes
      const changes = [];

      if (oldThread.name !== newThread.name) {
        changes.push({
          field: "Name",
          old: oldThread.name,
          new: newThread.name,
        });
      }

      if (oldThread.archived !== newThread.archived) {
        changes.push({
          field: "Archived",
          old: oldThread.archived ? "Yes" : "No",
          new: newThread.archived ? "Yes" : "No",
        });
      }

      if (oldThread.locked !== newThread.locked) {
        changes.push({
          field: "Locked",
          old: oldThread.locked ? "Yes" : "No",
          new: newThread.locked ? "Yes" : "No",
        });
      }

      if (
        oldThread.autoArchiveDuration !== newThread.autoArchiveDuration &&
        newThread.autoArchiveDuration
      ) {
        changes.push({
          field: "Auto Archive Duration",
          old: `${oldThread.autoArchiveDuration} minutes`,
          new: `${newThread.autoArchiveDuration} minutes`,
        });
      }

      if (oldThread.rateLimitPerUser !== newThread.rateLimitPerUser) {
        changes.push({
          field: "Slowmode",
          old:
            oldThread.rateLimitPerUser > 0
              ? `${oldThread.rateLimitPerUser}s`
              : "Off",
          new:
            newThread.rateLimitPerUser > 0
              ? `${newThread.rateLimitPerUser}s`
              : "Off",
        });
      }

      // Only log if there are actual changes
      if (changes.length === 0) return;

      const config = await db.getServerConfig(newThread.guild.id);
      if (!config || !config.mod_log_channel) return;

      const logChannel = newThread.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      const embed = {
        color: 0xfaa61a, // Orange
        title: "🧵 Thread Updated",
        fields: [
          {
            name: "Thread",
            value: `${newThread.name} (<#${newThread.id}>)`,
            inline: false,
          },
          ...changes.map((change) => ({
            name: change.field,
            value: `**Before:** ${change.old}\n**After:** ${change.new}`,
            inline: true,
          })),
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: `Thread ID: ${newThread.id}`,
        },
      };

      await logChannel.send({ embeds: [embed] }).catch(() => {});

      // Enhanced logging to database
      if (client.enhancedLogging) {
        await client.enhancedLogging.log(newThread.guild.id, {
          type: "thread_update",
          category: "channel",
          action: "Thread Updated",
          details: `Thread "${newThread.name}" was updated`,
          metadata: {
            threadId: newThread.id,
            threadName: newThread.name,
            changes: changes,
          },
        });
      }
    } catch (error) {
      logger.error("threadUpdate", "Error handling thread update:", error);
    }
  },
};
