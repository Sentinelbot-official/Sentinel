const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const db = require("../utils/database");
const ErrorMessages = require("../utils/errorMessages");
const seasonalSystem = require("../utils/seasonalSystem");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("Configure welcome messages for new members")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("setup")
        .setDescription("Set up welcome messages")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Channel to send welcome messages")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("message")
            .setDescription(
              "Welcome message (use {user}, {server}, {membercount}, {season}, \\n for newlines)"
            )
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("disable").setDescription("Disable welcome messages")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("test").setDescription("Test welcome message")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("preview").setDescription("Preview welcome message")
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const config = await db.getServerConfig(interaction.guild.id);

    if (subcommand === "setup") {
      const channel = interaction.options.getChannel("channel");
      let message =
        interaction.options.getString("message") ||
        "Welcome {user} to {server}! We're glad to have you here! 🎉";

      // Convert \n to actual newlines
      message = message.replace(/\\n/g, "\n");

      if (!channel.isTextBased()) {
        return interaction.reply({
          content: "❌ Please select a text channel!",
          flags: MessageFlags.Ephemeral,
        });
      }

      await db.setServerConfig(interaction.guild.id, {
        welcome_channel: channel.id,
        welcome_message: message,
      });

      const embed = new EmbedBuilder()
        .setTitle("✅ Welcome Messages Configured")
        .setDescription(
          `Welcome messages will be sent to ${channel} when new members join.`
        )
        .addFields(
          {
            name: "Channel",
            value: `${channel}`,
            inline: true,
          },
          {
            name: "Message",
            value: message,
            inline: false,
          },
          {
            name: "Variables",
            value:
              "`{user}` - Mentions the new member\n`{server}` - Server name\n`{membercount}` - Total member count\n`{season}` - Seasonal greeting\n`\\n` - New line",
            inline: false,
          }
        )
        .setColor(0x00ff00)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    } else if (subcommand === "disable") {
      await db.setServerConfig(interaction.guild.id, {
        welcome_channel: null,
        welcome_message: null,
      });

      await interaction.reply({
        embeds: [
          {
            title: "✅ Welcome Messages Disabled",
            description: "Welcome messages have been disabled.",
            color: 0x00ff00,
          },
        ],
      });
    } else if (subcommand === "test") {
      if (!config?.welcome_channel || !config?.welcome_message) {
        return interaction.reply({
          content:
            "❌ Welcome messages are not configured! Use `/welcome setup` first.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.guild.channels.cache.get(
        config.welcome_channel
      );
      if (!channel) {
        return interaction.reply({
          content: "❌ Welcome channel not found! Please reconfigure.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const seasonalGreeting = seasonalSystem.getRandomGreeting();
      const message = config.welcome_message
        .replace(/\\n/g, "\n")
        .replace(/{user}/g, interaction.user.toString())
        .replace(/{server}/g, interaction.guild.name)
        .replace(/{membercount}/g, interaction.guild.memberCount)
        .replace(/{season}/g, seasonalGreeting);

      try {
        await channel.send({
          embeds: [
            {
              title: "👋 Welcome!",
              description: message,
              color: 0x00ff00,
              thumbnail: {
                url: interaction.user.displayAvatarURL({ dynamic: true }),
              },
              footer: {
                text: "This is a test message",
              },
            },
          ],
        });

        await interaction.reply({
          content: `✅ Test welcome message sent to ${channel}!`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        await interaction.reply(ErrorMessages.commandFailed(error.message));
      }
    } else if (subcommand === "preview") {
      if (!config?.welcome_channel || !config?.welcome_message) {
        return interaction.reply({
          content:
            "❌ Welcome messages are not configured! Use `/welcome setup` first.",
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.guild.channels.cache.get(
        config.welcome_channel
      );
      const seasonalGreeting = seasonalSystem.getRandomGreeting();
      const message = config.welcome_message
        .replace(/\\n/g, "\n")
        .replace(/{user}/g, interaction.user.toString())
        .replace(/{server}/g, interaction.guild.name)
        .replace(/{membercount}/g, interaction.guild.memberCount)
        .replace(/{season}/g, seasonalGreeting);

      const embed = new EmbedBuilder()
        .setTitle("👋 Welcome!")
        .setDescription(message)
        .setColor(0x00ff00)
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .addFields(
          {
            name: "Channel",
            value: channel ? `${channel}` : "❌ Channel not found",
            inline: true,
          },
          {
            name: "Raw Message",
            value: `\`${config.welcome_message}\``,
            inline: false,
          }
        )
        .setFooter({ text: "Preview - This is how welcome messages will look" })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  },
};
