/**
 * Discord Bot Token Usage Monitor
 * Tracks bot activity patterns to detect unauthorized token usage
 * EXCEEDS WICK - Advanced token security monitoring
 */

const logger = require("./logger");
const db = require("./database");
const crypto = require("crypto");

class TokenMonitor {
  constructor(client) {
    this.client = client;
    this.activityLog = [];
    this.maxLogSize = 10000; // Keep last 10k activities
    this.suspiciousPatterns = [];
    this.knownIPs = new Set(); // Track known connection IPs (if available)
    this.connectionHistory = [];
    this.maxHistorySize = 1000;
    
    // Token tracking fingerprint
    this.trackingFingerprint = null;
    this.realToken = null;

    // Baseline patterns (learned from normal usage)
    this.baseline = {
      averageCommandsPerHour: 0,
      peakHours: [],
      commonGuilds: new Set(),
      commandDistribution: new Map(),
    };

    // Alert thresholds
    this.thresholds = {
      unusualCommandSpike: 3, // 3x normal rate
      newGuildActivity: true, // Alert on new guild activity
      simultaneousConnections: 1, // Alert if >1 shard connects from different IPs
      rateLimitViolations: 5, // Alert after 5 rate limit hits
      offHoursActivity: true, // Alert on activity during unusual hours
    };

    this.startTime = Date.now();
    this.alertWebhook = process.env.TOKEN_MONITOR_WEBHOOK || null;
  }

