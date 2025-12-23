const db = require("./database");
const logger = require("./logger");
const cron = require("node-cron");

class GrowthTracker {
  constructor() {
    // Defer initialization to ensure database is ready
    setImmediate(() => {
      this.initTable();
    });
    this.client = null;
  }

  // Set client reference (needed for daily snapshots)
  setClient(client) {
    this.client = client;
    this.startDailySnapshots();
  }

  // Start automatic daily snapshot creation
  startDailySnapshots() {
    if (!this.client) {
      logger.warn(
        "GrowthTracker",
        "Client not set, cannot start daily snapshots"
      );
      return;
    }

    // Create snapshot daily at midnight
    cron.schedule("0 0 * * *", async () => {
      try {
        await this.createDailySnapshot(this.client);
        logger.info("GrowthTracker", "Daily snapshot created automatically");
      } catch (error) {
        logger.error("GrowthTracker", "Failed to create daily snapshot", error);
      }
    });

    // Create initial snapshot on startup (if not already created today)
    setTimeout(async () => {
      try {
        const today = new Date().toISOString().split("T")[0];
        const existing = await new Promise((resolve) => {
          db.db.get(
            "SELECT date FROM daily_snapshots WHERE date = ?",
            [today],
            (err, row) => {
              if (err || !row) {
                resolve(null);
              } else {
                resolve(row);
              }
            }
          );
        });

        if (!existing) {
          await this.createDailySnapshot(this.client);
          logger.info("GrowthTracker", "Initial daily snapshot created");
        }
      } catch (error) {
        logger.error(
          "GrowthTracker",
          "Failed to create initial snapshot",
          error
        );
      }
    }, 30000); // Wait 30 seconds after startup

    logger.info(
      "GrowthTracker",
      "Daily snapshot scheduler started (runs at midnight)"
    );
  }

  initTable() {
    if (!db.db) {
      // Database not ready yet, retry
      setTimeout(() => this.initTable(), 100);
      return;
    }
    db.db.run(`
      CREATE TABLE IF NOT EXISTS growth_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_type TEXT NOT NULL,
        value INTEGER NOT NULL,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      )
    `);

    db.db.run(`
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        total_servers INTEGER,
        total_users INTEGER,
        servers_added INTEGER DEFAULT 0,
        servers_removed INTEGER DEFAULT 0,
        commands_run INTEGER DEFAULT 0,
        raids_detected INTEGER DEFAULT 0,
        bans_issued INTEGER DEFAULT 0,
        uptime_percentage REAL DEFAULT 100.0,
        avg_response_time REAL DEFAULT 0.0,
        metadata TEXT
      )
    `);
  }

  // Track server add
  async trackServerAdd(guildId, source = "unknown", memberCount = 0) {
    return new Promise((resolve, reject) => {
      db.db.run(
        `INSERT INTO growth_metrics (metric_type, value, metadata, timestamp) 
         VALUES (?, ?, ?, ?)`,
        [
          "server_add",
          1,
          JSON.stringify({ guildId, source, memberCount }),
          Date.now(),
        ],
        (err) => {
          if (err) {
            logger.error("Growth tracking error:", err);
            reject(err);
          } else {
            logger.info(`📈 Server added (${source}): ${memberCount} members`);
            resolve();
          }
        }
      );
    });
  }

  // Track server remove
  async trackServerRemove(guildId, reason = "unknown", daysActive = 0) {
    return new Promise((resolve, reject) => {
      db.db.run(
        `INSERT INTO growth_metrics (metric_type, value, metadata, timestamp) 
         VALUES (?, ?, ?, ?)`,
        [
          "server_remove",
          -1,
          JSON.stringify({ guildId, reason, daysActive }),
          Date.now(),
        ],
        (err) => {
          if (err) {
            logger.error("Growth tracking error:", err);
            reject(err);
          } else {
            logger.info(
              "Growth Tracker",
              `📉 Server removed (${reason}): Active for ${daysActive} days`
            );
            resolve();
          }
        }
      );
    });
  }

