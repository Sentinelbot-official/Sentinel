const axios = require("axios");
const logger = require("./logger");

class TokenScanner {
  constructor(client) {
    this.client = client;
    this.botToken = process.env.DISCORD_TOKEN;
    this.scanInterval = 5 * 60 * 1000; // Scan every 5 minutes
    this.isScanning = false;

    // Sites to monitor
    this.pasteSites = [
      {
        name: "Pastebin",
        searchUrl: "https://psbdmp.ws/api/search/",
        type: "api",
      },
      {
        name: "Ghostbin",
        url: "https://ghostbin.com/recent",
        type: "scrape",
      },
      {
        name: "Rentry",
        url: "https://rentry.co/recent",
        type: "scrape",
      },
    ];

    // Doxbin-like sites (be careful with these)
    this.doxSites = [
      {
        name: "Doxbin",
        url: "https://doxbin.com/home",
        type: "scrape",
      },
    ];
  }

  /**
   * Start periodic token scanning
   */
  startScanning() {
    logger.info(`[TokenScanner] Starting token monitoring (every 5 minutes)`);

    // Initial scan after 1 minute
    setTimeout(() => {
      this.scanAllSites();
    }, 60000);

    // Then scan every 5 minutes
    setInterval(() => {
      this.scanAllSites();
    }, this.scanInterval);
  }

