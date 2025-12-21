/**
 * Nexus Bot Embeddable Widget
 * Displays live bot statistics on any website
 */
(function () {
  "use strict";

  const API_URL = document.currentScript.src.replace("/widget.js", "");
  const theme = document.currentScript.getAttribute("data-theme") || "light";
  const layout =
    document.currentScript.getAttribute("data-layout") || "compact";
  const showButton =
    document.currentScript.getAttribute("data-show-button") !== "false";

  // Inject CSS
  const style = document.createElement("style");
  style.textContent = `
    .sentinel-widget {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: ${theme === "dark" ? "#2d2d2d" : "white"};
      color: ${theme === "dark" ? "#f8f8f2" : "#333"};
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 12px rgba(0,0,0,${theme === "dark" ? "0.3" : "0.1"});
      max-width: 400px;
    }
    .sentinel-widget-header {
      display: flex;
      align-items: center;
      margin-bottom: 15px;
    }
    .sentinel-widget-avatar {
      width: 50px;
      height: 50px;
      border-radius: 50%;
      margin-right: 12px;
    }
    .sentinel-widget-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .sentinel-widget-status {
      font-size: 13px;
      color: ${theme === "dark" ? "#73d13d" : "#52c41a"};
    }
    .sentinel-widget-stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin: 15px 0;
    }
    .sentinel-widget-stat {
      text-align: center;
      padding: 12px;
      background: ${theme === "dark" ? "#3a3a3a" : "#f8f9fa"};
      border-radius: 8px;
    }
    .sentinel-widget-stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #667eea;
    }
    .sentinel-widget-stat-label {
      font-size: 12px;
      color: ${theme === "dark" ? "#aaa" : "#666"};
      text-transform: uppercase;
      margin-top: 4px;
    }
    .sentinel-widget-button {
      display: block;
      width: 100%;
      padding: 12px;
      background: #667eea;
      color: white;
      text-align: center;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      margin-top: 15px;
      transition: background 0.3s;
    }
    .sentinel-widget-button:hover {
      background: #5568d3;
    }
  `;
  document.head.appendChild(style);

  // Create widget HTML
  function createWidget(stats) {
    let html = `
      <div class="sentinel-widget">
        <div class="sentinel-widget-header">
          <img src="https://cdn.discordapp.com/app-icons/1444739230679957646/32f2d77d44c2f3989fecd858be53f396.png?size=256" 
               alt="Nexus Bot" 
               class="sentinel-widget-avatar">
          <div>
            <div class="sentinel-widget-title">Nexus Bot</div>
            <div class="sentinel-widget-status">● Online</div>
          </div>
        </div>
    `;

    if (layout !== "minimal") {
      html += `
        <div class="sentinel-widget-stats">
          <div class="sentinel-widget-stat">
            <div class="sentinel-widget-stat-value">${stats.servers || "..."}</div>
            <div class="sentinel-widget-stat-label">Servers</div>
          </div>
          <div class="sentinel-widget-stat">
            <div class="sentinel-widget-stat-value">100+</div>
            <div class="sentinel-widget-stat-label">Commands</div>
          </div>
        </div>
      `;
    }

    if (layout === "full") {
      html += `
        <div class="sentinel-widget-stats">
          <div class="sentinel-widget-stat">
            <div class="sentinel-widget-stat-value">${stats.uptime || "99.9%"}</div>
            <div class="sentinel-widget-stat-label">Uptime</div>
          </div>
          <div class="sentinel-widget-stat">
            <div class="sentinel-widget-stat-value">24/7</div>
            <div class="sentinel-widget-stat-label">Support</div>
          </div>
        </div>
      `;
    }

    if (showButton) {
      html += `
        <a href="https://discord.com/oauth2/authorize?client_id=1444739230679957646&permissions=268443574&scope=bot%20applications.commands" 
           target="_blank" 
           class="sentinel-widget-button">
          Invite to Server
        </a>
      `;
    }

    html += "</div>";
    return html;
  }

  // Fetch stats and render
  async function init() {
    try {
      const response = await fetch(`${API_URL}/api/stats`);
      const stats = await response.json();

      const container = document.getElementById("sentinel-widget");
      if (container) {
        container.innerHTML = createWidget(stats);
      }
    } catch (error) {
      console.error("Nexus Widget: Failed to load stats", error);
      const container = document.getElementById("sentinel-widget");
      if (container) {
        container.innerHTML = createWidget({});
      }
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
