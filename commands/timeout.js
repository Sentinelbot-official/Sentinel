const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const ms = require("ms");
const Moderation = require("../utils/moderation");
const ErrorMessages = require("../utils/errorMessages");
const CommandSecurity = require("../utils/commandSecurity");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout/untimeout a user")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add timeout to a user")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("User to timeout")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("Duration (e.g., 1h, 30m)")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("reason").setDescription("Reason").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove timeout from a user")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("User to untimeout")
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      const user = interaction.options.getUser("user");
      const durationStr = interaction.options.getString("duration");
      const reason =
        interaction.options.getString("reason") || "No reason provided";

      // Get bot member for security checks
      const botMember = await interaction.guild.members.fetch(
        interaction.client.user.id
      );

      // Security: Check bot permission
      const botPermCheck = CommandSecurity.checkBotPermission(
        botMember,
        PermissionFlagsBits.ModerateMembers
      );
      if (botPermCheck) return interaction.reply(botPermCheck);

      // Prevent self-moderation
      if (user.id === interaction.user.id) {
        return interaction.reply(ErrorMessages.cannotTargetSelf());
      }

      // Prevent moderating the bot
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
      if (!member) {
        return interaction.reply(ErrorMessages.userNotFound());
      }

      // Security: Check role hierarchy using utility
      const targetCheck = CommandSecurity.checkCanTarget(
        interaction.member,
        member,
        interaction.guild
      );
      if (targetCheck) return interaction.reply(targetCheck);

      // Check if member is manageable
      if (!member.moderatable) {
        return interaction.reply(ErrorMessages.botTargetHigherRole("timeout"));
      }

      const constants = require("../utils/constants");
      const duration = ms(durationStr);
      if (
        !duration ||
        duration < constants.MUTE.MIN_DURATION ||
        duration > constants.MUTE.MAX_DURATION
      ) {
        return interaction.reply(
          ErrorMessages.invalidInput("duration", "1h, 30m, 1d (max 28 days)")
        );
      }

      const result = await Moderation.mute(
        interaction.guild,
        user,
        interaction.user,
        reason,
        duration
      );

      if (result.success) {
        const embed = Moderation.createModEmbed(
          "mute",
          user,
          interaction.user,
          reason,
          duration
        );
        await interaction.reply({ embeds: [embed] });
      } else {
        await interaction.reply(ErrorMessages.commandFailed(result.message));
      }
    } else if (subcommand === "remove") {
      const user = interaction.options.getUser("user");

      // Get bot member for security checks
      const botMember = await interaction.guild.members.fetch(
        interaction.client.user.id
      );

      // Security: Check bot permission
      const botPermCheck = CommandSecurity.checkBotPermission(
        botMember,
        PermissionFlagsBits.ModerateMembers
      );
      if (botPermCheck) return interaction.reply(botPermCheck);

      try {
        const member = await interaction.guild.members.fetch(user.id);

        // Security: Check role hierarchy using utility
        const targetCheck = CommandSecurity.checkCanTarget(
          interaction.member,
          member,
          interaction.guild
        );
        if (targetCheck) return interaction.reply(targetCheck);

        // Check if member is manageable
        if (!member.moderatable) {
          return interaction.reply(
            ErrorMessages.botTargetHigherRole("remove timeout from")
          );
        }

        await member.timeout(null);

        await interaction.reply({
          embeds: [
            {
              title: "✅ Timeout Removed",
              description: `Removed timeout from ${user.tag}`,
              color: 0x00ff00,
            },
          ],
        });
      } catch (error) {
        await interaction.reply(ErrorMessages.commandFailed(error.message));
      }
    }
  },
};