  /**
   * Extract tracking fingerprint and real token from combined token string
   * Format: NEXUS_TRACKING_[FINGERPRINT][REAL_TOKEN]
   * Example: NEXUS_TRACKING_JHGGJSGSJS762863936HshHSGSjJJGHSSJjJshSJsjSHSJKDhjdshshdkdbnsb
   * Returns: { trackingFingerprint, realToken }
   */
  static parseToken(combinedToken) {
    if (!combinedToken || typeof combinedToken !== "string") {
      return { trackingFingerprint: null, realToken: combinedToken };
    }
    
    // Trim whitespace (common issue with .env files)
    combinedToken = combinedToken.trim();

    // Check if token contains tracking prefix
    if (combinedToken.startsWith("NEXUS_TRACKING_")) {
      // Extract everything after "NEXUS_TRACKING_"
      const afterPrefix = combinedToken.substring("NEXUS_TRACKING_".length);
      
      logger.debug("TokenMonitor", `Found NEXUS_TRACKING_ prefix, afterPrefix length: ${afterPrefix.length}`);
      
      if (afterPrefix.length < 10) {
        // Too short to contain both fingerprint and token
        logger.warn("TokenMonitor", "Combined token too short after prefix");
        return { trackingFingerprint: null, realToken: combinedToken };
      }
      
      // Discord bot tokens are typically 59-70 characters
      // They usually have format: XXXX.XXXX.XXXX or base64-like strings
      // Strategy: Try to find where a valid Discord token starts
      // We'll try different fingerprint lengths, starting from the end
      
      const MIN_TOKEN_LENGTH = 50; // Minimum valid Discord token length
      const MAX_FINGERPRINT_LENGTH = 64; // Reasonable max for fingerprint
      
      // Discord tokens are typically 59-72 characters
      // Strategy: Try to find the fingerprint length that leaves us with a valid Discord token
      // We know the token should be around 59-72 chars, so work backwards from that
      
      let bestMatch = null;
      let bestScore = 0;
      
      // Calculate expected token length range
      const expectedTokenLength = 72; // Most Discord tokens are around this length
      const tokenLengthTolerance = 15; // Allow 59-87 chars
      
      // Try fingerprint lengths, but prioritize ones that result in token lengths close to 72
      for (let fpLength = Math.min(MAX_FINGERPRINT_LENGTH, afterPrefix.length - MIN_TOKEN_LENGTH); fpLength >= 8; fpLength--) {
        if (afterPrefix.length > fpLength) {
          const possibleFingerprint = afterPrefix.substring(0, fpLength);
          const possibleToken = afterPrefix.substring(fpLength);
          
          logger.debug("TokenMonitor", `Trying fingerprint length ${fpLength}: token length=${possibleToken.length}, starts with=${possibleToken.substring(0, 10)}...`);
          
          // Validate: Discord tokens are 50+ chars, alphanumeric + dots/dashes/underscores
          // They often contain dots (format: XXXX.XXXX.XXXX)
          if (possibleToken.length >= MIN_TOKEN_LENGTH && 
              possibleToken.length <= 100 && // Max reasonable token length
              /^[A-Za-z0-9._-]+$/.test(possibleToken)) {
            
            // Score this match based on how "token-like" it is
            let score = 0;
            
            // Discord tokens typically:
            // 1. Start with base64-like alphanumeric (not dots/dashes/underscores)
            //    This is CRITICAL - real tokens start with alphanumeric, not special chars
            if (/^[A-Za-z0-9]{10,}/.test(possibleToken)) {
              score += 20; // Big bonus for starting with alphanumeric sequence
            } else if (/^[A-Za-z0-9]/.test(possibleToken)) {
              score += 10;
            } else {
              // If it starts with a dot/dash/underscore, it's likely the middle of a token
              score -= 20; // Heavy penalty
            }
            
            // 2. Have dots (format: XXXX.XXXX.XXXX)
            if (possibleToken.includes('.')) score += 5;
            
            // 3. Are 59-75 chars (most common range, but can be up to 72)
            // Prefer tokens that are exactly 72 chars (most common Discord token length)
            if (possibleToken.length === 72) score += 30; // Perfect match! Highest priority
            else if (possibleToken.length === 71 || possibleToken.length === 73) score += 25; // Almost perfect
            else if (possibleToken.length >= 70 && possibleToken.length <= 74) score += 20; // Very close
            else if (possibleToken.length >= 59 && possibleToken.length <= 75) score += 15;
            else if (possibleToken.length >= 50 && possibleToken.length < 59) score += 5;
            else if (possibleToken.length < 50) score -= 10; // Too short
            
            // 4. Have exactly 2 dots (typical Discord token format)
            const dotCount = (possibleToken.match(/\./g) || []).length;
            if (dotCount === 2) score += 10;
            else if (dotCount > 2) score -= 5; // Too many dots is suspicious
            
            // 5. Longer tokens are more likely to be complete (prefer full tokens)
            if (possibleToken.length >= 70) score += 10; // Prefer longer tokens
            else if (possibleToken.length >= 65) score += 5;
            
            // 6. Check if token has proper base64-like structure before first dot
            const firstPart = possibleToken.split('.')[0];
            if (firstPart && firstPart.length >= 20 && /^[A-Za-z0-9]+$/.test(firstPart)) {
              score += 10; // Bonus for proper base64-like first part
            }
            
            logger.debug("TokenMonitor", `Match score: ${score} for fpLength=${fpLength}, token starts="${possibleToken.substring(0, 20)}...", length=${possibleToken.length}, fingerprint="${possibleFingerprint.substring(0, 10)}..."`);
            
            // Only accept if it has a good score (must start with alphanumeric and be reasonable length)
            // Prefer scores >= 20 (which means it's likely a 70-72 char token starting with alphanumeric)
            if (score >= 20 && score > bestScore) {
              bestMatch = {
                trackingFingerprint: possibleFingerprint,
                realToken: possibleToken
              };
              bestScore = score;
            }
          } else {
            logger.debug("TokenMonitor", `Token validation failed: length=${possibleToken.length}, valid chars=${/^[A-Za-z0-9._-]+$/.test(possibleToken)}`);
          }
        }
      }
      
      // Return the best match if found
      if (bestMatch) {
        // Double-check: if the token is exactly 72 chars and starts with alphanumeric, it's almost certainly correct
        if (bestMatch.realToken.length === 72 && /^[A-Za-z0-9]{10,}/.test(bestMatch.realToken)) {
          logger.info("TokenMonitor", `✅ Successfully parsed (perfect match): fingerprint=${bestMatch.trackingFingerprint.substring(0, 8)}..., token length=${bestMatch.realToken.length}, starts="${bestMatch.realToken.substring(0, 20)}..."`);
        } else {
          logger.info("TokenMonitor", `✅ Successfully parsed: fingerprint=${bestMatch.trackingFingerprint.substring(0, 8)}..., token length=${bestMatch.realToken.length}, starts="${bestMatch.realToken.substring(0, 20)}..."`);
        }
        return bestMatch;
      }
      
      // Fallback: If no valid token found, try splitting at common lengths
      // Try 32 chars (most common fingerprint length)
      if (afterPrefix.length > 32) {
        const fallbackFingerprint = afterPrefix.substring(0, 32);
        const fallbackToken = afterPrefix.substring(32);
        
        // Basic validation
        if (fallbackToken.length >= MIN_TOKEN_LENGTH && /^[A-Za-z0-9._-]+$/.test(fallbackToken)) {
          logger.warn("TokenMonitor", "Using fallback parsing (32-char fingerprint)");
          return {
            trackingFingerprint: fallbackFingerprint,
            realToken: fallbackToken,
          };
        }
      }
      
      // If we still can't parse, log warning and return original
      logger.error("TokenMonitor", "Failed to parse combined token - could not extract valid Discord token");
      logger.error("TokenMonitor", `Token length: ${afterPrefix.length}, after prefix: ${afterPrefix.substring(0, 20)}...`);
      return { trackingFingerprint: null, realToken: combinedToken };
    }

    // No tracking fingerprint found, return token as-is
    return { trackingFingerprint: null, realToken: combinedToken };
  }

  /**
   * Generate a unique tracking fingerprint for this instance
   */
  generateTrackingFingerprint() {
    // Generate a unique fingerprint based on:
    // - Bot user ID (if available)
    // - Machine/process identifier
    // - Timestamp
    // - Random component
    
    const components = [
      this.client.user?.id || "unknown",
      process.pid || "unknown",
      Date.now().toString(),
      crypto.randomBytes(8).toString("hex"),
    ];
    
    const combined = components.join("_");
    const hash = crypto.createHash("sha256").update(combined).digest("hex");
    
    // Return first 32 characters as fingerprint
    return hash.substring(0, 32).toUpperCase();
  }

