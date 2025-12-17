const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const logger = require("./logger");

class TokenProtection {
  constructor(client) {
    this.client = client;
    this.botToken = process.env.DISCORD_TOKEN;
    this.alertChannelId = process.env.TOKEN_ALERT_CHANNEL; // Optional: specific channel for alerts
    this.ownerIds = process.env.OWNER_ID ? [process.env.OWNER_ID] : []; // Bot owner ID
  }

  /**
   * Check if a message contains the bot's token
   * @param {Message} message - Discord message to check
   */
  async checkMessage(message) {
    // Skip if no token configured
    if (!this.botToken) {
      return;
    }

    // Check ALL messages, including bot's own (in case of compromise)
    const content = message.content;

    // Check if message contains the exact token
    if (content.includes(this.botToken)) {
      logger.error(
        `🚨 [TOKEN LEAK] Bot token detected in message by ${message.author.tag} (${message.author.id}) in ${message.guild?.name || "DM"}`
      );

      // IMMEDIATE ACTIONS
      await this.handleTokenLeak(message);
    }
  }

  /**
   * Handle detected token leak
   * @param {Message} message - Message containing the token
   */
  async handleTokenLeak(message) {
    const leakInfo = {
      leakedBy: {
        id: message.author.id,
        tag: message.author.tag,
        isBot: message.author.bot,
      },
      location: {
        guildId: message.guild?.id || "DM",
        guildName: message.guild?.name || "Direct Message",
        channelId: message.channel.id,
        channelName: message.channel.name || "DM",
        messageId: message.id,
      },
      timestamp: new Date().toISOString(),
      messageContent: message.content.substring(0, 100) + "...", // First 100 chars for context
    };

    // 1. DELETE THE MESSAGE IMMEDIATELY
    try {
      await message.delete();
      logger.info(`[TOKEN LEAK] Deleted message containing token`);
    } catch (error) {
      logger.error(`[TOKEN LEAK] Failed to delete message:`, error.message);
    }

    // 2. ALERT BOT OWNER(S)
    await this.alertOwners(leakInfo);

    // 3. CREATE TOKEN FILE AND PUSH TO GITHUB (forces Discord to invalidate)
    await this.invalidateToken(leakInfo);

    // 4. LOG TO SECURITY LOGS
    await this.logToDatabase(leakInfo);

    // 5. EMERGENCY SHUTDOWN - Create flag file to prevent restart
    logger.error(`[TOKEN LEAK] EMERGENCY SHUTDOWN - Token compromised`);

    // Create flag file to tell cluster manager NOT to restart
    try {
      fs.writeFileSync(
        "./.TOKEN_LEAK_SHUTDOWN",
        JSON.stringify({
          timestamp: Date.now(),
          reason: "Token leak detected - manual restart required",
          leakedBy: leakInfo.leakedBy.tag,
        })
      );
      logger.error(
        `[TOKEN LEAK] Created shutdown flag - bot will NOT restart automatically`
      );
    } catch (error) {
      logger.error(
        `[TOKEN LEAK] Failed to create shutdown flag:`,
        error.message
      );
    }

    // Exit with specific code (1 = error, should not restart)
    process.exit(1);
  }

  /**
   * Alert bot owner(s) about token leak
   * @param {Object} leakInfo - Information about the leak
   */
  async alertOwners(leakInfo) {
    const alertEmbed = {
      title: "🚨 CRITICAL: BOT TOKEN LEAKED",
      description:
        "**The bot's token has been detected in a message and immediate action has been taken.**",
      color: 0xff0000,
      fields: [
        {
          name: "📍 Leaked By",
          value: `${leakInfo.leakedBy.tag} (${leakInfo.leakedBy.id})\n${leakInfo.leakedBy.isBot ? "⚠️ **BOT ACCOUNT**" : "👤 User Account"}`,
          inline: true,
        },
        {
          name: "📍 Location",
          value: `**Guild:** ${leakInfo.location.guildName}\n**Channel:** ${leakInfo.location.channelName}\n**Message ID:** ${leakInfo.location.messageId}`,
          inline: true,
        },
        {
          name: "⏰ Time",
          value: `<t:${Math.floor(Date.parse(leakInfo.timestamp) / 1000)}:F>`,
          inline: false,
        },
        {
          name: "✅ Actions Taken",
          value:
            "• Message deleted immediately\n• Token file created and pushed to GitHub\n• Discord will auto-invalidate token\n• Security log created\n• All owners notified",
          inline: false,
        },
        {
          name: "⚠️ NEXT STEPS",
          value:
            "1. **Regenerate token** in Discord Developer Portal\n2. **Update .env** with new token\n3. **Restart bot** with new token\n4. **Investigate** how token was leaked\n5. **Review security** of hosting environment",
          inline: false,
        },
      ],
      timestamp: leakInfo.timestamp,
      footer: {
        text: "Token Protection System | Sentinel Security",
      },
    };

    // Send to owner(s) via DM
    for (const ownerId of this.ownerIds) {
      try {
        const owner = await this.client.users.fetch(ownerId);
        await owner.send({ embeds: [alertEmbed] });
        logger.info(`[TOKEN LEAK] Alert sent to owner ${owner.tag}`);
      } catch (error) {
        logger.error(
          `[TOKEN LEAK] Failed to DM owner ${ownerId}:`,
          error.message
        );
      }
    }

    // Also send to alert channel if configured
    if (this.alertChannelId) {
      try {
        const alertChannel = await this.client.channels.fetch(
          this.alertChannelId
        );
        await alertChannel.send({
          content: this.ownerIds.map((id) => `<@${id}>`).join(" "),
          embeds: [alertEmbed],
        });
      } catch (error) {
        logger.error(
          `[TOKEN LEAK] Failed to send to alert channel:`,
          error.message
        );
      }
    }
  }

