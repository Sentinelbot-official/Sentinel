#!/usr/bin/env node

/**
 * Documentation Auto-Generator
 * Generates markdown documentation from JSDoc comments
 * Usage: node generate-docs.js
 */

const fs = require("fs");
const path = require("path");

class DocGenerator {
  constructor() {
    this.commands = [];
    this.utils = [];
    this.events = [];
  }

  /**
   * Main generation function
   */
  async generate() {
    console.log("🚀 Starting documentation generation...\n");

    // Scan directories
    await this.scanCommands();
    await this.scanUtils();
    await this.scanEvents();

    // Generate markdown files
    this.generateCommandsDocs();
    this.generateUtilsDocs();
    this.generateEventsDocs();
    this.generateIndexDocs();

    console.log("\n✅ Documentation generation complete!");
    console.log("📁 Output: readmes/AUTO_GENERATED_DOCS.md");
  }

  /**
   * Scan commands directory
   */
  async scanCommands() {
    const commandsDir = path.join(__dirname, "commands");
    const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".js"));

    for (const file of files) {
      const filePath = path.join(commandsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      const command = this.extractCommandInfo(content, file);
      if (command) {
        this.commands.push(command);
      }
    }

    console.log(`📜 Found ${this.commands.length} commands`);
  }

  /**
   * Scan utils directory
   */
  async scanUtils() {
    const utilsDir = path.join(__dirname, "utils");
    const files = fs.readdirSync(utilsDir).filter((f) => f.endsWith(".js"));

    for (const file of files) {
      const filePath = path.join(utilsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      const util = this.extractUtilInfo(content, file);
      if (util) {
        this.utils.push(util);
      }
    }

    console.log(`🔧 Found ${this.utils.length} utilities`);
  }

  /**
   * Scan events directory
   */
  async scanEvents() {
    const eventsDir = path.join(__dirname, "events");
    const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".js"));

    for (const file of files) {
      const filePath = path.join(eventsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      const event = this.extractEventInfo(content, file);
      if (event) {
        this.events.push(event);
      }
    }

    console.log(`📡 Found ${this.events.length} event handlers`);
  }

  /**
   * Extract command information from file
   */
  extractCommandInfo(content, filename) {
    try {
      const nameMatch = content.match(/\.setName\(['"](.+)['"]\)/);
      const descMatch = content.match(/\.setDescription\(['"](.+)['"]\)/);

      if (!nameMatch) {
        return null;
      }

      // Extract subcommands
      const subcommands = [];
      const subcommandRegex =
        /\.addSubcommand\(.*?\.setName\(['"](.+?)['"]\).*?\.setDescription\(['"](.+?)['"]\)/gs;
      let match;

      while ((match = subcommandRegex.exec(content)) !== null) {
        subcommands.push({
          name: match[1],
          description: match[2],
        });
      }

      return {
        name: nameMatch[1],
        description: descMatch ? descMatch[1] : "No description",
        filename,
        subcommands,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract utility information from file
   */
  extractUtilInfo(content, filename) {
    try {
      const classMatch = content.match(/class\s+(\w+)/);
      if (!classMatch) {
        return null;
      }

      const docMatch = content.match(/\/\*\*\s*\n\s*\*\s*(.+)\n/);

      return {
        name: classMatch[1],
        description: docMatch ? docMatch[1] : "No description",
        filename,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract event information from file
   */
  extractEventInfo(content, filename) {
    const eventName = filename.replace(".js", "");
    const docMatch = content.match(/\/\*\*\s*\n\s*\*\s*(.+)\n/);

    return {
      name: eventName,
      description: docMatch ? docMatch[1] : "Event handler",
      filename,
    };
  }

  /**
   * Generate commands documentation
   */
  generateCommandsDocs() {
    let md = "## 📜 Commands\n\n";
    md += `Total: ${this.commands.length} commands\n\n`;

    this.commands.sort((a, b) => a.name.localeCompare(b.name));

    for (const cmd of this.commands) {
      md += `### \`/${cmd.name}\`\n\n`;
      md += `${cmd.description}\n\n`;

      if (cmd.subcommands.length > 0) {
        md += "**Subcommands:**\n";
        for (const sub of cmd.subcommands) {
          md += `- \`${sub.name}\` - ${sub.description}\n`;
        }
      }

      md += "\n---\n\n";
    }

    this.commandsDocs = md;
  }

  /**
   * Generate utils documentation
   */
  generateUtilsDocs() {
    let md = "## 🔧 Utilities\n\n";
    md += `Total: ${this.utils.length} utility systems\n\n`;

    this.utils.sort((a, b) => a.name.localeCompare(b.name));

    for (const util of this.utils) {
      md += `### ${util.name}\n`;
      md += `${util.description}\n\n`;
    }

    this.utilsDocs = md;
  }

  /**
   * Generate events documentation
   */
  generateEventsDocs() {
    let md = "## 📡 Event Handlers\n\n";
    md += `Total: ${this.events.length} event handlers\n\n`;

    this.events.sort((a, b) => a.name.localeCompare(b.name));

    for (const event of this.events) {
      md += `- **${event.name}**: ${event.description}\n`;
    }

    this.eventsDocs = md;
  }

  /**
   * Generate index documentation
   */
  generateIndexDocs() {
    const md = `# Auto-Generated Documentation

> Last Updated: ${new Date().toLocaleString()}

This documentation is automatically generated from code structure and JSDoc comments.

${this.commandsDocs}

${this.utilsDocs}

${this.eventsDocs}

---

**Generated by**: Sentinel Bot Documentation Generator  
**Update**: Run \`node generate-docs.js\` to regenerate
`;

    const outputPath = path.join(__dirname, "readmes/AUTO_GENERATED_DOCS.md");
    fs.writeFileSync(outputPath, md, "utf8");
  }
}

// Run generator
const generator = new DocGenerator();
generator.generate().catch((error) => {
  console.error("❌ Documentation generation failed:", error);
  process.exit(1);
});

module.exports = DocGenerator;
