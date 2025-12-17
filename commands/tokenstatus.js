const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("tokenstatus")
    .setDescription("View bot token usage monitoring and security status")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const stats = interaction.client.tokenMonitor?.getStats();

      if (!stats) {
        return interaction.editReply({
          content: "❌ Token monitoring is not initialized",
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("🔒 Token Security Status")
        .setDescription("Bot token usage monitoring and security alerts")
        .setColor(0x5865f2)
        .setTimestamp()
        .addFields(
          {
            name: "📊 Activity Statistics",
            value: [
              `**Total Activities Logged:** ${stats.totalActivities.toLocaleString()}`,
              `**Activities (24h):** ${stats.activitiesLast24h.toLocaleString()}`,
              `**Bot Uptime:** ${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m`,
            ].join("\n"),
            inline: true,
          },
          {
            name: "⚠️ Security Alerts",
            value: [
              `**Total Alerts:** ${stats.suspiciousPatterns}`,
              `**Recent Alerts:** ${stats.recentAlerts.length}`,
              stats.recentAlerts.length > 0
                ? `**Latest:** ${stats.recentAlerts[stats.recentAlerts.length - 1].type}`
                : "✅ No recent alerts",
            ].join("\n"),
            inline: true,
          },
          {
            name: "📈 Baseline Patterns",
            value: [
              `**Avg Commands/Hour:** ${stats.baseline.averageCommandsPerHour.toFixed(1)}`,
              `**Common Guilds:** ${stats.baseline.commonGuilds}`,
              `**Top Command:** ${stats.baseline.topCommands[0]?.command || "N/A"} (${stats.baseline.topCommands[0]?.count || 0})`,
            ].join("\n"),
            inline: true,
          }
        );

      // Add recent alerts if any
      if (stats.recentAlerts.length > 0) {
        const alertsList = stats.recentAlerts
          .slice(-5)
          .map(
            (alert) =>
              `**${alert.type}** (${alert.severity}) - <t:${Math.floor(alert.timestamp / 1000)}:R>`
          )
          .join("\n");

        embed.addFields({
          name: "🚨 Recent Security Alerts",
          value: alertsList.length > 1024 ? alertsList.substring(0, 1021) + "..." : alertsList,
          inline: false,
        });
      }

      // Add top commands
      if (stats.baseline.topCommands.length > 0) {
        const commandsList = stats.baseline.topCommands
          .map((c) => `\`${c.command}\`: ${c.count}`)
          .join("\n");

        embed.addFields({
          name: "🔝 Top Commands",
          value: commandsList,
          inline: false,
        });
      }

      embed.setFooter({
        text: "Token monitoring helps detect unauthorized usage",
      });

      return interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error("tokenstatus", "Error getting token status", error);
      return interaction.editReply({
        content: "❌ Failed to retrieve token status",
      });
    }
  },
};