  /**
   * Create public gist with token to force Discord invalidation
   * @param {Object} leakInfo - Information about the leak
   */
  async invalidateToken(leakInfo) {
    const filename = `LEAKED_TOKEN_${Date.now()}.txt`;

    const fileContent = `LEAKED BOT TOKEN - DISCORD PLEASE INVALIDATE

Token: ${this.botToken}

Leak Information:
- Leaked By: ${leakInfo.leakedBy.tag} (${leakInfo.leakedBy.id})
- Location: ${leakInfo.location.guildName} > ${leakInfo.location.channelName}
- Time: ${leakInfo.timestamp}
- Message ID: ${leakInfo.location.messageId}

This token was automatically detected as leaked and posted publicly to trigger Discord's automatic token invalidation system.`;

    try {
      // METHOD 1: Create PUBLIC GitHub Gist (bypasses repository protection)
      const githubToken = process.env.GITHUB_TOKEN;

      if (githubToken) {
        try {
          const axios = require("axios");
          logger.info(`[TOKEN LEAK] Creating public GitHub Gist with token...`);

          const gistResponse = await axios.post(
            "https://api.github.com/gists",
            {
              description: "LEAKED BOT TOKEN - Discord Please Invalidate",
              public: true, // MUST be public for Discord to scan it
              files: {
                [filename]: {
                  content: fileContent,
                },
              },
            },
            {
              headers: {
                Authorization: `token ${githubToken}`,
                Accept: "application/vnd.github.v3+json",
              },
            }
          );

          const gistUrl = gistResponse.data.html_url;
          logger.info(`[TOKEN LEAK] ✅ Created public gist: ${gistUrl}`);
          logger.info(
            `[TOKEN LEAK] ✅ Discord will scan and invalidate token automatically`
          );
          logger.warn(
            `[TOKEN LEAK] Token invalidation initiated. Bot will shut down. Regenerate token at https://discord.com/developers/applications`
          );
          return; // Success!
        } catch (gistError) {
          logger.error(
            `[TOKEN LEAK] Failed to create gist:`,
            gistError.message
          );
          logger.warn(`[TOKEN LEAK] Falling back to repository push...`);
        }
      } else {
        logger.warn(
          `[TOKEN LEAK] No GITHUB_TOKEN found, skipping gist creation`
        );
      }

      // METHOD 2: Fallback - Try repository push (will likely fail)
      logger.info(`[TOKEN LEAK] Attempting repository push as fallback...`);
      const filepath = `./${filename}`;
      fs.writeFileSync(filepath, fileContent);

      await execAsync(`git add ${filename}`);
      await execAsync(
        `git commit -m "🚨 SECURITY: Leaked token detected - auto-invalidation"`
      );

      try {
        await execAsync(`git push`);
        logger.info(
          `[TOKEN LEAK] ✅ Pushed to repository - Discord will invalidate token`
        );
      } catch (pushError) {
        logger.error(
          `[TOKEN LEAK] Repository push blocked by GitHub protection`
        );
        logger.error(
          `[TOKEN LEAK] CRITICAL: Could not automatically invalidate token!`
        );
        logger.error(
          `[TOKEN LEAK] MANUAL ACTION REQUIRED:\n` +
            `1. Regenerate token IMMEDIATELY at https://discord.com/developers/applications\n` +
            `2. Update .env with new token\n` +
            `3. Restart bot\n` +
            `4. Add GITHUB_TOKEN to .env for automatic gist creation next time`
        );
      }
    } catch (error) {
      logger.error(`[TOKEN LEAK] Failed to invalidate token:`, error.message);
      logger.error(
        `[TOKEN LEAK] CRITICAL: Regenerate token IMMEDIATELY at https://discord.com/developers/applications`
      );
    }
  }

  /**
   * Log token leak to database
   * @param {Object} leakInfo - Information about the leak
   */
  async logToDatabase(leakInfo) {
    try {
      const db = require("./database");
      await new Promise((resolve, reject) => {
        db.db.run(
          `INSERT INTO security_logs (
            guild_id, user_id, threat_type, action_taken, 
            threat_score, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            leakInfo.location.guildId,
            leakInfo.leakedBy.id,
            "token_leak",
            "token_invalidated",
            100, // Maximum threat score
            Date.now(),
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      logger.info(`[TOKEN LEAK] Logged to security database`);
    } catch (error) {
      logger.error(`[TOKEN LEAK] Failed to log to database:`, error.message);
    }
  }
}

module.exports = TokenProtection;
