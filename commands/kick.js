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
    .setName("kick")
    .setDescription("Kick a user from the server")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to kick").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for kick")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  async execute(interaction) {
    const user = interaction.options.getUser("user");
    const reason =
      interaction.options.getString("reason") || "No reason provided";

    // Get bot member for security checks
    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);

    // Security: Check bot permission
    const botPermCheck = CommandSecurity.checkBotPermission(botMember, PermissionFlagsBits.KickMembers);
    if (botPermCheck) return interaction.reply(botPermCheck);

    // Prevent self-moderation
    if (user.id === interaction.user.id) {
      return interaction.reply(ErrorMessages.cannotTargetSelf());
    }

    // Prevent moderating the server owner
    if (user.id === interaction.guild.ownerId) {
      return interaction.reply(ErrorMessages.cannotTargetOwner());
    }

    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      return interaction.reply(ErrorMessages.userNotFound());
    }

    // Security: Check role hierarchy using utility
    const targetCheck = CommandSecurity.checkCanTarget(interaction.member, member, interaction.guild);
    if (targetCheck) return interaction.reply(targetCheck);

    // Check if member is manageable
    if (!member.kickable) {
      return interaction.reply(ErrorMessages.botTargetHigherRole("kick"));
    }

    const result = await Moderation.kick(
      interaction.guild,
      user,
      interaction.user,
      reason
    );

    if (result.success) {
      const embed = Moderation.createModEmbed(
        "kick",
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
    } else {
      await interaction.reply(ErrorMessages.commandFailed(result.message));
    }
  },
};
