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
      
      // Try from longest to shortest fingerprint (more likely to be correct)
      // But prioritize tokens that start with base64-like patterns (Discord tokens usually start with alphanumeric)
      let bestMatch = null;
      let bestScore = 0;
      
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
            if (possibleToken.length >= 59 && possibleToken.length <= 75) score += 15;
            else if (possibleToken.length >= 50 && possibleToken.length < 59) score += 5;
            
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
            
            logger.debug("TokenMonitor", `Match score: ${score} for fpLength=${fpLength}, token starts="${possibleToken.substring(0, 15)}...", length=${possibleToken.length}`);
            
            // Only accept if it has a good score (must start with alphanumeric and be reasonable length)
            if (score >= 15 && score > bestScore) {
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
        logger.info("TokenMonitor", `✅ Successfully parsed: fingerprint=${bestMatch.trackingFingerprint.substring(0, 8)}..., token length=${bestMatch.realToken.length}`);
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
        this.triggerAlert("tracking_fingerprint_missing", {
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
