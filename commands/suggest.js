const {
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
} = require("discord.js");
const logger = require("../utils/logger");

// Set your suggestion channel ID here
const SUGGESTION_CHANNEL_ID = "1454233882520977519";

module.exports = {
  data: new SlashCommandBuilder()
    .setName("suggest")
    .setDescription("Suggest a new feature or improvement for Nexus"),

  async execute(interaction, client) {
    // Create modal for suggestion
    const modal = new ModalBuilder()
      .setCustomId("suggestion_modal")
      .setTitle("💡 Suggest a Feature");

    const titleInput = new TextInputBuilder()
      .setCustomId("suggestion_title")
      .setLabel("Feature Title")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Brief title for your suggestion")
      .setRequired(true)
      .setMaxLength(100);

    const descriptionInput = new TextInputBuilder()
      .setCustomId("suggestion_description")
      .setLabel("Description")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Describe your feature idea in detail...")
      .setRequired(true)
      .setMaxLength(1000);

    const useCaseInput = new TextInputBuilder()
      .setCustomId("suggestion_usecase")
      .setLabel("Use Case (Optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(
        "How would this feature be used? What problem does it solve?"
      )
      .setRequired(false)
      .setMaxLength(500);

    const firstRow = new ActionRowBuilder().addComponents(titleInput);
    const secondRow = new ActionRowBuilder().addComponents(descriptionInput);
    const thirdRow = new ActionRowBuilder().addComponents(useCaseInput);

    modal.addComponents(firstRow, secondRow, thirdRow);

    await interaction.showModal(modal);

    // Handle modal submission
    const filter = (i) =>
      i.customId === "suggestion_modal" && i.user.id === interaction.user.id;

    try {
      const modalInteraction = await interaction.awaitModalSubmit({
        filter,
        time: 300000, // 5 minutes
      });

      const title =
        modalInteraction.fields.getTextInputValue("suggestion_title");
      const description = modalInteraction.fields.getTextInputValue(
        "suggestion_description"
      );
      const useCase =
        modalInteraction.fields.getTextInputValue("suggestion_usecase") ||
        "Not provided";

      // Send confirmation to user
      const confirmEmbed = new EmbedBuilder()
        .setTitle("✅ Suggestion Submitted!")
        .setDescription(
          `Thank you for helping improve Nexus! Your suggestion has been sent to the developers.\n\n` +
            `**${title}**\n${description}`
        )
        .setColor(0x00ff88)
        .setTimestamp();

      await modalInteraction.reply({
        embeds: [confirmEmbed],
        flags: MessageFlags.Ephemeral,
      });

      // Send to suggestion channel
      try {
        const suggestionChannel = client.channels.cache.get(
          SUGGESTION_CHANNEL_ID
        );

        const suggestionEmbed = new EmbedBuilder()
          .setTitle("💡 New Feature Suggestion")
          .setDescription(`**${title}**\n\n${description}`)
          .addFields(
            {
              name: "Use Case",
              value: useCase,
            },
            {
              name: "Suggested By",
              value: `${interaction.user.tag} (${interaction.user.id})`,
              inline: true,
            },
            {
              name: "Server",
              value: interaction.guild.name,
              inline: true,
            }
          )
          .setColor(0x9b59b6) // Purple
          .setTimestamp()
          .setFooter({
            text: `User ID: ${interaction.user.id}`,
            iconURL: interaction.user.displayAvatarURL(),
          });

        await suggestionChannel.send({ embeds: [suggestionEmbed] });
      } catch (channelError) {
        logger.error(
          "suggest",
          `Failed to send suggestion to channel ${SUGGESTION_CHANNEL_ID}`,
          channelError
        );
      }
    } catch (error) {
      // Don't log timeout errors as they're expected when users don't complete the modal
      if (
        error.name === "InteractionCollectorError" &&
        error.reason === "time"
      ) {
        // User didn't submit the modal within 5 minutes - this is expected behavior
        return;
      }
      // Only log actual errors
      logger.error("suggest", "Error handling suggestion", error);
    }
  },
};
