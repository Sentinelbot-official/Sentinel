const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "threadMembersUpdate",
  async execute(addedMembers, removedMembers, thread, client) {
    try {
      // Only log if there are significant changes (avoid spam)
      if (addedMembers.size === 0 && removedMembers.size === 0) return;

      const config = await db.getServerConfig(thread.guild.id);
      if (!config || !config.mod_log_channel) return;

      // Only log if verbose logging is enabled (to avoid spam)
      const serverConfig = await db.getServerConfig(thread.guild.id);
      if (!serverConfig?.verbose_logging) return;

      const logChannel = thread.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      const fields = [];

      if (addedMembers.size > 0) {
        const memberList = Array.from(addedMembers.values())
          .slice(0, 10)
          .map((m) => `<@${m.id}>`)
          .join(", ");
        fields.push({
          name: `✅ Members Added (${addedMembers.size})`,
          value:
            addedMembers.size > 10
              ? `${memberList}\n*...and ${addedMembers.size - 10} more*`
              : memberList,
          inline: false,
        });
      }

      if (removedMembers.size > 0) {
        const memberList = Array.from(removedMembers.values())
          .slice(0, 10)
          .map((m) => `<@${m.id}>`)
          .join(", ");
        fields.push({
          name: `❌ Members Removed (${removedMembers.size})`,
          value:
            removedMembers.size > 10
              ? `${memberList}\n*...and ${removedMembers.size - 10} more*`
              : memberList,
          inline: false,
        });
      }

      const embed = {
        color: 0x5865f2, // Blurple
        title: "🧵 Thread Members Updated",
        description: `Thread: ${thread.name} (<#${thread.id}>)`,
        fields: fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: `Thread ID: ${thread.id}`,
        },
      };

      await logChannel.send({ embeds: [embed] }).catch(() => {});

      // Enhanced logging to database (only for significant changes)
      if (
        client.enhancedLogging &&
        (addedMembers.size > 5 || removedMembers.size > 5)
      ) {
        await client.enhancedLogging.log(thread.guild.id, {
          type: "thread_members_update",
          category: "channel",
          action: "Thread Members Updated",
          details: `Thread "${thread.name}" members updated`,
          metadata: {
            threadId: thread.id,
            threadName: thread.name,
            addedCount: addedMembers.size,
            removedCount: removedMembers.size,
          },
        });
      }
    } catch (error) {
      logger.error(
        "threadMembersUpdate",
        "Error handling thread members update:",
        error
      );
    }
  },
};
