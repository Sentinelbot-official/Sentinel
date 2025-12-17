const axios = require("axios");
const crypto = require("crypto");
const db = require("./database");
const logger = require("./logger");

/**
 * Integration Ecosystem
 * Supports webhooks, Zapier, IFTTT, and other third-party integrations
 */
class IntegrationSystem {
  constructor(client) {
    this.client = client;
    this.webhookQueue = [];
    this.rateLimits = new Map();

    this.startWebhookProcessor();
  }

  /**
   * Register a webhook for events
   */
  async registerWebhook(guildId, url, events, secret = null) {
    try {
      // Validate URL
      if (!this.isValidUrl(url)) {
        return { success: false, error: "Invalid webhook URL" };
      }

      // Generate webhook ID and secret
      const webhookId = crypto.randomBytes(16).toString("hex");
      const webhookSecret = secret || crypto.randomBytes(32).toString("hex");

      await db.db.run(
        `INSERT INTO webhooks (id, guild_id, url, events, secret, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          webhookId,
          guildId,
          url,
          JSON.stringify(events),
          webhookSecret,
          Date.now(),
          1,
        ]
      );

      logger.info(`[Integrations] Registered webhook for guild ${guildId}`);

      return {
        success: true,
        webhookId,
        secret: webhookSecret,
      };
    } catch (error) {
      logger.error("[Integrations] Failed to register webhook", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Trigger webhook for an event
   */
  async triggerWebhook(guildId, eventType, payload) {
    try {
      // Get all webhooks for this guild and event type
      const webhooks = await db.db.all(
        `SELECT * FROM webhooks WHERE guild_id = ? AND active = 1`,
        [guildId]
      );

      for (const webhook of webhooks) {
        const events = JSON.parse(webhook.events || "[]");

        // Check if webhook is subscribed to this event
        if (events.includes(eventType) || events.includes("*")) {
          this.queueWebhook(webhook, eventType, payload);
        }
      }
    } catch (error) {
      logger.error("[Integrations] Failed to trigger webhooks", error);
    }
  }

  /**
   * Queue webhook for delivery
   */
  queueWebhook(webhook, eventType, payload) {
    this.webhookQueue.push({
      webhook,
      eventType,
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Process webhook queue
   */
  startWebhookProcessor() {
    setInterval(async () => {
      if (this.webhookQueue.length === 0) {
        return;
      }

      const batch = this.webhookQueue.splice(0, 10); // Process 10 at a time

      for (const item of batch) {
        await this.deliverWebhook(item.webhook, item.eventType, item.payload);
      }
    }, 1000); // Process every second
  }

  /**
   * Deliver webhook to endpoint
   */
  async deliverWebhook(webhook, eventType, payload) {
    try {
      // Check rate limit
      if (this.isRateLimited(webhook.id)) {
        logger.warn(`[Integrations] Webhook ${webhook.id} is rate limited`);
        return;
      }

      // Create signature
      const signature = this.createSignature(
        webhook.secret,
        JSON.stringify(payload)
      );

      // Send webhook
      const response = await axios.post(
        webhook.url,
        {
          event: eventType,
          timestamp: Date.now(),
          data: payload,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Sentinel-Signature": signature,
            "X-Sentinel-Event": eventType,
            "User-Agent": "SentinelBot-Webhooks/1.0",
          },
          timeout: 5000,
        }
      );

      // Log successful delivery
      await db.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event_type, status_code, success, delivered_at)
         VALUES (?, ?, ?, 1, ?)`,
        [webhook.id, eventType, response.status, Date.now()]
      );

      logger.info(
        `[Integrations] Webhook delivered: ${webhook.id} - ${eventType}`
      );
    } catch (error) {
      // Log failed delivery
      await db.db.run(
        `INSERT INTO webhook_deliveries (webhook_id, event_type, status_code, success, error_message, delivered_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
        [
          webhook.id,
          eventType,
          error.response?.status || 0,
          error.message,
          Date.now(),
        ]
      );

      logger.error(
        `[Integrations] Webhook delivery failed: ${webhook.id}`,
        error.message
      );

      // Disable webhook after too many failures
      await this.checkWebhookHealth(webhook.id);
    }
  }

  /**
   * Check webhook health and disable if necessary
   */
  async checkWebhookHealth(webhookId) {
    try {
      const recentDeliveries = await db.db.all(
        `SELECT success FROM webhook_deliveries 
         WHERE webhook_id = ? 
         ORDER BY delivered_at DESC 
         LIMIT 10`,
        [webhookId]
      );

      if (recentDeliveries.length >= 10) {
        const failures = recentDeliveries.filter((d) => !d.success).length;

        if (failures >= 8) {
          // 80% failure rate
          await db.db.run(`UPDATE webhooks SET active = 0 WHERE id = ?`, [
            webhookId,
          ]);

          logger.warn(
            `[Integrations] Disabled webhook ${webhookId} due to high failure rate`
          );
        }
      }
    } catch (error) {
      logger.error("[Integrations] Failed to check webhook health", error);
    }
  }

  /**
   * Create HMAC signature for webhook verification
   */
  createSignature(secret, payload) {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
  }

  /**
   * Verify webhook signature
   */
  verifySignature(secret, payload, signature) {
    const expectedSignature = this.createSignature(secret, payload);
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Check if webhook is rate limited
   */
  isRateLimited(webhookId) {
    const now = Date.now();
    const limit = this.rateLimits.get(webhookId) || { count: 0, resetAt: now };

    if (now > limit.resetAt) {
      this.rateLimits.set(webhookId, { count: 1, resetAt: now + 60000 }); // 60 second window
      return false;
    }

    if (limit.count >= 60) {
      // 60 requests per minute max
      return true;
    }

    limit.count++;
    this.rateLimits.set(webhookId, limit);
    return false;
  }

  /**
   * Validate URL format
   */
  isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  /**
   * Zapier Integration - Generate polling URL
   */
  async getZapierPollingURL(guildId, eventType) {
    const apiKey = await this.generateAPIKey(guildId, "zapier");
    return `${process.env.PUBLIC_URL || "http://localhost:3000"}/api/integrations/zapier/poll?guild=${guildId}&event=${eventType}&key=${apiKey}`;
  }

  /**
   * IFTTT Integration - Generate webhook URL
   */
  async getIFTTTWebhookURL(guildId, eventType) {
    const result = await this.registerWebhook(
      guildId,
      "https://maker.ifttt.com/trigger/{event}/with/key/{your-key}",
      [eventType]
    );

    if (result.success) {
      return {
        success: true,
        webhookId: result.webhookId,
        instructions:
          "Replace {event} with your IFTTT event name and {your-key} with your IFTTT Webhooks key",
      };
    }

    return result;
  }

  /**
   * Generate API key for external integrations
   */
  async generateAPIKey(guildId, service) {
    const apiKey = crypto.randomBytes(32).toString("hex");

    try {
      await db.db.run(
        `INSERT INTO integration_keys (guild_id, service, api_key, created_at)
         VALUES (?, ?, ?, ?)`,
        [guildId, service, apiKey, Date.now()]
      );

      return apiKey;
    } catch (error) {
      logger.error("[Integrations] Failed to generate API key", error);
      return null;
    }
  }

  /**
   * Validate API key
   */
  async validateAPIKey(apiKey) {
    try {
      const result = await db.db.get(
        `SELECT guild_id, service FROM integration_keys WHERE api_key = ?`,
        [apiKey]
      );

      return result || null;
    } catch (error) {
      logger.error("[Integrations] Failed to validate API key", error);
      return null;
    }
  }

  /**
   * Get supported events for webhooks
   */
  getSupportedEvents() {
    return [
      "member.join",
      "member.leave",
      "member.ban",
      "member.unban",
      "message.delete",
      "message.edit",
      "role.create",
      "role.delete",
      "channel.create",
      "channel.delete",
      "raid.detected",
      "spam.detected",
      "threat.detected",
      "security.alert",
      "backup.completed",
      "config.changed",
    ];
  }
}

module.exports = IntegrationSystem;