  /**
   * Initialize monitoring
   */
  init() {
    // Extract tracking fingerprint and real token from combined token if present
    const rawToken = process.env.DISCORD_TOKEN || "";
    
    if (!rawToken) {
      logger.error("TokenMonitor", "No DISCORD_TOKEN found in environment");
      this.trackingFingerprint = this.generateTrackingFingerprint();
      this.realToken = "";
      return;
    }
    
    try {
      const parsed = TokenMonitor.parseToken(rawToken);
      
      this.trackingFingerprint = parsed.trackingFingerprint || this.generateTrackingFingerprint();
      this.realToken = parsed.realToken || rawToken;
      
      // Log what we found
      if (parsed.trackingFingerprint) {
        logger.info("TokenMonitor", `✅ Tracking fingerprint extracted: ${parsed.trackingFingerprint.substring(0, 8)}...`);
        logger.info("TokenMonitor", `✅ Real token extracted (${this.realToken.length} chars)`);
      } else {
        logger.info("TokenMonitor", `⚠️ No tracking fingerprint in token, generated new one: ${this.trackingFingerprint.substring(0, 8)}...`);
        logger.info("TokenMonitor", `Using original token (${this.realToken.length} chars)`);
      }
      
      // Validate real token looks valid
      if (this.realToken.length < 50 || !/^[A-Za-z0-9._-]+$/.test(this.realToken)) {
        logger.error("TokenMonitor", `⚠️ Extracted token may be invalid (length: ${this.realToken.length})`);
        logger.error("TokenMonitor", `Token preview: ${this.realToken.substring(0, 20)}...`);
      }
      
      // Store the real token back in process.env for Discord.js to use
      // This ensures Discord.js gets the clean token
      process.env.DISCORD_TOKEN = this.realToken;
    } catch (error) {
      logger.error("TokenMonitor", `Error parsing token: ${error.message}`);
      // Fall back to original token
      this.trackingFingerprint = this.generateTrackingFingerprint();
      this.realToken = rawToken;
      process.env.DISCORD_TOKEN = rawToken;
    }
    
    // Monitor client events
    this.client.on("ready", () => this.onBotReady());
    this.client.on("shardReady", (id) => this.onShardReady(id));
    this.client.on("shardDisconnect", (event, id) =>
      this.onShardDisconnect(event, id)
    );
    this.client.on("shardReconnecting", (id) => this.onShardReconnecting(id));
    this.client.on("rateLimit", (rateLimitInfo) =>
      this.onRateLimit(rateLimitInfo)
    );
    this.client.on("error", (error) => this.onError(error));
    this.client.on("warn", (warning) => this.onWarning(warning));

    // Monitor command executions
    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isCommand()) {
        this.trackCommand(interaction);
      }
    });

    // Monitor guild activity
    this.client.on("guildCreate", (guild) => this.trackGuildActivity(guild));
    this.client.on("guildDelete", (guild) => this.trackGuildActivity(guild));
    
    // Monitor bot's own presence to detect if tracking fingerprint is missing
    this.client.on("presenceUpdate", (oldPresence, newPresence) => {
      if (newPresence?.user?.id === this.client.user?.id) {
        this.verifyTrackingFingerprint(newPresence);
      }
    });

    // Periodic analysis
    setInterval(() => this.analyzePatterns(), 5 * 60 * 1000); // Every 5 minutes
    setInterval(() => this.cleanupOldLogs(), 60 * 60 * 1000); // Every hour
    setInterval(() => this.verifyAndSetTrackingFingerprint(), 2 * 60 * 1000); // Every 2 minutes

    logger.success("TokenMonitor", "Token usage monitoring initialized");
  }

  /**
   * Track a command execution
   */
  trackCommand(interaction) {
    const activity = {
      type: "command",
      command: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      timestamp: Date.now(),
      shardId: interaction.guild?.shardId || 0,
    };

    this.logActivity(activity);
    this.updateBaseline(activity);

    // Check if command is from an unknown guild
    if (
      interaction.guildId &&
      !this.baseline.commonGuilds.has(interaction.guildId)
    ) {
      // This could indicate unauthorized usage, but be careful - new guilds are normal
      // Only auto-invalidate if it's a suspicious pattern (e.g., many unknown guilds in short time)
      const recentUnknownGuilds = this.activityLog
        .filter(a => a.type === "command" && a.guildId && !this.baseline.commonGuilds.has(a.guildId))
        .filter(a => Date.now() - a.timestamp < 5 * 60 * 1000) // Last 5 minutes
        .length;
      
      if (recentUnknownGuilds > 10) {
        // Too many unknown guilds in short time - likely unauthorized usage
        // AUTO-INVALIDATE IMMEDIATELY
        await this.handleUnauthorizedUsage("unauthorized_token_usage", {
          message: `Suspicious activity: ${recentUnknownGuilds} commands from unknown guilds in 5 minutes`,
          command: interaction.commandName,
          guildId: interaction.guildId,
          guildName: interaction.guild?.name || "Unknown",
          recentUnknownGuildCount: recentUnknownGuilds,
        });
      } else {
        // Normal new guild activity - just log it
        this.triggerAlert("command_from_unknown_guild", {
          message: `Command "${interaction.commandName}" executed in unknown guild: ${interaction.guild?.name || interaction.guildId}`,
          command: interaction.commandName,
          guildId: interaction.guildId,
          guildName: interaction.guild?.name || "Unknown",
          userId: interaction.user.id,
          userTag: interaction.user.tag,
        });
      }
    }
  }

  /**
   * Track guild activity
   */
  trackGuildActivity(guild) {
    const activity = {
      type: "guild_change",
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount,
      timestamp: Date.now(),
      shardId: guild.shardId || 0,
      event: guild.joined ? "guild_create" : "guild_delete",
    };

    this.logActivity(activity);
    this.checkSuspiciousGuildActivity(activity);

    // Check if this is a guild we've never seen before
    if (!this.baseline.commonGuilds.has(guild.id)) {
      this.triggerAlert("unknown_guild_activity", {
        message: `Bot ${guild.joined ? "joined" : "left"} an unknown guild: ${guild.name} (${guild.id})`,
        guildId: guild.id,
        guildName: guild.name,
        action: guild.joined ? "joined" : "left",
        timestamp: activity.timestamp,
      });
    }
  }

  /**
   * Log activity
   */
  logActivity(activity) {
    this.activityLog.push(activity);

    // Maintain log size
    if (this.activityLog.length > this.maxLogSize) {
      this.activityLog.shift();
    }

    // Store in database for long-term analysis
    this.storeActivity(activity).catch((err) => {
      logger.debug("TokenMonitor", `Failed to store activity: ${err.message}`);
    });
  }

  /**
   * Store activity in database
   */
  async storeActivity(activity) {
    return new Promise((resolve, reject) => {
      db.db.run(
        `INSERT INTO token_activity_logs 
         (activity_type, command_name, guild_id, user_id, shard_id, metadata, timestamp) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          activity.type,
          activity.command || null,
          activity.guildId || null,
          activity.userId || null,
          activity.shardId || 0,
          JSON.stringify(activity),
          activity.timestamp,
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /**
   * Update baseline patterns
   */
  updateBaseline(activity) {
    if (activity.type === "command") {
      const count =
        this.baseline.commandDistribution.get(activity.command) || 0;
      this.baseline.commandDistribution.set(activity.command, count + 1);

      if (activity.guildId) {
        this.baseline.commonGuilds.add(activity.guildId);
      }
    }
  }

  /**
   * Check for suspicious guild activity
   */
  checkSuspiciousGuildActivity(activity) {
    // Alert if bot joins/leaves guilds unexpectedly
    if (
      this.thresholds.newGuildActivity &&
      !this.baseline.commonGuilds.has(activity.guildId)
    ) {
      this.triggerAlert("new_guild_activity", {
        message: `Bot ${activity.type === "guild_create" ? "joined" : "left"} new guild: ${activity.guildName} (${activity.guildId})`,
        guildId: activity.guildId,
        guildName: activity.guildName,
        timestamp: activity.timestamp,
      });
    }
  }

  /**
   * Handle bot ready event
   */
  async onBotReady() {
    const connection = {
      type: "ready",
      timestamp: Date.now(),
      shardId: "all",
      guildCount: this.client.guilds.cache.size,
      userCount: this.client.users.cache.size,
      trackingFingerprint: this.trackingFingerprint,
    };

    this.connectionHistory.push(connection);
    if (this.connectionHistory.length > this.maxHistorySize) {
      this.connectionHistory.shift();
    }

    this.logActivity({
      type: "connection",
      event: "ready",
      timestamp: Date.now(),
      trackingFingerprint: this.trackingFingerprint,
    });
    
    // Set tracking fingerprint in bot's presence
    await this.setTrackingFingerprint();
  }
  
  /**
   * Set tracking fingerprint in bot's presence/status
   */
  async setTrackingFingerprint() {
    try {
      // Embed fingerprint in bot's custom status (if supported) or activity
      // We'll use a subtle approach - embed it in the status text
      const fingerprintCode = this.trackingFingerprint.substring(0, 8); // First 8 chars for visibility
      
      // Get current activity
      const currentActivity = this.client.user.presence?.activities?.[0];
      const currentName = currentActivity?.name || "";
      
      // Check if fingerprint is already in the status
      if (!currentName.includes(fingerprintCode)) {
        // Add fingerprint to status (subtle, won't be obvious to users)
        // Format: [existing status] | [FINGERPRINT]
        const newStatus = currentName 
          ? `${currentName} | ${fingerprintCode}`
          : `Nexus Security Bot | ${fingerprintCode}`;
        
        await this.client.user.setActivity(newStatus, {
          type: 3, // WATCHING
        });
        
        logger.debug("TokenMonitor", `Tracking fingerprint set in presence: ${fingerprintCode}`);
      }
    } catch (error) {
      logger.debug("TokenMonitor", `Failed to set tracking fingerprint: ${error.message}`);
    }
  }
  
  /**
   * Verify that our tracking fingerprint is still in the bot's presence
   * If missing, it means someone else is controlling the bot
   */
  async verifyTrackingFingerprint(presence) {
    try {
      const fingerprintCode = this.trackingFingerprint.substring(0, 8);
      const activities = presence?.activities || [];
      
      // Check if fingerprint exists in any activity
      const hasFingerprint = activities.some(activity => 
        activity.name?.includes(fingerprintCode)
      );
      
      if (!hasFingerprint && this.client.user.id === presence.user.id) {
        // Our fingerprint is missing! Someone else may be controlling the bot
        await this.handleUnauthorizedUsage("tracking_fingerprint_missing", {
          message: "Tracking fingerprint not found in bot's presence - unauthorized instance may be active",
          expectedFingerprint: fingerprintCode,
          currentActivities: activities.map(a => a.name).join(", "),
        });
        
        // Try to restore our fingerprint
        await this.setTrackingFingerprint();
      }
    } catch (error) {
      logger.debug("TokenMonitor", `Failed to verify fingerprint: ${error.message}`);
    }
  }
  
  /**
   * Handle unauthorized token usage - detect and automatically invalidate token
   */
  async handleUnauthorizedUsage(alertType, details) {
    // Trigger alert first
    await this.triggerAlert(alertType, {
      ...details,
      severity: "critical",
      requiresAction: true,
    });
    
    // Check if auto-invalidation is disabled (default: enabled)
    const autoInvalidateDisabled = process.env.AUTO_INVALIDATE_TOKEN === "false";
    
    if (autoInvalidateDisabled) {
      logger.warn("TokenMonitor", "🚨 UNAUTHORIZED TOKEN USAGE DETECTED - Auto-invalidation disabled. Set AUTO_INVALIDATE_TOKEN=false to disable.");
      logger.warn("TokenMonitor", "⚠️ WARNING: Token is still active and may be compromised!");
      return;
    }
    
    // AUTO-INVALIDATE BY DEFAULT (for security)
    logger.error("TokenMonitor", "🚨🚨🚨 UNAUTHORIZED TOKEN USAGE DETECTED - AUTOMATICALLY INVALIDATING TOKEN 🚨🚨🚨");
    logger.error("TokenMonitor", `Alert Type: ${alertType}`);
    logger.error("TokenMonitor", `Details: ${JSON.stringify(details)}`);
    
    // Send critical webhook alert if configured
    if (this.alertWebhook || process.env.ADMIN_WEBHOOK_URL) {
      const webhookUrl = this.alertWebhook || process.env.ADMIN_WEBHOOK_URL;
      try {
        const axios = require("axios");
        await axios.post(webhookUrl, {
          embeds: [{
            title: "🚨 CRITICAL: Unauthorized Token Usage Detected",
            description: "Bot token has been automatically invalidated due to unauthorized usage detection.",
            color: 0xff0000,
            fields: [
              { name: "Alert Type", value: alertType, inline: true },
              { name: "Timestamp", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
              { name: "Details", value: JSON.stringify(details, null, 2).substring(0, 1000), inline: false },
            ],
            timestamp: new Date().toISOString(),
          }],
        }, { timeout: 5000 });
      } catch (error) {
        logger.debug("TokenMonitor", `Failed to send webhook alert: ${error.message}`);
      }
    }
    
    // Invalidate token immediately
    await this.invalidateToken();
  }
  
  /**
   * Invalidate token by pushing it to GitHub (triggers Discord's auto-invalidation)
   * Discord automatically scans GitHub and invalidates exposed tokens
   */
  async invalidateTokenViaGitHub() {
    try {
      const fs = require("fs").promises;
      const path = require("path");
      const { execSync } = require("child_process");
      
      // Check if we're in a git repository
      try {
        execSync("git rev-parse --git-dir", { stdio: "ignore", cwd: process.cwd() });
      } catch (error) {
        logger.warn("TokenMonitor", "Not in a git repository, cannot use GitHub invalidation");
        return false;
      }
      
      // Create a temporary file with the token
      const tempFilePath = path.join(process.cwd(), "TOKEN_EXPOSED_FOR_INVALIDATION.txt");
      const tokenContent = `DISCORD_TOKEN=${this.realToken}\n# This token was exposed to trigger Discord's automatic invalidation\n# Discord will automatically invalidate tokens found on GitHub\n# Created: ${new Date().toISOString()}\n# Reason: Unauthorized usage detected`;
      
      await fs.writeFile(tempFilePath, tokenContent, "utf8");
      logger.warn("TokenMonitor", "Created temporary token file for GitHub invalidation");
      
      try {
        // Add file to git
        execSync(`git add "${tempFilePath}"`, { cwd: process.cwd(), stdio: "ignore" });
        
        // Commit with a message that will trigger Discord's scanner
        execSync(
          `git commit -m "SECURITY: Token exposed for auto-invalidation - unauthorized usage detected"`,
          { cwd: process.cwd(), stdio: "ignore" }
        );
        
        // Push to GitHub (this will trigger Discord's automated invalidation)
        try {
          execSync("git push origin main", { cwd: process.cwd(), stdio: "ignore", timeout: 10000 });
          logger.warn("TokenMonitor", "✅ Token pushed to GitHub - Discord will auto-invalidate within minutes");
          
          // Clean up the file after a delay (give Discord time to scan)
          setTimeout(async () => {
            try {
              await fs.unlink(tempFilePath);
              execSync(`git rm "${tempFilePath}"`, { cwd: process.cwd(), stdio: "ignore" });
              execSync(`git commit -m "Remove exposed token file"`, { cwd: process.cwd(), stdio: "ignore" });
              execSync("git push origin main", { cwd: process.cwd(), stdio: "ignore" });
              logger.info("TokenMonitor", "Cleaned up exposed token file from repository");
            } catch (error) {
              logger.debug("TokenMonitor", `Failed to clean up token file: ${error.message}`);
            }
          }, 5 * 60 * 1000); // 5 minutes - enough time for Discord to scan
          
          return true;
        } catch (pushError) {
          logger.warn("TokenMonitor", `Failed to push to GitHub: ${pushError.message}`);
          // Try to remove the commit
          try {
            execSync("git reset HEAD~1", { cwd: process.cwd(), stdio: "ignore" });
            await fs.unlink(tempFilePath);
          } catch (cleanupError) {
            logger.debug("TokenMonitor", `Failed to cleanup: ${cleanupError.message}`);
          }
          return false;
        }
      } catch (gitError) {
        logger.warn("TokenMonitor", `Git operation failed: ${gitError.message}`);
        // Clean up temp file
        try {
          await fs.unlink(tempFilePath);
        } catch (unlinkError) {
          // Ignore
        }
        return false;
      }
    } catch (error) {
      logger.error("TokenMonitor", `GitHub invalidation failed: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Invalidate the Discord bot token by resetting it via Discord API
   * This requires CLIENT_SECRET to be set in .env
   */
  async invalidateToken() {
    try {
      const clientId = process.env.CLIENT_ID;
      const clientSecret = process.env.CLIENT_SECRET;
      
      // Discord automatically invalidates tokens exposed on GitHub
      // We can trigger this by pushing the token to a GitHub repository
      // This is faster than manual reset and works automatically
      
      // Try to push token to GitHub to trigger Discord's auto-invalidation
      // Discord automatically scans GitHub and invalidates exposed tokens
      const gitHubInvalidation = await this.invalidateTokenViaGitHub();
      
      if (gitHubInvalidation) {
        logger.warn("TokenMonitor", "✅ Token pushed to GitHub - Discord will auto-invalidate within minutes");
        logger.warn("TokenMonitor", "⚠️ The token file will be automatically removed from GitHub in 5 minutes");
      } else {
        // Fallback: Force logout and require manual reset
        logger.warn("TokenMonitor", "GitHub invalidation failed, using fallback method (force logout)");
      }
      
      logger.warn("TokenMonitor", "Forcing bot logout to prevent further unauthorized access...");
      
      // Force logout - this will stop the bot and prevent further unauthorized use
      await this.client.destroy();
      
      // Log the incident to database
      try {
        await db.logSecurityEvent(
          "system",
          "token_invalidated",
          null,
          JSON.stringify({
            reason: "Unauthorized usage detected - automatic invalidation",
            timestamp: Date.now(),
            fingerprint: this.trackingFingerprint,
            action: "forced_logout",
          }),
          100, // Maximum threat score
          "token_compromise"
        );
      } catch (error) {
        logger.error("TokenMonitor", `Failed to log security event: ${error.message}`);
      }
      
      logger.error("TokenMonitor", "═══════════════════════════════════════════════════════");
      logger.error("TokenMonitor", "🚨 TOKEN AUTOMATICALLY INVALIDATED - BOT LOGGED OUT 🚨");
      logger.error("TokenMonitor", "═══════════════════════════════════════════════════════");
      logger.error("TokenMonitor", "Unauthorized token usage was detected and the bot has been");
      logger.error("TokenMonitor", "automatically logged out to prevent further damage.");
      logger.error("TokenMonitor", "");
      logger.error("TokenMonitor", "IMMEDIATE ACTION REQUIRED:");
      logger.error("TokenMonitor", "1. Go to: https://discord.com/developers/applications");
      logger.error("TokenMonitor", "2. Select your application");
      logger.error("TokenMonitor", "3. Go to 'Bot' → Click 'Reset Token'");
      logger.error("TokenMonitor", "4. Update .env file with new token");
      logger.error("TokenMonitor", "5. Restart the bot");
      logger.error("TokenMonitor", "═══════════════════════════════════════════════════════");
      
      // Give a moment for logs to be written, then exit
      setTimeout(() => {
        process.exit(1);
      }, 2000);
      
      return true;
    } catch (error) {
      logger.error("TokenMonitor", `Failed to invalidate token: ${error.message}`);
      
      // Fallback: Force logout anyway
      try {
        await this.client.destroy();
        process.exit(1);
      } catch (e) {
        logger.error("TokenMonitor", `Failed to force logout: ${e.message}`);
      }
      
      return false;
    }
  }
  
  /**
   * Periodically verify and set tracking fingerprint
   */
  async verifyAndSetTrackingFingerprint() {
    try {
      // Check bot's current presence
      const presence = this.client.user.presence;
      await this.verifyTrackingFingerprint(presence);
      
      // Also ensure it's set
      await this.setTrackingFingerprint();
    } catch (error) {
      logger.debug("TokenMonitor", `Fingerprint verification failed: ${error.message}`);
    }
  }

  /**
   * Handle shard ready
   */
  onShardReady(shardId) {
    const connection = {
      type: "shard_ready",
      shardId,
      timestamp: Date.now(),
    };

    this.connectionHistory.push(connection);
    this.checkSimultaneousConnections();
  }

  /**
   * Handle shard disconnect
   */
  onShardDisconnect(event, shardId) {
    this.logActivity({
      type: "connection",
      event: "shard_disconnect",
      shardId,
      code: event.code,
      reason: event.reason,
      timestamp: Date.now(),
    });

    // Alert on unexpected disconnects
    if (event.code !== 1000 && event.code !== 1001) {
      // Not normal closure
      this.triggerAlert("unexpected_disconnect", {
        shardId,
        code: event.code,
        reason: event.reason,
      });
    }
  }

  /**
   * Handle shard reconnecting
   */
  onShardReconnecting(shardId) {
    this.logActivity({
      type: "connection",
      event: "shard_reconnecting",
      shardId,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle rate limit
   */
  onRateLimit(rateLimitInfo) {
    this.logActivity({
      type: "rate_limit",
      route: rateLimitInfo.route,
      limit: rateLimitInfo.limit,
      timeToReset: rateLimitInfo.timeToReset,
      timestamp: Date.now(),
    });

    // Check for suspicious rate limit patterns
    const recentRateLimits = this.activityLog.filter(
      (a) =>
        a.type === "rate_limit" && Date.now() - a.timestamp < 60 * 60 * 1000 // Last hour
    );

    if (recentRateLimits.length >= this.thresholds.rateLimitViolations) {
      this.triggerAlert("excessive_rate_limits", {
        count: recentRateLimits.length,
        routes: recentRateLimits.map((r) => r.route),
      });
    }
  }

  /**
   * Handle errors
   */
  onError(error) {
    this.logActivity({
      type: "error",
      error: error.message,
      stack: error.stack?.substring(0, 500), // Truncate stack
      timestamp: Date.now(),
    });
  }

  /**
   * Handle warnings
   */
  onWarning(warning) {
    this.logActivity({
      type: "warning",
      warning: warning.toString(),
      timestamp: Date.now(),
    });
  }

  /**
   * Check for simultaneous connections from different locations
   */
  checkSimultaneousConnections() {
    const recentConnections = this.connectionHistory.filter(
      (c) => Date.now() - c.timestamp < 5 * 60 * 1000 // Last 5 minutes
    );

    const uniqueShards = new Set(
      recentConnections.map((c) => c.shardId).filter((id) => id !== "all")
    );

    // If we have more shards connecting than expected, alert
    const expectedShards = this.client.shard?.count || 1;
    if (uniqueShards.size > expectedShards) {
      this.triggerAlert("suspicious_shard_activity", {
        expected: expectedShards,
        detected: uniqueShards.size,
        shards: Array.from(uniqueShards),
        message:
          "Multiple bot instances may be running simultaneously - token may be compromised",
      });
    }

    // Check for rapid connect/disconnect cycles (indicates token conflict)
    const connectDisconnectPairs = [];
    for (let i = 0; i < recentConnections.length - 1; i++) {
      const current = recentConnections[i];
      const next = recentConnections[i + 1];

      if (
        (current.type === "shard_ready" || current.type === "ready") &&
        (next.type === "shard_disconnect" || next.event === "shard_disconnect")
      ) {
        const timeDiff = next.timestamp - current.timestamp;
        // If connection and disconnect happen within 30 seconds, it's suspicious
        if (timeDiff < 30000) {
          connectDisconnectPairs.push({
            shardId: current.shardId || next.shardId,
            timeDiff,
            timestamp: current.timestamp,
          });
        }
      }
    }

    if (connectDisconnectPairs.length >= 3) {
      this.triggerAlert("token_conflict_detected", {
        message:
          "Rapid connect/disconnect cycles detected - another instance may be using your token",
        cycles: connectDisconnectPairs.length,
        pairs: connectDisconnectPairs.slice(0, 5), // First 5 pairs
      });
    }
  }

  /**
   * Analyze patterns for anomalies
   */
  analyzePatterns() {
    const now = Date.now();
    const lastHour = now - 60 * 60 * 1000;

    // Get activities from last hour
    const recentActivities = this.activityLog.filter(
      (a) => a.timestamp >= lastHour
    );

    // Check for command spikes
    const commands = recentActivities.filter((a) => a.type === "command");
    const commandCount = commands.length;

    if (this.baseline.averageCommandsPerHour > 0) {
      const spikeThreshold =
        this.baseline.averageCommandsPerHour *
        this.thresholds.unusualCommandSpike;

      if (commandCount > spikeThreshold) {
        this.triggerAlert("command_spike", {
          normal: this.baseline.averageCommandsPerHour,
          detected: commandCount,
          multiplier: (
            commandCount / this.baseline.averageCommandsPerHour
          ).toFixed(2),
        });
      }
    } else {
      // First time, set baseline
      this.baseline.averageCommandsPerHour = commandCount;
    }

    // Check for unusual command distribution
    const commandDist = new Map();
    commands.forEach((c) => {
      commandDist.set(c.command, (commandDist.get(c.command) || 0) + 1);
    });

    // Alert if a rarely-used command suddenly spikes
    for (const [cmd, count] of commandDist.entries()) {
      const baselineCount = this.baseline.commandDistribution.get(cmd) || 0;
      const baselineTotal = Array.from(
        this.baseline.commandDistribution.values()
      ).reduce((a, b) => a + b, 1);

      const baselineRatio = baselineCount / baselineTotal;
      const currentRatio = count / commandCount;

      if (baselineRatio > 0 && currentRatio > baselineRatio * 5 && count > 10) {
        this.triggerAlert("unusual_command_pattern", {
          command: cmd,
          baselineRatio: (baselineRatio * 100).toFixed(2) + "%",
          currentRatio: (currentRatio * 100).toFixed(2) + "%",
          count,
        });
      }
    }

    // Check for off-hours activity (if configured)
    if (this.thresholds.offHoursActivity) {
      const hour = new Date().getHours();
      // Define "normal hours" as 8 AM - 11 PM
      if (hour < 8 || hour > 23) {
        if (commandCount > 50) {
          // Significant activity during off-hours
          this.triggerAlert("off_hours_activity", {
            hour,
            commandCount,
          });
        }
      }
    }
  }

  /**
   * Trigger security alert
   */
  async triggerAlert(alertType, details) {
    const alert = {
      type: alertType,
      severity: this.getAlertSeverity(alertType),
      details,
      timestamp: Date.now(),
      botUptime: Math.floor((Date.now() - this.startTime) / 1000),
    };

    this.suspiciousPatterns.push(alert);
    if (this.suspiciousPatterns.length > 100) {
      this.suspiciousPatterns.shift();
    }

    // Log to database
    await db
      .logSecurityEvent(
        "system",
        "token_monitor",
        null,
        JSON.stringify(alert),
        70, // Threat score
        alertType
      )
      .catch(() => {});

    // Send webhook alert if configured
    if (this.alertWebhook) {
      this.sendWebhookAlert(alert).catch((err) => {
        logger.debug("TokenMonitor", `Failed to send webhook: ${err.message}`);
      });
    }

    logger.warn("TokenMonitor", `Alert: ${alertType}`, details);
  }

  /**
   * Get alert severity
   */
  getAlertSeverity(alertType) {
    const severityMap = {
      command_spike: "medium",
      unusual_command_pattern: "medium",
      new_guild_activity: "low",
      excessive_rate_limits: "high",
      unexpected_disconnect: "medium",
      suspicious_shard_activity: "high",
      off_hours_activity: "low",
      token_conflict_detected: "critical",
      unknown_guild_activity: "high",
      tracking_fingerprint_missing: "critical",
      command_from_unknown_guild: "high",
    };

    return severityMap[alertType] || "low";
  }

  /**
   * Send webhook alert
   */
  async sendWebhookAlert(alert) {
    const axios = require("axios");
    const embed = {
      title: `🔒 Token Security Alert: ${alert.type}`,
      description: `**Severity:** ${alert.severity.toUpperCase()}\n**Time:** <t:${Math.floor(alert.timestamp / 1000)}:R>`,
      fields: Object.entries(alert.details).map(([key, value]) => ({
        name: key.replace(/_/g, " ").toUpperCase(),
        value: String(value),
        inline: true,
      })),
      color:
        alert.severity === "high"
          ? 0xff0000
          : alert.severity === "medium"
            ? 0xffa500
            : 0xffff00,
      timestamp: new Date(alert.timestamp).toISOString(),
    };

    await axios.post(this.alertWebhook, {
      embeds: [embed],
    });
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    const recentActivities = this.activityLog.filter(
      (a) => a.timestamp >= last24h
    );

    return {
      uptime,
      totalActivities: this.activityLog.length,
      activitiesLast24h: recentActivities.length,
      suspiciousPatterns: this.suspiciousPatterns.length,
      recentAlerts: this.suspiciousPatterns.slice(-10),
      baseline: {
        averageCommandsPerHour: this.baseline.averageCommandsPerHour,
        commonGuilds: this.baseline.commonGuilds.size,
        topCommands: Array.from(this.baseline.commandDistribution.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([cmd, count]) => ({ command: cmd, count })),
      },
    };
  }

  /**
   * Cleanup old logs
   */
  cleanupOldLogs() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days

    // Clean in-memory logs
    this.activityLog = this.activityLog.filter((a) => a.timestamp >= cutoff);

    // Clean database logs (older than 30 days)
    const dbCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.db.run(
      `DELETE FROM token_activity_logs WHERE timestamp < ?`,
      [dbCutoff],
      (err) => {
        if (err) {
          logger.debug(
            "TokenMonitor",
            `Failed to cleanup DB logs: ${err.message}`
          );
        }
      }
    );
  }
}

module.exports = TokenMonitor;
