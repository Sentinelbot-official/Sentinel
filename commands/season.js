const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const seasonalSystem = require("../utils/seasonalSystem");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("season")
    .setDescription("View the current seasonal theme and information"),

  async execute(interaction) {
    const season = seasonalSystem.getSeasonalData();
    const colors = seasonalSystem.getSeasonalColors();

    const embed = new EmbedBuilder()
      .setTitle(`${season.emoji} Current Season: ${season.name}`)
      .setDescription(
        `Nexus automatically adapts its theme and messages based on the current season and special events!`
      )
      .addFields(
        {
          name: "🎨 Theme",
          value: season.theme.charAt(0).toUpperCase() + season.theme.slice(1),
          inline: true,
        },
        {
          name: "🎭 Special Event",
          value: seasonalSystem.isSpecialEvent() ? "Yes! 🎉" : "No",
          inline: true,
        },
        {
          name: "📅 Date Range",
          value: `${season.dateRange.start.month}/${season.dateRange.start.day} - ${season.dateRange.end.month}/${season.dateRange.end.day}`,
          inline: true,
        },
        {
          name: "💬 Sample Status Messages",
          value: season.statusMessages.slice(0, 3).join("\n"),
          inline: false,
        },
        {
          name: "👋 Seasonal Greetings",
          value: season.welcomeGreeting.join(", "),
          inline: false,
        },
        {
          name: "🎨 Color Palette",
          value: `Primary: \`#${colors.primary.toString(16).padStart(6, "0")}\`\nSecondary: \`#${colors.secondary.toString(16).padStart(6, "0")}\`\nAccent: \`#${colors.accent.toString(16).padStart(6, "0")}\``,
          inline: false,
        }
      )
      .setColor(colors.primary)
      .setFooter({ text: season.embedFooter })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};

