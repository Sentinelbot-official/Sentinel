const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const Moderation = require("../utils/moderation");
const db = require("../utils/database");
const ErrorMessages = require("../utils/errorMessages");
const CommandSecurity = require("../utils/commandSecurity");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban or unban a user from the server")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Ban a member from your server")
        .addUserOption((option) =>
          option.setName("user").setDescription("User to ban").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for ban")
            .setRequired(false)
        )
        .addIntegerOption((option) =>
          option
            .setName("delete_days")
            .setDescription("Days of messages to delete (0-7)")
            .setMinValue(0)
            .setMaxValue(7)
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Unban a user from your server")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("User to unban")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for unban")
            .setRequired(false)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    // Get bot member for security checks
    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);

    if (subcommand === "add") {
      const user = interaction.options.getUser("user");
      const reason =
        interaction.options.getString("reason") || "No reason provided";
      const deleteDays = interaction.options.getInteger("delete_days") || 0;

      // Security: Check bot permission
      const botPermCheck = CommandSecurity.checkBotPermission(botMember, PermissionFlagsBits.BanMembers);
      if (botPermCheck) return interaction.reply(botPermCheck);

      if (user.id === interaction.user.id) {
        return interaction.reply(ErrorMessages.cannotTargetSelf());
      }

      if (user.id === interaction.client.user.id) {
        return interaction.reply(ErrorMessages.cannotTargetBot());
      }

      // Prevent moderating the server owner
      if (user.id === interaction.guild.ownerId) {
        return interaction.reply(ErrorMessages.cannotTargetOwner());
      }

      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);

      // Security: Check role hierarchy using utility
      if (member) {
        const targetCheck = CommandSecurity.checkCanTarget(interaction.member, member, interaction.guild);
        if (targetCheck) return interaction.reply(targetCheck);

        if (!member.manageable) {
          return interaction.reply(ErrorMessages.botTargetHigherRole("ban"));
        }
      }

      const result = await Moderation.ban(
        interaction.guild,
        user,
        interaction.user,
        reason,
        deleteDays
      );

      if (result.success) {
        const embed = Moderation.createModEmbed(
          "ban",
          user,
          interaction.user,
          reason
        );
        await interaction.reply({ embeds: [embed] });

        // Send to mod log
        const config = await db.getServerConfig(interaction.guild.id);
        if (config && config.mod_log_channel) {
          const logChannel = interaction.guild.channels.cache.get(
            config.mod_log_channel
          );
          if (logChannel) {
            logChannel.send({ embeds: [embed] });
          }
        }
      } else {
        await interaction.reply(ErrorMessages.commandFailed(result.message));
      }
    } else if (subcommand === "remove") {
      const user = interaction.options.getUser("user");
      const reason =
        interaction.options.getString("reason") || "No reason provided";

      try {
        await interaction.guild.bans.remove(user.id, reason);
        const embed = Moderation.createModEmbed(
          "unban",
          user,
          interaction.user,
          reason
        );
        await interaction.reply({ embeds: [embed] });

        const config = await db.getServerConfig(interaction.guild.id);
        if (config && config.mod_log_channel) {
          const logChannel = interaction.guild.channels.cache.get(
            config.mod_log_channel
          );
          if (logChannel) {
            logChannel.send({ embeds: [embed] });
          }
        }
      } catch (error) {
        logger.error("Unban error:", error);
        await interaction.reply(ErrorMessages.commandFailed(error.message));
      }
    }
  },
};
