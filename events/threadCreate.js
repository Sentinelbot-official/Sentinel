const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  name: "threadCreate",
  async execute(thread, newlyCreated, client) {
    try {
      // Log thread creation
      const config = await db.getServerConfig(thread.guild.id);
      if (!config || !config.mod_log_channel) return;

      const logChannel = thread.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (!logChannel) return;

      // Get thread creator
      const creator = await thread.fetchOwner();

      const embed = {
        color: 0x5865f2, // Blurple
        title: "🧵 Thread Created",
        fields: [
          {
            name: "Thread",
            value: `${thread.name} (<#${thread.id}>)`,
            inline: true,
          },
          {
            name: "Parent Channel",
            value: `<#${thread.parentId}>`,
            inline: true,
          },
          {
            name: "Created By",
            value: creator
              ? `<@${creator.id}> (${creator.user?.tag || "Unknown"})`
              : "Unknown",
            inline: true,
          },
          {
            name: "Type",
            value: thread.type === 11 ? "Public Thread" : "Private Thread",
            inline: true,
          },
          {
            name: "Auto Archive Duration",
            value: `${thread.autoArchiveDuration} minutes`,
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
          type: "thread_create",
          category: "channel",
          action: "Thread Created",
          userId: creator?.id,
          details: `Thread "${thread.name}" created in <#${thread.parentId}>`,
          metadata: {
            threadId: thread.id,
            threadName: thread.name,
            parentId: thread.parentId,
            type: thread.type,
            autoArchiveDuration: thread.autoArchiveDuration,
            creatorId: creator?.id,
          },
        });
      }
    } catch (error) {
      logger.error("threadCreate", "Error handling thread creation:", error);
    }
  },
};
