const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const CompetitorMigration = require("../utils/competitorMigration");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("migrate")
    .setDescription("Migrate from the leading competitor or other security bots to nexus")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName("from")
        .setDescription("Which bot to migrate from")
        .setRequired(false)
        .addChoices(
          { name: "the leading competitor", value: "competitor" },
          { name: "Other", value: "other" }
        )
    ),

  async execute(interaction) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const fromBot = interaction.options.getString("from") || "competitor";
      const migration = new CompetitorMigration(interaction.client);

      if (fromBot === "competitor") {
        // Detect the leading competitor
        const hasCompetitor = await migration.detectCompetitor(interaction.guild);
        const config = await migration.analyzeCompetitorConfig(interaction.guild);

        const embed = new EmbedBuilder()
          .setTitle("🔄 Migrate from the leading competitor to nexus")
          .setDescription(
            hasCompetitor
              ? "✅ **the leading competitor detected in this server!**\n\n" +
                  "nexus can automatically configure itself with equivalent (and better) settings.\n\n" +
                  "**Why switch from the leading competitor to nexus?**\n" +
                  "💰 **Save $120/year** - nexus is 100% FREE\n" +
                  "🤖 **4x Better Detection** - 4 anti-raid algorithms vs Competition's 1\n" +
                  "🧠 **AI-Powered** - Predictive security the leading competitor doesn't have\n" +
                  "💾 **Auto-Backups** - Hourly snapshots (the leading competitor is manual)\n" +
                  "⚡ **Faster** - Sub-millisecond detection\n" +
                  "🔓 **Open Source** - Fully transparent (the leading competitor is closed)"
              : "⚠️ **the leading competitor not detected**\n\n" +
                  "But you can still set up nexus with optimal security settings!\n\n" +
                  "**Why choose nexus over the leading competitor?**\n" +
                  "💰 **100% FREE** - the leading competitor costs $3-10/month\n" +
                  "🤖 **4 Anti-Raid Algorithms** - the leading competitor only has 1\n" +
                  "🧠 **AI-Powered Security** - Predictive threat detection\n" +
                  "💾 **Hourly Auto-Backups** - Instant recovery\n" +
                  "⚡ **Sub-millisecond Detection** - Faster than the leading competitor\n" +
                  "🔓 **Open Source** - No hidden backdoors"
          )
          .setColor(hasCompetitor ? 0x4caf50 : 0xff9800);

        if (hasCompetitor && config.detectedSettings.logChannels) {
          embed.addFields({
            name: "📋 Detected the leading competitor Settings",
            value:
              `**Log Channels**: ${config.detectedSettings.logChannels.map((c) => `<#${c.id}>`).join(", ")}\n` +
              `**Recommendations**: ${config.recommendations.length} optimization suggestions`,
          });
        }

        embed.addFields(
          {
            name: "🎯 What nexus Will Set Up",
            value:
              "✅ 4 Anti-Raid Algorithms (vs Competition's 1)\n" +
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
              "**the leading competitor Premium**: $10/month = $120/year\n" +
              "**nexus**: $0/month = $0/year\n\n" +
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
            .setURL("https://nexusbot-official.github.io/nexus/comparison.html")
            .setStyle(ButtonStyle.Link)
        );

        await interaction.editReply({ embeds: [embed], components: [buttons] });

        // Log migration interest
        logger.info(
          "Migration",
          `${interaction.user.tag} viewed migration from the leading competitor in ${interaction.guild.name} (Has the leading competitor: ${hasCompetitor})`
        );
      } else {
        // Generic migration
        const embed = new EmbedBuilder()
          .setTitle("🔄 Migrate to nexus")
          .setDescription(
            "**Welcome to nexus!** 🎉\n\n" +
              "Let's set up optimal security for your server.\n\n" +
              "**What makes nexus special?**\n" +
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
              "Use `/setup` to configure nexus with optimal settings.\n" +
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
