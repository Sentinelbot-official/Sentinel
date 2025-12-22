/**
 * Database Migration Script
 * Run this to update the database schema with new tables
 */

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "data", "Nexus.db");
const db = new sqlite3.Database(dbPath);

console.log("🔄 Starting database migration...");

db.serialize(() => {
  // Advanced Metrics Tables
  db.run(
    `
    CREATE TABLE IF NOT EXISTS command_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        command_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        execution_time INTEGER NOT NULL,
        success INTEGER DEFAULT 1,
        timestamp INTEGER NOT NULL
    )
  `,
    (err) => {
      if (err) console.error("❌ command_metrics:", err.message);
      else console.log("✅ command_metrics table ready");
    }
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS user_engagement (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        metadata TEXT,
        timestamp INTEGER NOT NULL
    )
  `,
    (err) => {
      if (err) console.error("❌ user_engagement:", err.message);
      else console.log("✅ user_engagement table ready");
    }
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS server_health_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        member_count INTEGER,
        online_count INTEGER,
        message_rate REAL,
        command_rate REAL,
        violation_rate REAL,
        avg_response_time REAL,
        timestamp INTEGER NOT NULL
    )
  `,
    (err) => {
      if (err) console.error("❌ server_health_metrics:", err.message);
      else console.log("✅ server_health_metrics table ready");
    }
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS moderation_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        action TEXT NOT NULL,
        moderator_id TEXT,
        target_id TEXT,
        reason TEXT,
        timestamp INTEGER NOT NULL
    )
  `,
    (err) => {
      if (err) console.error("❌ moderation_metrics:", err.message);
      else console.log("✅ moderation_metrics table ready");
    }
  );

  // ML Models
  db.run(
    `
    CREATE TABLE IF NOT EXISTS ml_models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        model_type TEXT NOT NULL,
        model_data TEXT NOT NULL,
        accuracy REAL,
        trained_at INTEGER NOT NULL,
        UNIQUE(guild_id, model_type, trained_at)
    )
  `,
    (err) => {
      if (err) console.error("❌ ml_models:", err.message);
      else console.log("✅ ml_models table ready");
    }
  );

  // Retention Predictions
  db.run(
    `
    CREATE TABLE IF NOT EXISTS retention_predictions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        risk_score REAL NOT NULL,
        risk_level TEXT NOT NULL,
        reasons TEXT,
        predicted_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
    )
  `,
    (err) => {
      if (err) console.error("❌ retention_predictions:", err.message);
      else console.log("✅ retention_predictions table ready");
    }
  );

  // Threat Correlation
  db.run(
    `
    CREATE TABLE IF NOT EXISTS threat_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        severity INTEGER NOT NULL,
        metadata TEXT,
        timestamp INTEGER NOT NULL
    )
  `,
    (err) => {
      if (err) console.error("❌ threat_reports:", err.message);
      else console.log("✅ threat_reports table ready");
    }
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS threat_correlations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        threat_type TEXT NOT NULL,
        affected_servers TEXT NOT NULL,
        metadata TEXT,
        confidence REAL NOT NULL,
        detected_at INTEGER NOT NULL
    )
  `,
    (err) => {
      if (err) console.error("❌ threat_correlations:", err.message);
      else console.log("✅ threat_correlations table ready");
    }
  );

  // Admin 2FA (if not exists)
  db.run(
    `
    CREATE TABLE IF NOT EXISTS admin_2fa (
        user_id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used INTEGER
    )
  `,
    (err) => {
      if (err) console.error("❌ admin_2fa:", err.message);
      else console.log("✅ admin_2fa table ready");
    }
  );

  console.log("\n🎉 Database migration completed!");
  console.log("✅ All new tables have been created");
  console.log("🔄 You can now restart the bot");

  db.close();
});