  // Track command usage
  async trackCommand(commandName, guildId, userId) {
    return new Promise((resolve, reject) => {
      db.db.run(
        `INSERT INTO growth_metrics (metric_type, value, metadata, timestamp) 
         VALUES (?, ?, ?, ?)`,
        [
          "command_used",
          1,
          JSON.stringify({ command: commandName, guildId, userId }),
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
  }

  // Create daily snapshot
  async createDailySnapshot(client) {
    const today = new Date().toISOString().split("T")[0];

    // Get today's metrics
    const metrics = await this.getTodayMetrics();
    const totalServers = client.guilds.cache.size;
    const totalUsers = client.guilds.cache.reduce(
      (acc, g) => acc + g.memberCount,
      0
    );

    return new Promise((resolve, reject) => {
      db.db.run(
        `INSERT OR REPLACE INTO daily_snapshots 
         (date, total_servers, total_users, servers_added, servers_removed, 
          commands_run, raids_detected, bans_issued, metadata) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          today,
          totalServers,
          totalUsers,
          metrics.serversAdded,
          metrics.serversRemoved,
          metrics.commandsRun,
          metrics.raidsDetected,
          metrics.bansIssued,
          JSON.stringify({ timestamp: Date.now() }),
        ],
        (err) => {
          if (err) {
            logger.error("Snapshot error:", err);
            reject(err);
          } else {
            logger.success(
              `Snapshot created: ${totalServers} servers, ${totalUsers} users`
            );
            resolve();
          }
        }
      );
    });
  }

  // Get today's metrics
  async getTodayMetrics() {
    const todayStart = new Date().setHours(0, 0, 0, 0);

    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT metric_type, COUNT(*) as count 
         FROM growth_metrics 
         WHERE timestamp >= ? 
         GROUP BY metric_type`,
        [todayStart],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const metrics = {
              serversAdded: 0,
              serversRemoved: 0,
              commandsRun: 0,
              raidsDetected: 0,
              bansIssued: 0,
            };

            rows.forEach((row) => {
              if (row.metric_type === "server_add") {
                metrics.serversAdded = row.count;
              }
              if (row.metric_type === "server_remove") {
                metrics.serversRemoved = row.count;
              }
              if (row.metric_type === "command_used") {
                metrics.commandsRun = row.count;
              }
              if (row.metric_type === "raid_detected") {
                metrics.raidsDetected = row.count;
              }
              if (row.metric_type === "ban_issued") {
                metrics.bansIssued = row.count;
              }
            });

            resolve(metrics);
          }
        }
      );
    });
  }

  // Get growth over time
  async getGrowthHistory(days = 30) {
    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT * FROM daily_snapshots 
         ORDER BY date DESC 
         LIMIT ?`,
        [days],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }

  // Get retention rate
  async getRetentionRate() {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT 
          COUNT(CASE WHEN metric_type = 'server_add' THEN 1 END) as adds,
          COUNT(CASE WHEN metric_type = 'server_remove' THEN 1 END) as removes
         FROM growth_metrics 
         WHERE timestamp >= ?`,
        [thirtyDaysAgo],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const row = rows[0] || { adds: 0, removes: 0 };
            const retention =
              row.adds > 0 ? ((row.adds - row.removes) / row.adds) * 100 : 100;
            resolve({
              adds: row.adds,
              removes: row.removes,
              retention: Math.round(retention * 10) / 10,
            });
          }
        }
      );
    });
  }

  // Get most popular commands
  async getTopCommands(limit = 10) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT metadata, COUNT(*) as usage_count
         FROM growth_metrics 
         WHERE metric_type = 'command_used' AND timestamp >= ?
         GROUP BY metadata
         ORDER BY usage_count DESC
         LIMIT ?`,
        [sevenDaysAgo, limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const commands = (rows || [])
              .map((row) => {
                try {
                  const data = JSON.parse(row.metadata);
                  return {
                    command: data.command,
                    usage: row.usage_count,
                  };
                } catch {
                  return null;
                }
              })
              .filter((c) => c !== null);
            resolve(commands);
          }
        }
      );
    });
  }

  // Get invite sources
  async getInviteSources(days = 30) {
    const daysAgo = Date.now() - days * 24 * 60 * 60 * 1000;

    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT metadata, COUNT(*) as count
         FROM growth_metrics 
         WHERE metric_type = 'server_add' AND timestamp >= ?
         GROUP BY metadata
         ORDER BY count DESC`,
        [daysAgo],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const sources = {};
            (rows || []).forEach((row) => {
              try {
                const data = JSON.parse(row.metadata);
                const source = data.source || "unknown";
                sources[source] = (sources[source] || 0) + 1;
              } catch {
                sources.unknown = (sources.unknown || 0) + 1;
              }
            });
            resolve(sources);
          }
        }
      );
    });
  }

  // Get detailed growth statistics
  async getGrowthStats(days = 30) {
    const daysAgo = Date.now() - days * 24 * 60 * 60 * 1000;

    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT 
          COUNT(CASE WHEN metric_type = 'server_add' THEN 1 END) as servers_added,
          COUNT(CASE WHEN metric_type = 'server_remove' THEN 1 END) as servers_removed,
          COUNT(CASE WHEN metric_type = 'command_used' THEN 1 END) as commands_run
         FROM growth_metrics 
         WHERE timestamp >= ?`,
        [daysAgo],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const stats = rows[0] || {
              servers_added: 0,
              servers_removed: 0,
              commands_run: 0,
            };
            stats.net_growth = stats.servers_added - stats.servers_removed;
            stats.growth_rate_per_day =
              days > 0 ? (stats.net_growth / days).toFixed(2) : 0;
            resolve(stats);
          }
        }
      );
    });
  }

  // Get growth timeline (daily breakdown)
  async getGrowthTimeline(days = 30) {
    const daysAgo = Date.now() - days * 24 * 60 * 60 * 1000;

    return new Promise((resolve, reject) => {
      db.db.all(
        `SELECT 
          DATE(timestamp/1000, 'unixepoch') as date,
          COUNT(CASE WHEN metric_type = 'server_add' THEN 1 END) as joins,
          COUNT(CASE WHEN metric_type = 'server_remove' THEN 1 END) as leaves
         FROM growth_metrics 
         WHERE timestamp >= ?
         GROUP BY date
         ORDER BY date ASC`,
        [daysAgo],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const timeline = (rows || []).map((row) => ({
              date: row.date,
              joins: row.joins || 0,
              leaves: row.leaves || 0,
              net: (row.joins || 0) - (row.leaves || 0),
            }));
            resolve(timeline);
          }
        }
      );
    });
  }

  // Get current growth rate (servers per day)
  async getCurrentGrowthRate(days = 7) {
    const stats = await this.getGrowthStats(days);
    return {
      serversPerDay: parseFloat(stats.growth_rate_per_day) || 0,
      netGrowth: stats.net_growth || 0,
      period: `${days} days`,
    };
  }
}

module.exports = new GrowthTracker();
