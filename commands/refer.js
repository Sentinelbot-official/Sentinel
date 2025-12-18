const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const db = require("../utils/database");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("refer")
    .setDescription("Get your referral link and track referrals")
    .addSubcommand((subcommand) =>
      subcommand.setName("link").setDescription("Get your unique referral link")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stats")
        .setDescription("View your referral statistics and rewards")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("leaderboard").setDescription("View top referrers")
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommand === "link") {
        await this.handleLink(interaction);
      } else if (subcommand === "stats") {
        await this.handleStats(interaction);
      } else if (subcommand === "leaderboard") {
        await this.handleLeaderboard(interaction);
      }
    } catch (error) {
      logger.error("Refer", "Referral command error", {
        message: error?.message || String(error),
        subcommand,
      });

      const errorEmbed = new EmbedBuilder()
        .setTitle("❌ Error")
        .setDescription("Failed to process referral command. Please try again.")
        .setColor(0xf44336);

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [errorEmbed] });
      } else {
        await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  },

  async handleLink(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const referralCode = this.generateReferralCode(userId);
    const inviteLink = `https://discord.com/oauth2/authorize?client_id=${interaction.client.user.id}&permissions=268443574&scope=bot%20applications.commands&ref=${referralCode}`;

    const embed = new EmbedBuilder()
      .setTitle("🔗 Your Referral Link")
      .setDescription(
        "Share this link to invite Sentinel to other servers and earn rewards!\n\n" +
          `**Your Referral Link:**\n${inviteLink}\n\n` +
          "**Rewards:**\n" +
          "🎁 **3 referrals** - Custom bot status message\n" +
          "🎁 **5 referrals** - Priority support badge\n" +
          "🎁 **10 referrals** - Custom bot avatar for your server\n" +
          "🎁 **25 referrals** - Co-maintainer badge\n" +
          "🎁 **50 referrals** - Featured in showcase\n" +
          "🎁 **100 referrals** - Permanent premium features\n\n" +
          "Use `/refer stats` to track your progress!"
      )
      .setColor(0x2196f3)
      .setFooter({ text: "Help Sentinel grow and get rewarded!" });

    await interaction.editReply({ embeds: [embed] });

    logger.info("Refer", `${interaction.user.tag} requested referral link`);
  },

  async handleStats(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    // Get referral count
    const stats = await new Promise((resolve) => {
      db.db.get(
        `SELECT COUNT(*) as count FROM server_joins WHERE source LIKE ?`,
        [`ref_${userId}%`],
        (err, row) => {
          if (err || !row) {
            resolve({ count: 0 });
          } else {
            resolve(row);
          }
        }
      );
    });

    const referralCount = stats.count || 0;

    // Calculate rewards earned
    const rewards = [];
    if (referralCount >= 3) rewards.push("✅ Custom bot status");
    if (referralCount >= 5) rewards.push("✅ Priority support badge");
    if (referralCount >= 10) rewards.push("✅ Custom bot avatar");
    if (referralCount >= 25) rewards.push("✅ Co-maintainer badge");
    if (referralCount >= 50) rewards.push("✅ Featured in showcase");
    if (referralCount >= 100) rewards.push("✅ Permanent premium features");

    // Next reward
    let nextReward = "";
    let nextMilestone = 0;
    if (referralCount < 3) {
      nextReward = "Custom bot status";
      nextMilestone = 3;
    } else if (referralCount < 5) {
      nextReward = "Priority support badge";
      nextMilestone = 5;
    } else if (referralCount < 10) {
      nextReward = "Custom bot avatar";
      nextMilestone = 10;
    } else if (referralCount < 25) {
      nextReward = "Co-maintainer badge";
      nextMilestone = 25;
    } else if (referralCount < 50) {
      nextReward = "Featured in showcase";
      nextMilestone = 50;
    } else if (referralCount < 100) {
      nextReward = "Permanent premium features";
      nextMilestone = 100;
    }

    const embed = new EmbedBuilder()
      .setTitle("📊 Your Referral Stats")
      .setDescription(
        `**Total Referrals:** ${referralCount} server${referralCount !== 1 ? "s" : ""}\n\n` +
          (rewards.length > 0
            ? `**Rewards Earned:**\n${rewards.join("\n")}\n\n`
            : "") +
          (nextReward
            ? `**Next Reward:** ${nextReward}\n**Progress:** ${referralCount}/${nextMilestone} (${nextMilestone - referralCount} more needed)`
            : "🎉 **You've unlocked all rewards!**")
      )
      .setColor(referralCount >= 3 ? 0x4caf50 : 0xff9800)
      .setFooter({ text: "Use /refer link to get your referral link" });

    await interaction.editReply({ embeds: [embed] });

    logger.info(
      "Refer",
      `${interaction.user.tag} checked referral stats: ${referralCount} referrals`
    );
  },

  async handleLeaderboard(interaction) {
    await interaction.deferReply();

    // Get top referrers
    const topReferrers = await new Promise((resolve) => {
      db.db.all(
        `SELECT 
          SUBSTR(source, 5, INSTR(source || '_', '_', 5) - 5) as user_id,
          COUNT(*) as count
        FROM server_joins 
        WHERE source LIKE 'ref_%'
        GROUP BY user_id
        ORDER BY count DESC
        LIMIT 10`,
        [],
        (err, rows) => {
          if (err || !rows) {
            resolve([]);
          } else {
            resolve(rows);
          }
        }
      );
    });

    if (topReferrers.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle("🏆 Referral Leaderboard")
        .setDescription(
          "No referrals yet! Be the first to refer Sentinel to other servers!"
        )
        .setColor(0x9e9e9e);

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Fetch user tags
    const leaderboardText = await Promise.all(
      topReferrers.map(async (entry, index) => {
        try {
          const user = await interaction.client.users.fetch(entry.user_id);
          const medal =
            index === 0
              ? "🥇"
              : index === 1
                ? "🥈"
                : index === 2
                  ? "🥉"
                  : `${index + 1}.`;
          return `${medal} **${user.tag}** - ${entry.count} referral${entry.count !== 1 ? "s" : ""}`;
        } catch {
          return `${index + 1}. Unknown User - ${entry.count} referral${entry.count !== 1 ? "s" : ""}`;
        }
      })
    );

    const embed = new EmbedBuilder()
      .setTitle("🏆 Referral Leaderboard")
      .setDescription(
        "**Top Referrers:**\n\n" +
          leaderboardText.join("\n") +
          "\n\n*Want to climb the leaderboard? Use `/refer link` to get started!*"
      )
      .setColor(0xffd700)
      .setFooter({ text: "Thank you for helping Sentinel grow!" });

    await interaction.editReply({ embeds: [embed] });

    logger.info(
      "Refer",
      `Leaderboard viewed in ${interaction.guild?.name || "DM"}`
    );
  },

  generateReferralCode(userId) {
    // Simple referral code: ref_<userId>_<timestamp>
    return `ref_${userId}_${Date.now()}`;
  },
};
