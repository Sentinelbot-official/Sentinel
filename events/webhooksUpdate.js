const logger = require("../utils/logger");

module.exports = {
  name: "webhooksUpdate",
  async execute(channel, client) {
    try {
      const guild = channel.guild;

      // Fetch current webhooks to see what changed
      let webhooks;
      try {
        webhooks = await channel.fetchWebhooks();
      } catch (fetchError) {
        if (fetchError.code === 50013) {
          return; // Skip if we don't have permission
        }
        throw fetchError; // Re-throw other errors
      }

      // Log to database
      const db = require("../utils/database");
      db.db.run(
        `INSERT INTO logs (guild_id, event_type, channel_id, timestamp, details)
         VALUES (?, ?, ?, ?, ?)`,
        [
          guild.id,
          "WEBHOOKS_UPDATE",
          channel.id,
          Date.now(),
          JSON.stringify({
            channel_name: channel.name,
            channel_id: channel.id,
            webhook_count: webhooks.size,
          }),
        ]
      );

      // Check audit logs for who made the change
      try {
        const auditLogs = await guild.fetchAuditLogs({
          type: 51, // WEBHOOK_UPDATE
          limit: 1,
        });

        const updateLog = auditLogs.entries.first();
        if (updateLog && Date.now() - updateLog.createdTimestamp < 5000) {
          // Check for suspicious webhook activity (rapid changes)
          const recentWebhooksUpdates = await new Promise((resolve) => {
            db.db.all(
              `SELECT COUNT(*) as count FROM logs 
               WHERE guild_id = ? AND event_type = ? AND timestamp > ?`,
              [guild.id, "WEBHOOKS_UPDATE", Date.now() - 60000],
              (err, rows) => {
                if (err || !rows) {
                  resolve(0);
                } else {
                  resolve(rows[0].count);
                }
              }
            );
          });

          if (recentWebhooksUpdates > 10) {
            logger.warn(
              "AntiNuke",
              `Suspicious webhook update activity detected: ${recentWebhooksUpdates} updates in 1 minute`
            );
          }
        }
      } catch (auditError) {
        // Silently ignore audit log errors
      }
    } catch (error) {
      // Silently handle errors
    }
  },
};
