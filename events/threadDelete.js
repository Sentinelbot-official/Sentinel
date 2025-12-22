const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "threadDelete",
  async execute(thread, client) {
    try {
      const config = await db.getServerConfig(thread.guild.id);
      if (!config || !config.mod_log_channel) return;

      const logChannel = thread.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      // Try to get audit log to find who deleted it
      let deletedBy = "Unknown";
      try {
        const auditLogs = await thread.guild.fetchAuditLogs({
          type: 12, // THREAD_DELETE
          limit: 1,
        });
        const deleteLog = auditLogs.entries.first();
        if (
          deleteLog &&
          deleteLog.target.id === thread.id &&
          Date.now() - deleteLog.createdTimestamp < 5000
        ) {
          deletedBy = `<@${deleteLog.executor.id}> (${deleteLog.executor.tag})`;
        }
      } catch (error) {
        logger.debug("threadDelete", "Could not fetch audit logs");
      }

      const embed = {
        color: 0xed4245, // Red
        title: "🧵 Thread Deleted",
        fields: [
          {
            name: "Thread Name",
            value: thread.name,
            inline: true,
          },
          {
            name: "Parent Channel",
            value: thread.parentId ? `<#${thread.parentId}>` : "Unknown",
            inline: true,
          },
          {
            name: "Deleted By",
            value: deletedBy,
            inline: true,
          },
          {
            name: "Thread Type",
            value: thread.type === 11 ? "Public Thread" : "Private Thread",
            inline: true,
          },
          {
            name: "Message Count",
            value: thread.messageCount?.toString() || "Unknown",
            inline: true,
          },
          {
            name: "Member Count",
            value: thread.memberCount?.toString() || "Unknown",
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: `Thread ID: ${thread.id}`,
        },
      };

      await logChannel.send({ embeds: [embed] }).catch(() => {});

      // Enhanced logging to database
      if (client.enhancedLogging) {
        await client.enhancedLogging.log(thread.guild.id, {
          type: "thread_delete",
          category: "channel",
          action: "Thread Deleted",
          details: `Thread "${thread.name}" was deleted`,
          metadata: {
            threadId: thread.id,
            threadName: thread.name,
            parentId: thread.parentId,
            type: thread.type,
            messageCount: thread.messageCount,
            memberCount: thread.memberCount,
            deletedBy: deletedBy,
          },
        });
      }
    } catch (error) {
      logger.error("threadDelete", "Error handling thread deletion:", error);
    }
  },
};