  /**
   * Scan all monitored sites for token
   */
  async scanAllSites() {
    if (this.isScanning) {
      logger.debug(`[TokenScanner] Scan already in progress, skipping`);
      return;
    }

    if (!this.botToken) {
      logger.warn(`[TokenScanner] No token configured, skipping scan`);
      return;
    }

    this.isScanning = true;
    logger.debug(`[TokenScanner] Starting scan cycle...`);

    try {
      // Scan paste sites
      for (const site of this.pasteSites) {
        try {
          await this.scanSite(site);
        } catch (error) {
          logger.debug(
            `[TokenScanner] Failed to scan ${site.name}:`,
            error.message
          );
        }
      }

      // Scan dox sites (optional - can be disabled)
      if (process.env.SCAN_DOX_SITES === "true") {
        for (const site of this.doxSites) {
          try {
            await this.scanSite(site);
          } catch (error) {
            logger.debug(
              `[TokenScanner] Failed to scan ${site.name}:`,
              error.message
            );
          }
        }
      }

      logger.debug(`[TokenScanner] Scan cycle completed`);
    } catch (error) {
      logger.error(`[TokenScanner] Scan error:`, error.message);
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Scan a specific site for token
   * @param {Object} site - Site configuration
   */
  async scanSite(site) {
    try {
      let content = "";

      if (site.type === "api") {
        // API-based search
        const response = await axios.get(site.searchUrl + this.botToken, {
          timeout: 10000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
        });
        content = JSON.stringify(response.data);
      } else if (site.type === "scrape") {
        // Web scraping
        const response = await axios.get(site.url, {
          timeout: 10000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
        });
        content = response.data;
      }

      // Check if token appears in content
      if (content.includes(this.botToken)) {
        logger.error(
          `[TokenScanner] 🚨 TOKEN FOUND ON ${site.name.toUpperCase()}!`
        );
        await this.handleTokenFound(site, content);
      }
    } catch (error) {
      // Silently fail for individual sites (they might be down, blocked, etc.)
      if (error.code !== "ECONNREFUSED" && error.code !== "ETIMEDOUT") {
        logger.debug(`[TokenScanner] ${site.name} scan error:`, error.message);
      }
    }
  }

  /**
   * Handle token found on a site
   * @param {Object} site - Site where token was found
   * @param {String} content - Content containing the token
   */
  async handleTokenFound(site, content) {
    const leakInfo = {
      source: {
        name: site.name,
        url: site.url || site.searchUrl,
        type: "web_scraper",
      },
      timestamp: new Date().toISOString(),
      detectedBy: "TokenScanner",
    };

    logger.error(
      `[TokenScanner] 🚨 CRITICAL: Token detected on ${site.name}`
    );
    logger.error(`[TokenScanner] URL: ${site.url || site.searchUrl}`);

    // Alert owner(s)
    await this.alertOwners(leakInfo);

    // Invalidate token using TokenProtection system
    await this.invalidateToken(leakInfo);

    // Log to database
    await this.logToDatabase(leakInfo);

    // Emergency shutdown
    logger.error(`[TokenScanner] EMERGENCY SHUTDOWN - Token found on web`);

    // Create shutdown flag
    const fs = require("fs");
    try {
      fs.writeFileSync(
        "./.TOKEN_LEAK_SHUTDOWN",
        JSON.stringify({
          timestamp: Date.now(),
          reason: `Token found on ${site.name}`,
          source: site.name,
        })
      );
    } catch (error) {
      logger.error(
        `[TokenScanner] Failed to create shutdown flag:`,
        error.message
      );
    }

    process.exit(1);
  }

  /**
   * Alert bot owner(s) about token found on web
   * @param {Object} leakInfo - Information about where token was found
   */
  async alertOwners(leakInfo) {
    const alertEmbed = {
      title: "🚨 CRITICAL: BOT TOKEN FOUND ON WEB",
      description: `**Your bot's token has been detected on a public website!**`,
      color: 0xff0000,
      fields: [
        {
          name: "📍 Found On",
          value: `**Site:** ${leakInfo.source.name}\n**URL:** ${leakInfo.source.url}`,
          inline: false,
        },
        {
          name: "⏰ Detection Time",
          value: `<t:${Math.floor(Date.parse(leakInfo.timestamp) / 1000)}:F>`,
          inline: false,
        },
        {
          name: "✅ Actions Taken",
          value:
            "• Token scanner detected exposure\n• Public gist created for invalidation\n• Discord will auto-invalidate token\n• Security log created\n• Bot shut down\n• All owners notified",
          inline: false,
        },
        {
          name: "⚠️ IMMEDIATE ACTIONS REQUIRED",
          value:
            "1. **Regenerate token** at Discord Developer Portal\n2. **Update .env** with new token\n3. **Delete .TOKEN_LEAK_SHUTDOWN** file\n4. **Restart bot** manually\n5. **Investigate** how token was leaked\n6. **Review** server security and access logs",
          inline: false,
        },
        {
          name: "🔍 Investigation",
          value: `Check ${leakInfo.source.name} for:\n• Who posted it\n• When it was posted\n• What other information was leaked\n• How they obtained the token`,
          inline: false,
        },
      ],
      timestamp: leakInfo.timestamp,
      footer: {
        text: "Token Scanner | Nexus Security",
      },
    };

    // Send to owner(s) via DM
    const ownerId = process.env.OWNER_ID;
    if (ownerId) {
      try {
        const owner = await this.client.users.fetch(ownerId);
        await owner.send({ embeds: [alertEmbed] });
        logger.info(`[TokenScanner] Alert sent to owner ${owner.tag}`);
      } catch (error) {
        logger.error(
          `[TokenScanner] Failed to DM owner:`,
          error.message
        );
      }
    }

    // Also send to alert channel if configured
    const alertChannelId = process.env.TOKEN_ALERT_CHANNEL;
    if (alertChannelId) {
      try {
        const alertChannel = await this.client.channels.fetch(alertChannelId);
        await alertChannel.send({
          content: ownerId ? `<@${ownerId}>` : "@here",
          embeds: [alertEmbed],
        });
      } catch (error) {
        logger.error(
          `[TokenScanner] Failed to send to alert channel:`,
          error.message
        );
      }
    }
  }

  /**
   * Invalidate token by creating public gist
   * @param {Object} leakInfo - Information about the leak
   */
  async invalidateToken(leakInfo) {
    const filename = `LEAKED_TOKEN_${Date.now()}.txt`;
    const fileContent = `LEAKED BOT TOKEN - DISCORD PLEASE INVALIDATE

Token: ${this.botToken}

Leak Information:
- Found On: ${leakInfo.source.name}
- URL: ${leakInfo.source.url}
- Detected By: Token Scanner (automated)
- Time: ${leakInfo.timestamp}

This token was automatically detected on a public website and posted here to trigger Discord's automatic token invalidation system.`;

    const githubToken = process.env.GITHUB_TOKEN;

    if (githubToken) {
      try {
        logger.info(
          `[TokenScanner] Creating public GitHub Gist for invalidation...`
        );

        const gistResponse = await axios.post(
          "https://api.github.com/gists",
          {
            description: "LEAKED BOT TOKEN - Discord Please Invalidate",
            public: true,
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
        logger.info(`[TokenScanner] ✅ Created public gist: ${gistUrl}`);
        logger.info(
          `[TokenScanner] ✅ Discord will scan and invalidate token automatically`
        );
      } catch (error) {
        logger.error(
          `[TokenScanner] Failed to create gist:`,
          error.message
        );
        logger.error(
          `[TokenScanner] MANUAL ACTION REQUIRED: Regenerate token immediately!`
        );
      }
    } else {
      logger.error(
        `[TokenScanner] No GITHUB_TOKEN found - cannot auto-invalidate`
      );
      logger.error(
        `[TokenScanner] MANUAL ACTION REQUIRED: Regenerate token immediately!`
      );
    }
  }

  /**
   * Log token found to database
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
            "SYSTEM",
            "SCANNER",
            "token_found_on_web",
            "token_invalidated",
            100,
            Date.now(),
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      logger.info(`[TokenScanner] Logged to security database`);
    } catch (error) {
      logger.error(
        `[TokenScanner] Failed to log to database:`,
        error.message
      );
    }
  }
}

module.exports = TokenScanner;

