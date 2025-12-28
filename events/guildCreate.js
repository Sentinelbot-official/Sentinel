const { registerCommands } = require("../utils/registerCommands");
const db = require("../utils/database");
const logger = require("../utils/logger");
const growthTracker = require("../utils/growthTracker");
const contentFilter = require("../utils/contentFilter");
const { version } = require("../package.json");
const { isGuildBlacklisted } = require("../utils/guildBlacklist");

module.exports = {
  name: "guildCreate",
  async execute(guild, client) {
    // Auto-leave if guild is blacklisted (by guild ID or owner ID)
    if (await isGuildBlacklisted(guild)) {
      logger.warn(
        "Guild Create",
        `Blacklisted guild detected (by id/owner), leaving (${guild.id})`
      );
      try {
        await guild.leave();
        logger.info("Guild Create", `Left blacklisted guild ${guild.id}`);
      } catch (err) {
        logger.error(
          "Guild Create",
          `Failed to leave blacklisted guild (${guild.id}):`,
          err
        );
      }
      return;
    }

    // Check for offensive content and auto-leave if detected
    const wasFiltered = await contentFilter.autoModerateGuild(guild);
    if (wasFiltered) {
      logger.warn(
        "Guild Create",
        `🚫 Auto-left offensive server (ID: ${guild.id})`
      );
      return; // Stop processing this guild join
    }

    // Sanitize guild name for logs
    const sanitizedName = contentFilter.sanitize(guild.name);

    logger.info(
      "Guild Create",
      `Joined new server: ${sanitizedName} (${guild.id})`
    );

    // Track invite source if present - DO THIS FIRST before tracking
    let inviteSource = "direct"; // default

    try {
      // Check if we have a tracked source for this user (guild owner)
      const owner = await guild.fetchOwner().catch(() => null);
      if (owner) {
        // Query database for any pending invite tracking for this user
        const trackedSource = await new Promise((resolve) => {
          db.db.get(
            "SELECT source FROM pending_invite_sources WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1",
            [owner.id],
            (err, row) => {
              if (err || !row) {
                resolve(null);
              } else {
                resolve(row.source);
              }
            }
          );
        });

        if (trackedSource) {
          inviteSource = trackedSource;
          // Clean up the pending tracking
          db.db.run("DELETE FROM pending_invite_sources WHERE user_id = ?", [
            owner.id,
          ]);
          logger.info(
            "Guild Create",
            `Found tracked invite source: ${inviteSource} for owner ${owner.id}`
          );
        } else {
          // Fallback: Check for anonymous clicks by IP address (within last 24 hours)
          // Note: We can't get the owner's IP directly, but we can check recent anonymous clicks
          // This is a best-effort fallback for when users click invite but don't authenticate
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const anonymousSource = await new Promise((resolve) => {
            db.db.get(
              "SELECT source FROM pending_invite_sources WHERE user_id = 'anonymous' AND timestamp > ? ORDER BY timestamp DESC LIMIT 1",
              [oneDayAgo],
              (err, row) => {
                if (err || !row) {
                  resolve(null);
                } else {
                  resolve(row.source);
                }
              }
            );
          });

          if (anonymousSource) {
            inviteSource = anonymousSource;
            logger.info(
              "Guild Create",
              `Matched invite source by anonymous click: ${anonymousSource}`
            );
          }
        }
      }
    } catch (error) {
      logger.error("Guild Create", "Failed to lookup invite source", {
        message: error?.message || String(error),
        stack: error?.stack,
        name: error?.name,
      });
      // Continue with "direct" as fallback
    }

    // Now track with the correct source (or "direct" if none found)
    await growthTracker
      .trackServerAdd(guild.id, inviteSource, guild.memberCount || 0)
      .catch((err) => {
        logger.error("Growth tracker error:", err);
      });

    // Track in server_joins for retention analysis
    await new Promise((resolve, reject) => {
      db.db.run(
        `INSERT OR IGNORE INTO server_joins (guild_id, guild_name, member_count, joined_at, source) 
         VALUES (?, ?, ?, ?, ?)`,
        [
          guild.id,
          guild.name,
          guild.memberCount || 0,
          Date.now(),
          inviteSource,
        ],
        (err) => {
          if (err) {
            logger.error("Failed to track server join for retention:", err);
            reject(err);
          } else {
            resolve();
          }
        }
      );
    }).catch(() => {
      // Error already logged
    });

    // COMPETITIVE INTELLIGENCE: Detect Wick and log for analytics
    // NOTE: We do NOT DM users unprompted - that's spam and gets bots kicked
    // Instead, we just log it and show the comparison in-server via /migrate
    try {
      const CompetitorMigration = require("../utils/competitorMigration");
      const migration = new CompetitorMigration(client);
      const hasCompetitor = await migration.detectCompetitor(guild);

      if (hasCompetitor) {
        logger.info(
          "Competitive",
          `🎯 Wick detected in ${guild.name} (${guild.id}) - user can run /migrate to see comparison`
        );

        // Store this info for analytics (optional)
        await new Promise((resolve) => {
          db.db.run(
            `INSERT OR IGNORE INTO competitive_intel (guild_id, competitor_bot, detected_at) 
             VALUES (?, ?, ?)`,
            [guild.id, "competitor", Date.now()],
            () => resolve()
          );
        }).catch(() => {
          // Ignore if table doesn't exist
        });
      }
    } catch (competitorError) {
      logger.debug(
        "Competitive",
        `Wick detection error in ${guild.name}: ${competitorError.message}`
      );
    }

    // Check for verification milestones
    const serverCount = client.guilds.cache.size;
    const totalUsers = client.guilds.cache.reduce(
      (acc, g) => acc + g.memberCount,
      0
    );

    // Helper function to check and mark reminder as sent
    const checkAndSendReminder = async (milestone) => {
      // Check if reminder already sent
      const alreadySent = await new Promise((resolve) => {
        db.db.get(
          "SELECT sent_at FROM verification_reminders WHERE milestone = ?",
          [milestone],
          (err, row) => {
            if (err || !row) {
              resolve(false);
            } else {
              resolve(true);
            }
          }
        );
      });

      if (alreadySent) {
        return false; // Already sent, skip
      }

      // Mark as sent before sending (to prevent duplicates if multiple events fire)
      await new Promise((resolve) => {
        db.db.run(
          "INSERT OR IGNORE INTO verification_reminders (milestone, sent_at) VALUES (?, ?)",
          [milestone, Date.now()],
          () => resolve()
        );
      });

      return true; // Can send
    };

    // 65 servers - Early heads up (10 away from verification milestone)
    if (serverCount === 65) {
      const canSend = await checkAndSendReminder(65);
      if (canSend) {
        try {
          const owner = await client.users.fetch(process.env.OWNER_ID);
          await owner.send({
            embeds: [
              {
                title: "📢 Getting Close to Verification!",
                description:
                  "**nexus has reached 65 servers!**\n\nYou're **10 servers away** from being able to apply for Discord Bot Verification (75 servers required).\n\n**What to Prepare:**\n- Start gathering information for the verification form\n- Review Discord's verification requirements\n- Ensure your bot meets all criteria\n\n**At 75 servers**, you'll be able to apply for verification to remove the 100-server limit.",
                color: 0xfbbf24,
                fields: [
                  {
                    name: "📊 Current Stats",
                    value: `**Servers:** ${serverCount}\n**Users:** ${totalUsers}\n**Version:** ${version}`,
                    inline: false,
                  },
                  {
                    name: "🎯 Next Milestone",
                    value:
                      "10 more servers until you can apply for verification",
                    inline: false,
                  },
                ],
                timestamp: new Date().toISOString(),
                footer: {
                  text: "Keep up the great growth!",
                },
              },
            ],
          });
          logger.info("Verification", `Sent 65-server heads up to owner`);
        } catch (error) {
          logger.error("Verification", `Failed to send DM to owner: ${error}`);
        }
      }
    }

    // 75 servers - Can apply for verification
    if (serverCount === 75) {
      const canSend = await checkAndSendReminder(75);
      if (canSend) {
        try {
          const owner = await client.users.fetch(process.env.OWNER_ID);
          await owner.send({
            embeds: [
              {
                title: "🎉 Verification Milestone Reached!",
                description:
                  "**nexus has reached 75 servers!**\n\nYou can now apply for full Discord Bot Verification to remove the 100-server limit.\n\n**Action Required:**\n1. Go to [Discord Developer Portal](https://discord.com/developers/applications)\n2. Select your nexus bot\n3. Navigate to the **Bot** tab\n4. Scroll to **Privileged Gateway Intents**\n5. Click **Apply for Verification**\n6. Fill out the verification form\n\n**Important:** You must get verified before hitting 100 servers or your bot will stop being able to join new servers!",
                color: 0x5865f2,
                fields: [
                  {
                    name: "📊 Current Stats",
                    value: `**Servers:** ${serverCount}\n**Users:** ${totalUsers}\n**Version:** ${version}`,
                    inline: false,
                  },
                  {
                    name: "⏰ Time Until Limit",
                    value: "25 servers remaining before 100-server cap",
                    inline: false,
                  },
                ],
                timestamp: new Date().toISOString(),
                footer: {
                  text: "Apply for verification as soon as possible!",
                },
              },
            ],
          });
          logger.info(
            "Verification",
            `Sent 75-server verification reminder to owner`
          );
        } catch (error) {
          logger.error("Verification", `Failed to send DM to owner: ${error}`);
        }
      }
    }

    // 95 servers - URGENT warning (5 away from limit)
    if (serverCount === 95) {
      const canSend = await checkAndSendReminder(95);
      if (canSend) {
        try {
          const owner = await client.users.fetch(process.env.OWNER_ID);
          await owner.send({
            embeds: [
              {
                title: "⚠️ URGENT: Verification Required!",
                description:
                  "**nexus has reached 95 servers!**\n\n🚨 **ONLY 5 SERVERS LEFT** before hitting the 100-server limit!\n\nIf you're not verified by 100 servers, your bot will **STOP** being able to join new servers.\n\n**Verify NOW:**\n[Discord Developer Portal](https://discord.com/developers/applications) → Your Bot → Bot Tab → Apply for Verification",
                color: 0xed4245,
                fields: [
                  {
                    name: "📊 Current Stats",
                    value: `**Servers:** ${serverCount}/100\n**Users:** ${totalUsers}\n**Version:** ${version}`,
                    inline: false,
                  },
                  {
                    name: "🚨 Action Required",
                    value:
                      "Apply for verification immediately or risk growth stopping!",
                    inline: false,
                  },
                ],
                timestamp: new Date().toISOString(),
                footer: {
                  text: "This is your final warning!",
                },
              },
            ],
          });
          logger.warn(
            "Verification",
            `Sent URGENT 95-server verification warning to owner`
          );
        } catch (error) {
          logger.error("Verification", `Failed to send DM to owner: ${error}`);
        }
      }
    }

    // 99 servers - CRITICAL: Bot can no longer join servers
    if (serverCount === 99) {
      const canSend = await checkAndSendReminder(99);
      if (canSend) {
        try {
          const owner = await client.users.fetch(process.env.OWNER_ID);
          await owner.send({
            embeds: [
              {
                title: "🚨 CRITICAL: 100-Server Limit Reached!",
                description:
                  "**nexus has reached 99 servers!**\n\n⚠️ **ONLY 1 SERVER LEFT** before hitting the 100-server hard limit!\n\n**If you're not verified, your bot will STOP being able to join new servers at 100 servers.**\n\n**If you ARE verified**, you can continue growing beyond 100 servers.\n\n**Verify NOW (if not already):**\n[Discord Developer Portal](https://discord.com/developers/applications) → Your Bot → Bot Tab → Apply for Verification",
                color: 0xff0000,
                fields: [
                  {
                    name: "📊 Current Stats",
                    value: `**Servers:** ${serverCount}/100\n**Users:** ${totalUsers}\n**Version:** ${version}`,
                    inline: false,
                  },
                  {
                    name: "🚨 Status",
                    value:
                      "Bot will be unable to join new servers at 100 servers if not verified!",
                    inline: false,
                  },
                ],
                timestamp: new Date().toISOString(),
                footer: {
                  text: "This is the final limit - verify immediately!",
                },
              },
            ],
          });
          logger.error(
            "Verification",
            `Sent CRITICAL 99-server limit warning to owner`
          );
        } catch (error) {
          logger.error("Verification", `Failed to send DM to owner: ${error}`);
        }
      }
    }
    try {
      // Track the guild join with source (inviteSource already determined above)
      await db.trackGuildJoin(
        guild.id,
        inviteSource,
        guild.name,
        guild.memberCount || 0
      );

      // Tracked join from source (no console logging)

      // Referral tracking removed (command deprecated to stay under 100 command limit)

      // Send webhook notification to admin
      if (
        process.env.ADMIN_WEBHOOK_URL &&
        process.env.ADMIN_WEBHOOK_URL !==
          "https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN"
      ) {
        try {
          const owner = await guild.fetchOwner().catch(() => null);

          // Get conversion stats for this source
          const sourceStats = await db.getInviteSourceStats().catch(() => []);
          const thisSourceStats = sourceStats.find(
            (s) => s.source === inviteSource
          );

          // Check for milestones
          const totalServers = client.guilds.cache.size;
          const milestones = [20, 50, 100, 250, 500, 1000];
          const hitMilestone = milestones.includes(totalServers);

          const webhook = {
            username: "nexus Growth Tracker",
            avatar_url:
              "https://cdn.discordapp.com/app-icons/1444739230679957646/32f2d77d44c2f3989fecd858be53f396.png",
            embeds: [
              {
                title: hitMilestone
                  ? `🎊 MILESTONE: ${totalServers} SERVERS! 🎊`
                  : "🎉 New Server Joined!",
                color: hitMilestone ? 0xffd700 : 0x10b981,
                description: hitMilestone
                  ? `**Congratulations! You just hit ${totalServers} servers!** 🚀`
                  : null,
                thumbnail: {
                  url:
                    guild.iconURL() ||
                    "https://cdn.discordapp.com/app-icons/1444739230679957646/32f2d77d44c2f3989fecd858be53f396.png",
                },
                fields: [
                  {
                    name: "📋 Server Info",
                    value: `**${guild.name}**\nID: \`${
                      guild.id
                    }\`\nMembers: **${guild.memberCount || 0}**`,
                    inline: true,
                  },
                  {
                    name: "👑 Owner",
                    value: owner
                      ? `${owner.user.tag}\n\`${owner.id}\``
                      : "Unknown",
                    inline: true,
                  },
                  {
                    name: "📊 Invite Source",
                    value: `**${inviteSource}**${
                      thisSourceStats
                        ? `\n${thisSourceStats.total_joins} total joins from this source`
                        : ""
                    }`,
                    inline: true,
                  },
                ],
                footer: {
                  text: `Total Servers: ${client.guilds.cache.size} | v${version}`,
                },
                timestamp: new Date().toISOString(),
              },
            ],
          };

          // Send to webhook
          const https = require("https");
          const url = new URL(process.env.ADMIN_WEBHOOK_URL);
          const postData = JSON.stringify(webhook);

          const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(postData),
            },
          };

          const req = https.request(options);
          req.write(postData);
          req.end();

          logger.info(
            "Guild Create",
            `Admin notification sent for ${guild.name}`
          );
        } catch (webhookError) {
          logger.error("Guild Create", "Failed to send webhook notification", {
            message: webhookError?.message || String(webhookError),
            stack: webhookError?.stack,
            name: webhookError?.name,
          });
        }
      }
    } catch (error) {
      logger.error("Guild Create", "Failed to track invite source", {
        message: error?.message || String(error),
        stack: error?.stack,
        name: error?.name,
      });
    }

    // Log server join
    try {
      const owner = await guild.fetchOwner().catch(() => null);
      await new Promise((resolve, reject) => {
        db.db.run(
          "INSERT INTO bot_activity_log (event_type, guild_id, guild_name, member_count, owner_id, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          [
            "guild_join",
            guild.id,
            guild.name,
            guild.memberCount || 0,
            owner ? owner.id : null,
            Date.now(),
          ],
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          }
        );
      });
      // Guild join logged to database (no console logging)
    } catch (error) {
      logger.error("Guild Create", "Failed to log guild join", {
        message: error?.message || String(error),
        stack: error?.stack,
        name: error?.name,
      });
    }

    // Automatic role hierarchy check and warning
    try {
      const botMember = await guild.members.fetch(client.user.id);
      const botRole = botMember.roles.highest;

      const allRoles = Array.from(guild.roles.cache.values())
        .filter((r) => r.id !== guild.id)
        .sort((a, b) => b.position - a.position);

      const botRoleIndex = allRoles.findIndex((r) => r.id === botRole.id);

      // If bot role is not at top, send warning
      if (botRoleIndex > 0) {
        const { EmbedBuilder } = require("discord.js");

        const warningEmbed = new EmbedBuilder()
          .setTitle("⚠️ CRITICAL SETUP REQUIRED")
          .setDescription(
            "**Thank you for adding nexus!** However, there's a critical setup step needed for full protection."
          )
          .addFields(
            {
              name: "🔴 Current Status",
              value: `Bot role is at position **${botRoleIndex + 1}/${allRoles.length}**\nThis means nexus **cannot ban/kick users** whose roles are higher.`,
              inline: false,
            },
            {
              name: "✅ Required Action",
              value:
                "**1.** Go to **Server Settings** → **Roles**\n" +
                "**2.** Find the nexus bot role\n" +
                "**3.** Drag it to the **TOP** of the role list\n" +
                "**4.** Save changes",
              inline: false,
            },
            {
              name: "🛡️ Why This Matters",
              value:
                "If a nuke bot joins and gets a role above nexus, **nexus cannot stop it**. " +
                "Detection will work, but action will fail with permission errors. " +
                "Proper role positioning is **essential** for protection.",
              inline: false,
            },
            {
              name: "📝 Verify Setup",
              value:
                "After moving the role, run `/security rolecheck` to verify!",
              inline: false,
            },
            {
              name: "💬 Need Help?",
              value:
                "Join our support server: https://discord.gg/9vQzqBVMNX\nOr check docs: https://sentinelbot-official.github.io/Sentinel/index.htmldocs.html",
              inline: false,
            }
          )
          .setColor(0xff0000)
          .setFooter({
            text: "This is NOT optional - it's required for nexus to work",
          })
          .setTimestamp();

        // Try to send to system channel or owner
        const systemChannel = guild.systemChannel;
        if (
          systemChannel &&
          systemChannel
            .permissionsFor(botMember)
            .has(["ViewChannel", "SendMessages"])
        ) {
          try {
            await systemChannel.send({ embeds: [warningEmbed] });
            logger.info(
              "Guild Create",
              "Sent role hierarchy warning to system channel"
            );
          } catch (sendError) {
            // Permission check passed but send failed - try DM instead
            logger.debug(
              "Guild Create",
              `Failed to send to system channel: ${sendError.message}, trying DM`
            );
            const owner = await guild.fetchOwner().catch(() => null);
            if (owner) {
              await owner.send({ embeds: [warningEmbed] }).catch(() => {
                logger.info(
                  "Guild Create",
                  `   ⚠️ Could not send role hierarchy warning - no accessible channel`
                );
              });
            }
          }
        } else {
          // Try to DM owner
          const owner = await guild.fetchOwner().catch(() => null);
          if (owner) {
            await owner.send({ embeds: [warningEmbed] }).catch(() => {
              logger.info(
                "Guild Create",
                `   ⚠️ Could not send role hierarchy warning - no accessible channel`
              );
            });
          }
        }
      } else {
        logger.info(
          "Guild Create",
          "Bot role is at highest position - optimal setup!"
        );
      }
    } catch (error) {
      logger.error("Guild Create", "Failed to check role hierarchy", {
        message: error?.message || String(error),
        stack: error?.stack,
        name: error?.name,
      });
    }

    // Commands are registered globally, no need to register per-guild
    logger.info(
      "Guild Create",
      `Commands will be available via global registration (may take ~1 hour to propagate)`
    );

    // Create initial recovery snapshot for new servers
    try {
      const AutoRecovery = require("../utils/autoRecovery");
      await AutoRecovery.autoSnapshot(guild, "Initial snapshot on bot join");
      logger.info(
        "Guild Create",
        `📸 Created initial recovery snapshot for ${guild.name} (${guild.id})`
      );

      // Start audit log monitoring for new guild
      if (client.auditLogMonitor) {
        try {
          client.auditLogMonitor.startMonitoring(guild);
        } catch (error) {
          logger.debug(
            "GuildCreate",
            `Could not start audit log monitoring: ${error.message}`
          );
        }
      }
    } catch (error) {
      logger.error(
        "Guild Create",
        `Failed to create initial snapshot for ${guild.name}`,
        {
          message: error?.message || String(error),
          stack: error?.stack,
          name: error?.name,
        }
      );
    }
  },
};
