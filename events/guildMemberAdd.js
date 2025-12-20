const db = require("../utils/database");
const AdvancedAntiRaid = require("../utils/advancedAntiRaid");
const JoinGate = require("../utils/joinGate");
const ErrorHandler = require("../utils/errorHandler");
const logger = require("../utils/logger");
const performanceMonitor = require("../utils/performanceMonitor");

module.exports = {
  name: "guildMemberAdd",
  async execute(member, client) {
    // Member join tracking (no console logging to reduce noise)

    // Track growth analytics
    if (client.growthAnalytics) {
      client.growthAnalytics.trackJoin(
        member.guild.id,
        member.user.id,
        "invite"
      );
    }

    // Track behavioral patterns
    if (client.behavioralFP) {
      client.behavioralFP.trackBehavior(
        member.user.id,
        member.guild.id,
        "join",
        {
          accountAge: Date.now() - member.user.createdTimestamp,
        }
      );
    }

    // Start performance tracking
    const perfId = `member_join_${member.id}_${Date.now()}`;
    performanceMonitor.start(perfId, "member_join_full", {
      guildId: member.guild.id,
      userId: member.id,
    });
    // Run initial checks in parallel for better performance
    const ThreatIntelligence = require("../utils/threatIntelligence");
    const initialChecks = await Promise.all([
      ThreatIntelligence.checkThreat(member.user.id).catch(() => ({
        hasThreat: false,
        riskScore: 0,
      })),
      JoinGate.checkMember(member, member.guild).catch(() => ({
        filtered: false,
      })),
      // Member Screening (EXCEEDS WICK - proactive security)
      client.memberScreening
        ? client.memberScreening
            .screenMember(member, member.guild)
            .catch(() => ({ passed: true }))
        : Promise.resolve({ passed: true }),
      client.workflows
        ? client.workflows
            .checkTriggers(member.guild.id, "guildMemberAdd", {
              user: member.user,
              member: member,
              guild: member.guild,
            })
            .catch((err) => {
              logger.debug(
                `[guildMemberAdd] Workflow trigger failed:`,
                err.message
              );
            })
        : Promise.resolve(),
    ]);

    const threatCheck = initialChecks[0];
    const joinGateCheck = initialChecks[1];
    const screeningResult = initialChecks[2];

    // CRITICAL: Anti-harassment protection for specific guild
    const PROTECTED_GUILD_ID = "1450529013302038639";
    if (member.guild.id === PROTECTED_GUILD_ID) {
      const harassmentDetected = await checkHarassmentProfile(member);
      if (harassmentDetected.detected) {
        logger.warn(
          "HarassmentProtection",
          `🚨 HARASSMENT DETECTED: ${member.user.tag} (${member.id}) - Reason: ${harassmentDetected.reason}`
        );

        try {
          // Ban immediately
          await member.ban({
            reason: `Anti-harassment: ${harassmentDetected.reason}`,
            deleteMessageDays: 1,
          });

          // Log to mod channel if configured
          const config = await db.getServerConfig(member.guild.id);
          if (config && config.mod_log_channel) {
            const logChannel = member.guild.channels.cache.get(
              config.mod_log_channel
            );
            if (logChannel) {
              const { EmbedBuilder } = require("discord.js");
              const embed = new EmbedBuilder()
                .setTitle("🚨 Harassment Protection - Auto-Ban")
                .setDescription(
                  `**User:** ${member.user.tag} (${member.id})\n**Reason:** ${harassmentDetected.reason}\n**Details:** ${harassmentDetected.details || "Profile matched harassment patterns"}`
                )
                .setColor(0xff0000)
                .setThumbnail(member.user.displayAvatarURL())
                .setTimestamp();
              await logChannel.send({ embeds: [embed] }).catch(() => {});
            }
          }

          logger.success(
            "HarassmentProtection",
            `Successfully banned ${member.user.tag} for harassment`
          );
        } catch (error) {
          logger.error(
            "HarassmentProtection",
            `Failed to ban ${member.user.tag}:`,
            error
          );
        }

        return; // Stop all further processing
      }
    }

    // Handle member screening first
    if (screeningResult && !screeningResult.passed) {
      const screeningConfig = await db.getMemberScreeningConfig(
        member.guild.id
      );
      if (client.memberScreening && screeningConfig) {
        await client.memberScreening.executeScreeningAction(
          member,
          screeningResult,
          screeningConfig
        );

        // If banned or kicked, stop further processing
        if (
          screeningResult.action === "ban" ||
          screeningResult.action === "kick"
        ) {
          const totalPerfResult = performanceMonitor.end(perfId);
          if (totalPerfResult) {
            logger.success(
              `🚀 Screening ${
                screeningResult.action
              }: ${totalPerfResult.duration.toFixed(2)}ms`
            );
          }
          return;
        }
      }
    }

    // Handle high threat immediately
    if (threatCheck.hasThreat && threatCheck.riskScore >= 50) {
      const Notifications = require("../utils/notifications");
      await Notifications.send(
        member.guild.id,
        "high_threat",
        {
          userId: member.user.id,
          threatScore: threatCheck.riskScore,
          details: `User has ${threatCheck.threatCount} threat reports in network`,
        },
        client
      ).catch((err) => {
        logger.debug(`[guildMemberAdd] Notification send failed:`, err.message);
      });
    }
    if (joinGateCheck.filtered) {
      // Execute action based on join gate
      if (joinGateCheck.action === "ban") {
        await ErrorHandler.safeExecute(
          () =>
            member.ban({
              reason: `Join Gate: ${joinGateCheck.reason}`,
              deleteMessageDays: 1,
            }),
          `guildMemberAdd [${member.guild.id}]`
        );
        return;
      } else if (joinGateCheck.action === "kick") {
        await ErrorHandler.safeExecute(
          () => member.kick(`Join Gate: ${joinGateCheck.reason}`),
          `guildMemberAdd [${member.guild.id}]`
        );
        return;
      } else if (joinGateCheck.action === "timeout") {
        const constants = require("../utils/constants");
        await ErrorHandler.safeExecute(
          () =>
            member.timeout(
              constants.JOIN_GATE.DEFAULT_TIMEOUT_DURATION,
              `Join Gate: ${joinGateCheck.reason}`
            ),
          `guildMemberAdd [${member.guild.id}]`
        );
      }
    }

    // Check security whitelist FIRST (before anti-raid to prevent false bans)
    const isWhitelisted = await new Promise((resolve, reject) => {
      db.db.get(
        "SELECT * FROM security_whitelist WHERE guild_id = ? AND user_id = ?",
        [member.guild.id, member.id],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        }
      );
    });

    // Skip anti-raid if whitelisted
    if (!isWhitelisted) {
      logger.debug(
        `[guildMemberAdd] Member ${member.user.tag} is not whitelisted, running anti-raid detection`
      );

      // Check advanced anti-raid (multi-algorithm detection)
      const raidPerfId = `raid_detection_${member.id}_${Date.now()}`;
      performanceMonitor.start(raidPerfId, "raid_detection", {
        guildId: member.guild.id,
        userId: member.id,
      });

      logger.debug(
        `[guildMemberAdd] Calling AdvancedAntiRaid.detectRaid for ${member.user.tag}`
      );

      const raidDetected = await AdvancedAntiRaid.detectRaid(
        member.guild,
        member
      );

      const raidPerfResult = performanceMonitor.end(raidPerfId);
      if (raidPerfResult) {
        logger.info(
          `⚡ Raid detection took ${raidPerfResult.duration.toFixed(2)}ms`
        );
      }

      if (raidDetected) {
        // Send notification
        const Notifications = require("../utils/notifications");
        await Notifications.send(
          member.guild.id,
          "raid_detected",
          {
            userCount: 1,
            threatScore: 100,
            details: "Raid detected and handled",
          },
          client
        );

        // Log total response time
        const totalPerfResult = performanceMonitor.end(perfId);
        if (totalPerfResult) {
          logger.success(
            `🚀 Total raid response: ${totalPerfResult.duration.toFixed(
              2
            )}ms (Detection: ${raidPerfResult.duration.toFixed(2)}ms)`
          );
        }

        return; // Advanced system handled it
      }
    }

    // Check account age (common raid indicator)
    const accountAge = Date.now() - member.user.createdTimestamp;
    const daysOld = accountAge / (1000 * 60 * 60 * 24);

    if (daysOld < 7) {
      // Very new account - add heat
      if (
        client.heatSystem &&
        typeof client.heatSystem.addHeat === "function"
      ) {
        await client.heatSystem.addHeat(
          member.guild.id,
          member.id,
          10,
          "New account (< 7 days old)"
        );
      }
    }

    // Check if server is in lockdown
    if (client.antiRaid.lockdown.get(member.guild.id)) {
      // Auto-kick during lockdown
      await ErrorHandler.safeExecute(
        () => member.kick("Server is in lockdown mode"),
        `guildMemberAdd [${member.guild.id}]`
      );
      return;
    }

    // Advanced Verification System
    const config = await db.getServerConfig(member.guild.id);
    if (config && config.verification_enabled && config.verification_role) {
      // Initialize verification system if not already done
      if (!client.verificationSystem) {
        const VerificationSystem = require("../utils/verificationSystem");
        client.verificationSystem = new VerificationSystem(client);
      }
    }

    // Whitelist already checked above, reuse the variable
    if (!isWhitelisted) {
      // Run security check
      const Security = require("../utils/security");
      const threat = await Security.detectThreat(
        member.guild,
        member.user,
        "join"
      );

      // Log security event
      await new Promise((resolve, reject) => {
        db.db.run(
          "INSERT INTO security_logs (guild_id, event_type, user_id, details, threat_score, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          [
            member.guild.id,
            "member_join",
            member.id,
            JSON.stringify({ threat_level: threat.level }),
            threat.score,
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

      // Send alert if configured
      if (config && config.alert_channel && config.alert_threshold) {
        if (threat.score >= config.alert_threshold) {
          const alertChannel = member.guild.channels.cache.get(
            config.alert_channel
          );
          if (alertChannel) {
            alertChannel
              .send({
                embeds: [
                  {
                    title: "🚨 Security Alert",
                    description: `**User:** ${member.user.tag} (${
                      member.id
                    })\n**Threat Score:** ${
                      threat.score
                    }%\n**Level:** ${threat.level.toUpperCase()}\n**Recommended Action:** ${
                      threat.action || "Monitor"
                    }`,
                    color:
                      threat.score >= 80
                        ? 0xff0000
                        : threat.score >= 60
                          ? 0xff8800
                          : 0xffff00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              })
              .catch(
                ErrorHandler.createSafeCatch(
                  `guildMemberAdd [${member.guild.id}]`,
                  `Send security alert for ${member.user.id}`
                )
              );
          }
        }
      }

      // Auto-action based on threat
      if (threat.score >= 80 && threat.action === "ban") {
        const banPerfId = `ban_action_${member.id}_${Date.now()}`;
        performanceMonitor.start(banPerfId, "ban_action", {
          guildId: member.guild.id,
          userId: member.id,
          threatScore: threat.score,
        });

        await ErrorHandler.safeExecute(
          () =>
            member.ban({
              reason: `Security threat detected (Score: ${threat.score})`,
              deleteMessageDays: 1,
            }),
          `guildMemberAdd [${member.guild.id}]`
        );

        const banPerfResult = performanceMonitor.end(banPerfId);
        const totalPerfResult = performanceMonitor.end(perfId);
        if (banPerfResult && totalPerfResult) {
          logger.success(
            `🚀 Ban response: ${banPerfResult.duration.toFixed(
              2
            )}ms | Total: ${totalPerfResult.duration.toFixed(2)}ms`
          );
        }

        return;
      } else if (threat.score >= 60 && threat.action === "kick") {
        const kickPerfId = `kick_action_${member.id}_${Date.now()}`;
        performanceMonitor.start(kickPerfId, "kick_action", {
          guildId: member.guild.id,
          userId: member.id,
          threatScore: threat.score,
        });

        await ErrorHandler.safeExecute(
          () =>
            member.kick(`Security threat detected (Score: ${threat.score})`),
          `guildMemberAdd [${member.guild.id}]`
        );

        const kickPerfResult = performanceMonitor.end(kickPerfId);
        const totalPerfResult = performanceMonitor.end(perfId);
        if (kickPerfResult && totalPerfResult) {
          logger.success(
            `🚀 Kick response: ${kickPerfResult.duration.toFixed(
              2
            )}ms | Total: ${totalPerfResult.duration.toFixed(2)}ms`
          );
        }

        return;
      }
    }

    // Send welcome message (reuse config from above)
    if (config && config.welcome_channel && config.welcome_message) {
      const welcomeChannel = member.guild.channels.cache.get(
        config.welcome_channel
      );
      if (welcomeChannel && welcomeChannel.isTextBased()) {
        // Check if bot has permission to send messages in this channel
        const botMember = member.guild.members.me;
        const canSend = welcomeChannel
          .permissionsFor(botMember)
          ?.has(["ViewChannel", "SendMessages"]);

        if (canSend) {
          const message = config.welcome_message
            .replace(/{user}/g, member.toString())
            .replace(/{server}/g, member.guild.name)
            .replace(/{membercount}/g, member.guild.memberCount);

          welcomeChannel
            .send({
              embeds: [
                {
                  title: "👋 Welcome!",
                  description: message,
                  color: 0x00ff00,
                  thumbnail: {
                    url: member.user.displayAvatarURL({ dynamic: true }),
                  },
                },
              ],
            })
            .catch(
              ErrorHandler.createSafeCatch(
                `guildMemberAdd [${member.guild.id}]`,
                `Send welcome message for ${member.user.id}`
              )
            );
        } else {
          // Silently skip if bot doesn't have permissions (don't log as error)
          logger.debug(
            `[guildMemberAdd] Skipping welcome message - bot lacks permissions in channel ${config.welcome_channel} for guild ${member.guild.id}`
          );
        }
      } else {
        // Channel doesn't exist, isn't accessible, or isn't text-based - silently skip
        if (welcomeChannel && !welcomeChannel.isTextBased()) {
          logger.debug(
            `[guildMemberAdd] Welcome channel ${config.welcome_channel} is not a text channel for guild ${member.guild.id}`
          );
        } else {
          logger.debug(
            `[guildMemberAdd] Welcome channel ${config.welcome_channel} not found or inaccessible for guild ${member.guild.id}`
          );
        }
      }
    }

    // Auto-role assignment
    const autoRoles = await new Promise((resolve, reject) => {
      db.db.all(
        "SELECT role_id FROM auto_roles WHERE guild_id = ? AND type = ?",
        [member.guild.id, "join"],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });

    for (const autoRole of autoRoles) {
      try {
        const role = member.guild.roles.cache.get(autoRole.role_id);
        if (!role) {
          continue;
        } // Role doesn't exist anymore

        // Check if bot has Manage Roles permission
        const botMember = member.guild.members.me;
        if (!botMember.permissions.has("ManageRoles")) {
          logger.warn(
            "GuildMemberAdd",
            `Cannot assign auto-role: Missing ManageRoles permission in ${member.guild.name}`
          );
          continue;
        }

        // Check if bot's role is high enough
        if (botMember.roles.highest.position <= role.position) {
          logger.warn(
            "GuildMemberAdd",
            `Cannot assign role ${role.name}: Bot's role is too low in hierarchy`
          );
          continue;
        }

        // Check if role is manageable (not managed by integration)
        if (role.managed) {
          logger.warn(
            "GuildMemberAdd",
            `Cannot assign role ${role.name}: Role is managed by integration`
          );
          continue;
        }

        await member.roles.add(role);
      } catch (error) {
        // Handle "Unknown Role" error (role was deleted but still in database)
        if (
          error.code === 10011 ||
          (error.message && error.message.includes("Unknown Role"))
        ) {
          logger.warn(
            "GuildMemberAdd",
            `Auto-role ${autoRole.role_id} no longer exists in ${member.guild.name}, removing from database`
          );
          // Remove the invalid autorole from database
          db.db.run(
            "DELETE FROM auto_roles WHERE guild_id = ? AND role_id = ?",
            [member.guild.id, autoRole.role_id],
            (err) => {
              if (err) {
                logger.error(
                  "GuildMemberAdd",
                  "Failed to remove invalid autorole from database",
                  err
                );
              }
            }
          );
          continue;
        }
        // Log other errors
        ErrorHandler.logError(
          error,
          `guildMemberAdd [${member.guild.id}]`,
          `Assign auto-role ${autoRole.role_id} to ${member.user.id}`
        );
      }
    }

    // Log analytics
    await db.logAnalytics(member.guild.id, "member_join", {
      user_id: member.id,
      account_age_days: daysOld,
    });

    // Enhanced logging
    const EnhancedLogging = require("../utils/enhancedLogging");
    await EnhancedLogging.log(member.guild.id, "member_join", "member", {
      userId: member.id,
      action: "join",
      details: `Member joined: ${member.user.tag} (${member.user.id})`,
      metadata: {
        username: member.user.username,
        discriminator: member.user.discriminator,
        accountAge: Date.now() - member.user.createdTimestamp,
        hasAvatar: !!member.user.avatar,
        isBot: member.user.bot,
      },
      severity: "info",
    });

    // Check for mod log channel (reuse config from above)
    if (config && config.mod_log_channel) {
      const logChannel = member.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (logChannel) {
        const { EmbedBuilder } = require("discord.js");
        const embed = new EmbedBuilder()
          .setTitle("✅ Member Joined")
          .setDescription(`**${member.user.tag}** joined the server`)
          .addFields(
            {
              name: "User",
              value: `${member.user} (${member.user.id})`,
              inline: true,
            },
            {
              name: "Account Created",
              value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
              inline: true,
            },
            {
              name: "Account Age",
              value: `${Math.floor(
                (Date.now() - member.user.createdTimestamp) / 86400000
              )} days`,
              inline: true,
            }
          )
          .setColor(0x00ff00)
          .setThumbnail(member.user.displayAvatarURL())
          .setTimestamp();

        logChannel
          .send({ embeds: [embed] })
          .catch(
            ErrorHandler.createSafeCatch(
              `guildMemberAdd [${member.guild.id}]`,
              `Send mod log for member join`
            )
          );
      }
    }

    // End performance tracking for normal joins
    const totalPerfResult = performanceMonitor.end(perfId);
    if (totalPerfResult && totalPerfResult.duration > 100) {
      // Only log if took more than 100ms
      logger.warn(
        `⚠️ Slow member join processing: ${totalPerfResult.duration.toFixed(
          2
        )}ms for ${member.user.tag}`
      );
    }
  },
};

/**
 * Check if a member's profile contains harassment-related content
 * @param {GuildMember} member - The member to check
 * @returns {Promise<{detected: boolean, reason: string, details: string}>}
 */
async function checkHarassmentProfile(member) {
  // Load personal info filters from private JSON file
  let suspiciousKeywords = [];
  let addressVariations = [];

  try {
    const fs = require("fs");
    const path = require("path");
    const filtersPath = path.join(__dirname, "..", "harassment-filters.json");

    if (fs.existsSync(filtersPath)) {
      const filtersData = JSON.parse(fs.readFileSync(filtersPath, "utf8"));
      suspiciousKeywords = filtersData.personalInfo?.names || [];
      addressVariations = filtersData.personalInfo?.addresses || [];
    } else {
      logger.warn(
        "HarassmentProtection",
        "harassment-filters.json not found - personal info protection disabled"
      );
    }
  } catch (error) {
    logger.error(
      "HarassmentProtection",
      "Failed to load harassment-filters.json:",
      error
    );
  }

  // Comprehensive toxic content detection
  const toxicKeywords = [
    // Threats & Violence
    "kill",
    "murder",
    "die",
    "kys",
    "neck yourself",
    "hang yourself",
    "shoot",
    "bomb",
    "terrorist",
    "rape",
    "molest",
    "assault",
    "hurt",
    "stab",
    "strangle",
    "torture",
    // Slurs (racial)
    "nigger",
    "nigga",
    "chink",
    "gook",
    "spic",
    "wetback",
    "beaner",
    "kike",
    "hymie",
    "towelhead",
    "raghead",
    "sandnigger",
    "paki",
    "coon",
    "jigaboo",
    "porch monkey",
    // Slurs (homophobic/transphobic)
    "faggot",
    "fag",
    "tranny",
    "shemale",
    "dyke",
    "queer",
    // Slurs (other)
    "retard",
    "retarded",
    "autist",
    "autistic",
    "downy",
    "mongoloid",
    "cripple",
    // Sexual harassment
    "pedo",
    "pedophile",
    "kiddie fiddler",
    "rapist",
    "pervert",
    "whore",
    "slut",
    "prostitute",
    // Nazi/hate symbols
    "nazi",
    "hitler",
    "swastika",
    "heil",
    "white power",
    "white supremacy",
    "kkk",
    "aryan",
    // Doxxing/harassment
    "dox",
    "doxx",
    "swat",
    "swatting",
    "leak",
    "expose",
    // Self-harm encouragement
    "cut yourself",
    "slit your wrists",
    "overdose",
    "jump off",
    // Common variations/bypasses
    "k1ll",
    "d1e",
    "n1gger",
    "f4ggot",
    "r4pe",
    "k!ll",
    "d!e",
  ];

  /**
   * Normalize Unicode text to strip fancy fonts and special characters
   * Handles bold, italic, script, and other Unicode variations
   */
  const normalizeUnicode = (text) => {
    if (!text) return "";

    // Unicode ranges for fancy fonts (Mathematical Alphanumeric Symbols)
    const unicodeMappings = {
      // Bold
      "𝐀-𝐙": "A-Z",
      "𝐚-𝐳": "a-z",
      "𝟎-𝟗": "0-9",
      // Italic
      "𝐴-𝑍": "A-Z",
      "𝑎-𝑧": "a-z",
      // Bold Italic
      "𝑨-𝒁": "A-Z",
      "𝒂-𝒛": "a-z",
      // Script
      "𝒜-𝒵": "A-Z",
      "𝒶-𝓏": "a-z",
      // Bold Script
      "𝓐-𝓩": "A-Z",
      "𝓪-𝔃": "a-z",
      // Fraktur
      "𝔄-𝔜": "A-Z",
      "𝔞-𝔷": "a-z",
      // Bold Fraktur
      "𝕬-𝖅": "A-Z",
      "𝖆-𝖟": "a-z",
      // Double-struck
      "𝔸-ℤ": "A-Z",
      "𝕒-𝕫": "a-z",
      "𝟘-𝟡": "0-9",
      // Sans-serif
      "𝖠-𝖹": "A-Z",
      "𝖺-𝗓": "a-z",
      "𝟢-𝟫": "0-9",
      // Bold Sans-serif
      "𝗔-𝗭": "A-Z",
      "𝗮-𝘇": "a-z",
      "𝟬-𝟵": "0-9",
      // Italic Sans-serif
      "𝘈-𝘡": "A-Z",
      "𝘢-𝘻": "a-z",
      // Bold Italic Sans-serif
      "𝘼-𝙕": "A-Z",
      "𝙖-𝙯": "a-z",
      // Monospace
      "𝙰-𝚉": "A-Z",
      "𝚊-𝚣": "a-z",
      "𝟶-𝟿": "0-9",
    };

    // Individual character mappings for special cases
    const charMap = {
      // Common number/letter substitutions
      "0": "o",
      "1": "i",
      "3": "e",
      "4": "a",
      "5": "s",
      "7": "t",
      "8": "b",
      "@": "a",
      "$": "s",
      "!": "i",
      "|": "i",
      // Special spaces and separators
      "\u00A0": " ", // Non-breaking space
      "\u2000": " ", // En quad
      "\u2001": " ", // Em quad
      "\u2002": " ", // En space
      "\u2003": " ", // Em space
      "\u2004": " ", // Three-per-em space
      "\u2005": " ", // Four-per-em space
      "\u2006": " ", // Six-per-em space
      "\u2007": " ", // Figure space
      "\u2008": " ", // Punctuation space
      "\u2009": " ", // Thin space
      "\u200A": " ", // Hair space
      "\u200B": "", // Zero-width space
      "\u200C": "", // Zero-width non-joiner
      "\u200D": "", // Zero-width joiner
      "\uFEFF": "", // Zero-width no-break space
      // Remove all diacritics/accents
    };

    let normalized = text;

    // Map Unicode fancy fonts to normal characters
    for (const [fancy, normal] of Object.entries(unicodeMappings)) {
      const fancyStart = fancy.split("-")[0].codePointAt(0);
      const fancyEnd = fancy.split("-")[1].codePointAt(0);
      const normalStart = normal.split("-")[0].charCodeAt(0);

      for (let i = fancyStart; i <= fancyEnd; i++) {
        const fancyChar = String.fromCodePoint(i);
        const normalChar = String.fromCharCode(normalStart + (i - fancyStart));
        normalized = normalized.replace(new RegExp(fancyChar, "g"), normalChar);
      }
    }

    // Apply character mappings
    for (const [special, normal] of Object.entries(charMap)) {
      normalized = normalized.replace(new RegExp(special, "g"), normal);
    }

    // Use NFD normalization to decompose characters, then remove diacritics
    normalized = normalized
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    // Remove remaining special characters except alphanumeric and basic punctuation
    normalized = normalized.replace(/[^\w\s.,!?-]/g, "");

    // Collapse multiple spaces
    normalized = normalized.replace(/\s+/g, " ").trim();

    return normalized;
  };

  // Helper function to check if text contains any keywords (case-insensitive)
  const containsKeyword = (text, keywords) => {
    if (!text) return null;
    
    // Normalize text to strip Unicode fonts and special chars
    const normalizedText = normalizeUnicode(text);
    const lowerText = normalizedText.toLowerCase();
    
    for (const keyword of keywords) {
      // For multi-word keywords like "george stephen adams", check as whole phrase
      if (keyword.includes(" ")) {
        if (lowerText.includes(keyword)) {
          return keyword;
        }
      } else {
        // For single words, check as whole word (with word boundaries)
        const regex = new RegExp(`\\b${keyword}\\b`, "i");
        if (regex.test(lowerText)) {
          return keyword;
        }
      }
    }
    return null;
  };

  try {
    // Fetch full user to get bio/about me
    const fullUser = await member.user.fetch(true);

    // Check username for harassment keywords
    const usernameMatch = containsKeyword(
      fullUser.username,
      suspiciousKeywords
    );
    if (usernameMatch) {
      return {
        detected: true,
        reason: `Username contains '${usernameMatch}'`,
        details: `Username: ${fullUser.username}`,
      };
    }

    // Check username for toxic content
    const usernameToxic = containsKeyword(fullUser.username, toxicKeywords);
    if (usernameToxic) {
      return {
        detected: true,
        reason: `Username contains toxic content: '${usernameToxic}'`,
        details: `Username: ${fullUser.username}`,
      };
    }

    // Check global display name (Discord's new global display name feature)
    if (fullUser.globalName) {
      const displayNameMatch = containsKeyword(
        fullUser.globalName,
        suspiciousKeywords
      );
      if (displayNameMatch) {
        return {
          detected: true,
          reason: `Display name contains '${displayNameMatch}'`,
          details: `Display name: ${fullUser.globalName}`,
        };
      }

      // Check display name for toxic content
      const displayNameToxic = containsKeyword(
        fullUser.globalName,
        toxicKeywords
      );
      if (displayNameToxic) {
        return {
          detected: true,
          reason: `Display name contains toxic content: '${displayNameToxic}'`,
          details: `Display name: ${fullUser.globalName}`,
        };
      }
    }

    // Check guild nickname
    if (member.nickname) {
      const nicknameMatch = containsKeyword(
        member.nickname,
        suspiciousKeywords
      );
      if (nicknameMatch) {
        return {
          detected: true,
          reason: `Server nickname contains '${nicknameMatch}'`,
          details: `Nickname: ${member.nickname}`,
        };
      }

      // Check nickname for toxic content
      const nicknameToxic = containsKeyword(member.nickname, toxicKeywords);
      if (nicknameToxic) {
        return {
          detected: true,
          reason: `Server nickname contains toxic content: '${nicknameToxic}'`,
          details: `Nickname: ${member.nickname}`,
        };
      }
    }

    // Check bio/about me (if available)
    // Note: User bios are in the "about me" field but Discord.js doesn't expose it directly
    // We'll use banner/bio if available through the API
    if (fullUser.bio) {
      const bioMatch =
        containsKeyword(fullUser.bio, suspiciousKeywords) ||
        containsKeyword(fullUser.bio, addressVariations) ||
        containsKeyword(fullUser.bio, toxicKeywords);
      if (bioMatch) {
        return {
          detected: true,
          reason: `Bio contains prohibited content: '${bioMatch}'`,
          details: `Bio: ${fullUser.bio.substring(0, 100)}...`,
        };
      }
    }

    // Check for address or toxic content in any text field (final catch-all)
    const allText = [
      fullUser.username,
      fullUser.globalName,
      member.nickname,
      fullUser.bio,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const addressMatch = containsKeyword(allText, addressVariations);
    if (addressMatch) {
      return {
        detected: true,
        reason: `Profile contains address variation '${addressMatch}'`,
        details: "Address detected in profile",
      };
    }

    const toxicMatch = containsKeyword(allText, toxicKeywords);
    if (toxicMatch) {
      return {
        detected: true,
        reason: `Profile contains toxic content: '${toxicMatch}'`,
        details: "Toxic content detected in profile",
      };
    }

    // Profile picture check - we can't do face recognition, but we can log the avatar URL for manual review
    // Store avatar URL in logs for later review if needed
    logger.debug(
      "HarassmentProtection",
      `Profile check passed for ${fullUser.tag} (${fullUser.id}) | Avatar: ${fullUser.displayAvatarURL()}`
    );

    return {
      detected: false,
      reason: null,
      details: null,
    };
  } catch (error) {
    logger.error(
      "HarassmentProtection",
      `Error checking profile for ${member.user.tag}:`,
      error
    );
    // If we can't check, let them through (don't false positive)
    return {
      detected: false,
      reason: null,
      details: null,
    };
  }
}
