const logger = require("./logger");
const db = require("./database");

/**
 * Advanced Error Boundary System
 * Provides comprehensive error handling, recovery, and reporting
 */
class ErrorBoundary {
  constructor(client) {
    this.client = client;
    this.errorCount = new Map(); // commandName -> count
    this.lastErrors = new Map(); // commandName -> {error, timestamp, count}
    this.circuitBreakers = new Map(); // feature -> {failures, lastFailure, state}
    this.recoveryStrategies = new Map();

    // Circuit breaker thresholds
    this.CIRCUIT_BREAK_THRESHOLD = 5;
    this.CIRCUIT_RESET_TIME = 60000; // 1 minute

    this.setupRecoveryStrategies();
    this.startErrorMonitoring();
  }

  /**
   * Setup automatic recovery strategies for common errors
   */
  setupRecoveryStrategies() {
    // Database recovery
    this.recoveryStrategies.set("SQLITE_", async (error, context) => {
      logger.warn(
        "[ErrorBoundary] Database error detected, attempting recovery",
        { error: error.message }
      );

      try {
        // Reconnect database if connection lost
        if (
          error.message.includes("database is locked") ||
          error.message.includes("SQLITE_BUSY")
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { recovered: true, retry: true };
        }

        // For constraint errors, log and continue
        if (error.code === "SQLITE_CONSTRAINT") {
          logger.info(
            "[ErrorBoundary] Constraint violation handled gracefully"
          );
          return { recovered: true, retry: false };
        }
      } catch (recoveryError) {
        logger.error("[ErrorBoundary] Recovery failed", recoveryError);
      }

      return { recovered: false, retry: false };
    });

    // Discord API recovery
    this.recoveryStrategies.set("DiscordAPI", async (error, context) => {
      logger.warn("[ErrorBoundary] Discord API error detected", {
        error: error.message,
      });

      try {
        // Rate limit handling
        if (error.code === 50013) {
          // Missing Permissions
          return {
            recovered: true,
            retry: false,
            userMessage:
              "❌ I don't have permission to do that! Please check my role permissions.",
          };
        }

        if (error.code === 10008) {
          // Unknown Message
          return {
            recovered: true,
            retry: false,
            userMessage: "❌ That message no longer exists.",
          };
        }

        if (error.code === 50001) {
          // Missing Access
          return {
            recovered: true,
            retry: false,
            userMessage: "❌ I don't have access to that channel.",
          };
        }

        // Retry on 5xx errors
        if (error.httpStatus >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return { recovered: true, retry: true };
        }
      } catch (recoveryError) {
        logger.error(
          "[ErrorBoundary] Discord API recovery failed",
          recoveryError
        );
      }

      return { recovered: false, retry: false };
    });

    // Network recovery
    this.recoveryStrategies.set("Network", async (error, context) => {
      if (error.code === "ECONNRESET" || error.code === "ETIMEDOUT") {
        logger.warn("[ErrorBoundary] Network error, will retry", {
          code: error.code,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { recovered: true, retry: true };
      }
      return { recovered: false, retry: false };
    });
  }

  /**
   * Wrap a command execution with error boundary
   */
  async wrapCommand(commandName, executionFn, context = {}) {
    const startTime = Date.now();

    try {
      // Check circuit breaker
      if (this.isCircuitBroken(commandName)) {
        throw new Error(
          `Circuit breaker open for ${commandName}. Command temporarily disabled.`
        );
      }

      // Execute command
      const result = await executionFn();

      // Reset error count on success
      this.errorCount.delete(commandName);
      this.resetCircuitBreaker(commandName);

      // Track performance
      const duration = Date.now() - startTime;
      if (duration > 5000) {
        logger.warn(
          `[ErrorBoundary] Slow command detected: ${commandName} took ${duration}ms`
        );
      }

      return { success: true, result };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Log error
      logger.error(`[ErrorBoundary] Command error: ${commandName}`, {
        error: error.message,
        stack: error.stack,
        context,
        duration,
      });

      // Track error count
      const count = (this.errorCount.get(commandName) || 0) + 1;
      this.errorCount.set(commandName, count);

      // Store last error
      this.lastErrors.set(commandName, {
        error: error.message,
        timestamp: Date.now(),
        count,
      });

      // Update circuit breaker
      this.recordFailure(commandName);

      // Store in database
      try {
        await db.db.run(
          `INSERT INTO error_logs (command, error_message, stack_trace, context, timestamp, recovery_attempted)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            commandName,
            error.message,
            error.stack,
            JSON.stringify(context),
            Date.now(),
            false,
          ]
        );
      } catch (dbError) {
        logger.error(
          "[ErrorBoundary] Failed to log error to database",
          dbError
        );
      }

      // Attempt recovery
      const recovery = await this.attemptRecovery(error, context);

      if (recovery.recovered && recovery.retry) {
        logger.info(`[ErrorBoundary] Retrying ${commandName} after recovery`);
        try {
          const result = await executionFn();
          this.resetCircuitBreaker(commandName);
          return { success: true, result, recovered: true };
        } catch (retryError) {
          logger.error(
            `[ErrorBoundary] Retry failed for ${commandName}`,
            retryError
          );
        }
      }

      return {
        success: false,
        error: error.message,
        userMessage: recovery.userMessage || this.getUserFriendlyError(error),
        recovered: recovery.recovered,
      };
    }
  }

  /**
   * Attempt to recover from error using registered strategies
   */
  async attemptRecovery(error, context) {
    const errorString = error.message || error.toString();

    // Try each recovery strategy
    for (const [pattern, strategy] of this.recoveryStrategies.entries()) {
      if (
        errorString.includes(pattern) ||
        error.code?.toString().includes(pattern)
      ) {
        try {
          const result = await strategy(error, context);
          if (result.recovered) {
            logger.info("[ErrorBoundary] Error recovered using strategy", {
              pattern,
            });
            return result;
          }
        } catch (recoveryError) {
          logger.error("[ErrorBoundary] Recovery strategy failed", {
            pattern,
            recoveryError,
          });
        }
      }
    }

    return { recovered: false, retry: false };
  }

  /**
   * Circuit breaker pattern implementation
   */
  isCircuitBroken(feature) {
    const breaker = this.circuitBreakers.get(feature);
    if (!breaker || breaker.state !== "open") {
      return false;
    }

    // Check if enough time has passed to try again
    if (Date.now() - breaker.lastFailure > this.CIRCUIT_RESET_TIME) {
      breaker.state = "half-open";
      logger.info(`[ErrorBoundary] Circuit breaker half-open for ${feature}`);
      return false;
    }

    return true;
  }

  recordFailure(feature) {
    const breaker = this.circuitBreakers.get(feature) || {
      failures: 0,
      state: "closed",
    };
    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= this.CIRCUIT_BREAK_THRESHOLD) {
      breaker.state = "open";
      logger.warn(
        `[ErrorBoundary] Circuit breaker opened for ${feature} after ${breaker.failures} failures`
      );

      // Notify admins
      this.notifyAdmins(`⚠️ Circuit breaker opened for feature: ${feature}`);
    }

    this.circuitBreakers.set(feature, breaker);
  }

  resetCircuitBreaker(feature) {
    const breaker = this.circuitBreakers.get(feature);
    if (breaker) {
      breaker.failures = 0;
      breaker.state = "closed";
      this.circuitBreakers.set(feature, breaker);
    }
  }

  /**
   * Convert technical errors to user-friendly messages
   */
  getUserFriendlyError(error) {
    const message = error.message?.toLowerCase() || "";

    if (message.includes("permission")) {
      return "❌ I don't have the necessary permissions to do that.";
    }

    if (message.includes("timeout") || message.includes("timed out")) {
      return "⏱️ That took too long to complete. Please try again.";
    }

    if (message.includes("not found") || message.includes("unknown")) {
      return "❓ I couldn't find what you're looking for.";
    }

    if (message.includes("rate limit")) {
      return "🚦 Slow down! You're going too fast. Please wait a moment.";
    }

    if (message.includes("database")) {
      return "💾 Database is temporarily busy. Please try again in a moment.";
    }

    return "❌ Something went wrong. Our team has been notified and will investigate.";
  }

  /**
   * Start monitoring for patterns and anomalies
   */
  startErrorMonitoring() {
    // Check for error spikes every 5 minutes
    setInterval(() => {
      const now = Date.now();
      const recentErrors = [];

      for (const [command, errorData] of this.lastErrors.entries()) {
        if (now - errorData.timestamp < 300000) {
          // Last 5 minutes
          recentErrors.push({ command, ...errorData });
        }
      }

      if (recentErrors.length > 10) {
        logger.warn("[ErrorBoundary] High error rate detected", {
          count: recentErrors.length,
          commands: recentErrors.map((e) => e.command),
        });

        this.notifyAdmins(
          `⚠️ **High Error Rate Alert**\n${recentErrors.length} errors in the last 5 minutes`
        );
      }
    }, 300000); // 5 minutes
  }

  /**
   * Get error statistics
   */
  getStats() {
    const stats = {
      totalErrors: Array.from(this.errorCount.values()).reduce(
        (a, b) => a + b,
        0
      ),
      commandErrors: Object.fromEntries(this.errorCount),
      circuitBreakers: Object.fromEntries(
        Array.from(this.circuitBreakers.entries()).map(([key, val]) => [
          key,
          val.state,
        ])
      ),
      recentErrors: Array.from(this.lastErrors.entries()).map(
        ([cmd, data]) => ({
          command: cmd,
          count: data.count,
          lastError: data.error,
          timestamp: data.timestamp,
        })
      ),
    };

    return stats;
  }

  /**
   * Notify bot admins of critical issues
   */
  async notifyAdmins(message) {
    try {
      const adminIds = process.env.ADMIN_USER_IDS?.split(",") || [];

      for (const adminId of adminIds) {
        try {
          const user = await this.client.users.fetch(adminId);
          await user.send(
            `🚨 **System Alert**\n${message}\n\nTimestamp: <t:${Math.floor(Date.now() / 1000)}:F>`
          );
        } catch (err) {
          logger.error("[ErrorBoundary] Failed to notify admin", {
            adminId,
            error: err.message,
          });
        }
      }
    } catch (error) {
      logger.error("[ErrorBoundary] Admin notification failed", error);
    }
  }

  /**
   * Create a snapshot of current errors for debugging
   */
  async createErrorSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      stats: this.getStats(),
      systemInfo: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        guildCount: this.client.guilds.cache.size,
      },
    };

    try {
      await db.db.run(
        `INSERT INTO error_snapshots (timestamp, snapshot_data) VALUES (?, ?)`,
        [Date.now(), JSON.stringify(snapshot)]
      );
    } catch (error) {
      logger.error("[ErrorBoundary] Failed to save error snapshot", error);
    }

    return snapshot;
  }
}

module.exports = ErrorBoundary;
