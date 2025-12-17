const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const WickMigration = require("../utils/wickMigration");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("migrate")
    .setDescription("Migrate from Wick or other security bots to Sentinel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("from")
        .setDescription("Which bot to migrate from")
        .setRequired(false)
        .addChoices(
          { name: "Wick", value: "wick" },
          { name: "Other", value: "other" }
        )
    ),

  async execute(interaction) {
    try {
      await interaction.deferReply({ ephemeral: true });

      const fromBot = interaction.options.getString("from") || "wick";
      const migration = new WickMigration(interaction.client);

      if (fromBot === "wick") {
        // Detect Wick
        const hasWick = await migration.detectWick(interaction.guild);
        const config = await migration.analyzeWickConfig(interaction.guild);

        const embed = new EmbedBuilder()
          .setTitle("🔄 Migrate from Wick to Sentinel")
          .setDescription(
            hasWick
              ? "✅ **Wick detected in this server!**\n\n" +
                  "Sentinel can automatically configure itself with equivalent (and better) settings.\n\n" +
                  "**Why switch from Wick to Sentinel?**\n" +
                  "💰 **Save $120/year** - Sentinel is 100% FREE\n" +
                  "🤖 **4x Better Detection** - 4 anti-raid algorithms vs Wick's 1\n" +
                  "🧠 **AI-Powered** - Predictive security Wick doesn't have\n" +
                  "💾 **Auto-Backups** - Hourly snapshots (Wick is manual)\n" +
                  "⚡ **Faster** - Sub-millisecond detection\n" +
                  "🔓 **Open Source** - Fully transparent (Wick is closed)"
              : "⚠️ **Wick not detected**\n\n" +
                  "But you can still set up Sentinel with optimal security settings!\n\n" +
                  "**Why choose Sentinel over Wick?**\n" +
                  "💰 **100% FREE** - Wick costs $3-10/month\n" +
                  "🤖 **4 Anti-Raid Algorithms** - Wick only has 1\n" +
                  "🧠 **AI-Powered Security** - Predictive threat detection\n" +
                  "💾 **Hourly Auto-Backups** - Instant recovery\n" +
                  "⚡ **Sub-millisecond Detection** - Faster than Wick\n" +
                  "🔓 **Open Source** - No hidden backdoors"
          )
          .setColor(hasWick ? 0x4caf50 : 0xff9800);

        if (hasWick && config.detectedSettings.logChannels) {
          embed.addFields({
            name: "📋 Detected Wick Settings",
            value:
              `**Log Channels**: ${config.detectedSettings.logChannels.map((c) => `<#${c.id}>`).join(", ")}\n` +
              `**Recommendations**: ${config.recommendations.length} optimization suggestions`,
          });
        }

        embed.addFields(
          {
            name: "🎯 What Sentinel Will Set Up",
            value:
              "✅ 4 Anti-Raid Algorithms (vs Wick's 1)\n" +
              "✅ AI Threat Detection\n" +
              "✅ Hourly Auto-Backups\n" +
              "✅ Advanced Anti-Nuke\n" +
              "✅ Smart Quarantine System\n" +
              "✅ Behavioral Analysis\n" +
              "✅ Cross-Server Threat Intelligence",
            inline: true,
          },
          {
            name: "💰 Cost Comparison",
            value:
              "**Wick Premium**: $10/month = $120/year\n" +
              "**Sentinel**: $0/month = $0/year\n\n" +
              "**You save**: $120/year 💸",
            inline: true,
          }
        );

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("migrate_start")
            .setLabel("🚀 Start Migration")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("migrate_compare")
            .setLabel("📊 See Full Comparison")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setLabel("🌐 Visit Website")
            .setURL(
              "https://Sentinelbot-official.github.io/Sentinel/comparison.html"
            )
            .setStyle(ButtonStyle.Link)
        );

        await interaction.editReply({ embeds: [embed], components: [buttons] });

        // Log migration interest
        logger.info(
          "Migration",
          `${interaction.user.tag} viewed migration from Wick in ${interaction.guild.name} (Has Wick: ${hasWick})`
        );
      } else {
        // Generic migration
        const embed = new EmbedBuilder()
          .setTitle("🔄 Migrate to Sentinel")
          .setDescription(
            "**Welcome to Sentinel!** 🎉\n\n" +
              "Let's set up optimal security for your server.\n\n" +
              "**What makes Sentinel special?**\n" +
              "🤖 **4 Anti-Raid Algorithms** - Best-in-class detection\n" +
              "🧠 **AI-Powered** - Predictive threat detection\n" +
              "💾 **Auto-Backups** - Hourly snapshots\n" +
              "⚡ **Sub-millisecond Detection** - Fastest response\n" +
              "🔓 **100% FREE** - No premium tiers\n" +
              "📖 **Open Source** - Fully transparent"
          )
          .setColor(0x2196f3)
          .addFields({
            name: "🚀 Quick Setup",
            value:
              "Use `/setup` to configure Sentinel with optimal settings.\n" +
              "Or use `/tutorial` for a guided walkthrough.",
          });

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      logger.error("Migration", "Migration command error", {
        message: error?.message || String(error),
        stack: error?.stack,
      });

      const errorEmbed = new EmbedBuilder()
        .setTitle("❌ Migration Error")
        .setDescription(
          "Failed to analyze migration options. Please try again."
        )
        .setColor(0xf44336);

      await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
  },
};
