const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags, = require("discord.js");
const db = require("../utils/database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Manage anti-nuke protection settings")
    .addSubcommand((subcommand) =>
      subcommand.setName("enable").setDescription("Enable anti-nuke protection")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("disable")
        .setDescription("Disable anti-nuke protection")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("View anti-nuke status and recent detections")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("config")
        .setDescription("Configure anti-nuke thresholds")
        .addIntegerOption((option) =>
          option
            .setName("channels_deleted")
            .setDescription("Threshold for channel deletions (default: 3)")
            .setMinValue(1)
            .setMaxValue(10)
        )
        .addIntegerOption((option) =>
          option
            .setName("roles_deleted")
            .setDescription("Threshold for role deletions (default: 2)")
            .setMinValue(1)
            .setMaxValue(10)
        )
        .addIntegerOption((option) =>
          option
            .setName("bans")
            .setDescription("Threshold for mass bans (default: 3)")
            .setMinValue(1)
            .setMaxValue(10)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("test")
        .setDescription("Test anti-nuke protection (admin only)")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    try {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "enable") {
        await this.handleEnable(interaction);
      } else if (subcommand === "disable") {
        await this.handleDisable(interaction);
      } else if (subcommand === "status") {
        await this.handleStatus(interaction);
      } else if (subcommand === "config") {
        await this.handleConfig(interaction);
      } else if (subcommand === "test") {
        await this.handleTest(interaction);
      }
    } catch (error) {
      const logger = require("../utils/logger");
      logger.error("Error in /antinuke command:", error);

      const reply = {
        content: `❌ Error: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },

  async handleEnable(interaction) {
    // Defer first to avoid timeout
    await interaction.deferReply();

    await db.setServerConfig(interaction.guild.id, {
      anti_nuke_enabled: 1,
    });

    const embed = new EmbedBuilder()
      .setTitle("✅ Anti-Nuke Protection Enabled")
      .setDescription(
        "**Protection Active:**\n" +
          "✅ Channel deletion monitoring\n" +
          "✅ Role deletion detection\n" +
          "✅ Mass ban/kick prevention\n" +
          "✅ Permission change tracking\n" +
          "✅ Automatic threat response\n\n" +
          "⚠️ **CRITICAL:** Ensure bot role is at TOP of role list!"
      )
      .addFields({
        name: "⚙️ Configure",
        value:
          "Use `/antinuke config` to adjust thresholds\nUse `/security rolecheck` to verify setup",
      })
      .setColor(0x00ff88)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleDisable(interaction) {
    // Defer first to avoid timeout
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    await db.setServerConfig(interaction.guild.id, {
      anti_nuke_enabled: 0,
    });

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Anti-Nuke Protection Disabled")
      .setDescription(
        "Your server is now vulnerable to:\n" +
          "❌ Channel deletion attacks\n" +
          "❌ Role manipulation\n" +
          "❌ Mass bans/kicks\n" +
          "❌ Permission exploits\n\n" +
          "**This is NOT recommended!**"
      )
      .setColor(0xff0000)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  async handleStatus(interaction) {
    await interaction.deferReply();

    const config = await db.getServerConfig(interaction.guild.id);
    const enabled = config?.anti_nuke_enabled !== 0; // Default to enabled

    // Get bot role position
    const botMember = await interaction.guild.members.fetch(
      interaction.client.user.id
    );
    const botRole = botMember.roles.highest;
    const allRoles = Array.from(interaction.guild.roles.cache.values())
      .filter((r) => r.id !== interaction.guild.id)
      .sort((a, b) => b.position - a.position);
    const botRoleIndex = allRoles.findIndex((r) => r.id === botRole.id);
    const isOptimal = botRoleIndex === 0;

    // Get recent threat stats from anti-nuke system
    const recentThreats =
      interaction.client.advancedAntiNuke?.processedThreats?.size || 0;

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Anti-Nuke Status")
      .setDescription(
        enabled
          ? "✅ **Protection is ACTIVE**"
          : "❌ **Protection is DISABLED**"
      )
      .addFields(
        {
          name: "📊 Detection Thresholds",
          value:
            "Channel Deletions: **3** in 5 seconds\n" +
            "Role Deletions: **2** in 5 seconds\n" +
            "Mass Bans: **3** in 5 seconds\n" +
            "Permission Changes: **3** in 10 seconds",
          inline: true,
        },
        {
          name: "🤖 Bot Role Status",
          value: isOptimal
            ? "✅ **OPTIMAL** - Highest position"
            : `⚠️ **SUBOPTIMAL** - Position ${botRoleIndex + 1}/${
                allRoles.length
              }\n**Action required!**`,
          inline: true,
        },
        {
          name: "📈 Recent Activity",
          value: `Threats detected (last hour): **${recentThreats}**`,
          inline: false,
        }
      )
      .setColor(enabled ? (isOptimal ? 0x00ff88 : 0xffa500) : 0xff0000)
      .setFooter({
        text: enabled
          ? "Protection active"
          : "Protection disabled - enable immediately!",
      })
      .setTimestamp();

    if (!isOptimal && enabled) {
      embed.addFields({
        name: "⚠️ Setup Required",
        value:
          "Run `/security rolecheck` for detailed instructions on fixing role hierarchy",
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },

  async handleConfig(interaction) {
    const channelsDeleted = interaction.options.getInteger("channels_deleted");
    const rolesDeleted = interaction.options.getInteger("roles_deleted");
    const bans = interaction.options.getInteger("bans");

    // Get current config
    const config = await db.getServerConfig(interaction.guild.id);
    const currentChannels = config?.antinuke_channels_threshold || 3;
    const currentRoles = config?.antinuke_roles_threshold || 2;
    const currentBans = config?.antinuke_bans_threshold || 3;

    // If no options provided, show current config
    if (!channelsDeleted && !rolesDeleted && !bans) {
      const embed = new EmbedBuilder()
        .setTitle("⚙️ Current Anti-Nuke Thresholds")
        .setDescription(
          "Configure how sensitive anti-nuke detection should be.\n" +
            "Lower values = more sensitive (may cause false positives)\n" +
            "Higher values = less sensitive (may miss attacks)"
        )
        .addFields(
          {
            name: "🗑️ Channels Deleted",
            value: `**${currentChannels}** channels\nTriggers when someone deletes this many channels`,
            inline: true,
          },
          {
            name: "🎭 Roles Deleted",
            value: `**${currentRoles}** roles\nTriggers when someone deletes this many roles`,
            inline: true,
          },
          {
            name: "🔨 Mass Bans",
            value: `**${currentBans}** bans\nTriggers when someone bans this many users`,
            inline: true,
          }
        )
        .setColor(0x667eea)
        .setFooter({
          text: "Use /antinuke config to change these values",
        });

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Update thresholds
    const updates = {};
    if (channelsDeleted) updates.antinuke_channels_threshold = channelsDeleted;
    if (rolesDeleted) updates.antinuke_roles_threshold = rolesDeleted;
    if (bans) updates.antinuke_bans_threshold = bans;

    await db.setServerConfig(interaction.guild.id, updates);

    const embed = new EmbedBuilder()
      .setTitle("✅ Anti-Nuke Thresholds Updated")
      .setDescription("Your custom thresholds have been saved!")
      .addFields(
        {
          name: "🗑️ Channels Deleted",
          value: `${currentChannels} → **${channelsDeleted || currentChannels}**`,
          inline: true,
        },
        {
          name: "🎭 Roles Deleted",
          value: `${currentRoles} → **${rolesDeleted || currentRoles}**`,
          inline: true,
        },
        {
          name: "🔨 Mass Bans",
          value: `${currentBans} → **${bans || currentBans}**`,
          inline: true,
        }
      )
      .setColor(0x00ff00)
      .setFooter({
        text: "Changes take effect immediately",
      });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },

  async handleTest(interaction) {
    const embed = new EmbedBuilder()
      .setTitle("🧪 Anti-Nuke Test Mode")
      .setDescription(
        "**Test mode is disabled for safety.**\n\n" +
          "To verify anti-nuke is working:\n" +
          "1. Run `/security rolecheck` - ensure bot role is at top\n" +
          "2. Run `/antinuke status` - check configuration\n" +
          "3. Check logs for threat detections\n\n" +
          "⚠️ **Never test with real deletion** - it may cause damage!"
      )
      .setColor(0xffa500);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
