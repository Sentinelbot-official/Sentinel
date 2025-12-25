/**
 * Seasonal System for Nexus Bot
 * Automatically adapts bot behavior based on current season and special events
 */

class SeasonalSystem {
  constructor() {
    this.seasons = {
      CHRISTMAS: {
        name: 'Christmas',
        emoji: '🎄',
        colors: {
          primary: 0xC41E3A, // Christmas Red
          secondary: 0x165B33, // Christmas Green
          accent: 0xFFD700 // Gold
        },
        dateRange: { start: { month: 12, day: 1 }, end: { month: 1, day: 6 } },
        statusMessages: [
          '🎄 Protecting {servers} servers this Christmas',
          '🎁 Unwrapping security threats',
          '❄️ Keeping servers cozy and safe',
          '🔔 Jingle bells, raid repels',
          '🎅 Santa\'s security helper',
          '⛄ Freezing out the bad actors',
          '🎄 Merry Christmas from Nexus!'
        ],
        embedFooter: '🎄 Happy Holidays! • Nexus Security',
        welcomeGreeting: ['Merry Christmas', 'Happy Holidays', 'Season\'s Greetings', 'Ho Ho Ho'],
        theme: 'festive'
      },
      HALLOWEEN: {
        name: 'Halloween',
        emoji: '🎃',
        colors: {
          primary: 0xFF6600, // Orange
          secondary: 0x1a1a1a, // Dark
          accent: 0x9D00FF // Purple
        },
        dateRange: { start: { month: 10, day: 25 }, end: { month: 10, day: 31 } },
        statusMessages: [
          '🎃 Haunting {servers} servers',
          '👻 Scaring away threats',
          '🕷️ Catching security bugs',
          '🦇 Protecting in the shadows',
          '💀 Dead serious about security',
          '🕸️ Weaving a web of protection',
          '🎃 Happy Halloween from Nexus!'
        ],
        embedFooter: '🎃 Happy Halloween! • Nexus Security',
        welcomeGreeting: ['Happy Halloween', 'Spooky Greetings', 'Trick or Treat', 'Boo'],
        theme: 'spooky'
      },
      VALENTINES: {
        name: 'Valentine\'s Day',
        emoji: '💝',
        colors: {
          primary: 0xFF1493, // Deep Pink
          secondary: 0xFF69B4, // Hot Pink
          accent: 0xFF0000 // Red
        },
        dateRange: { start: { month: 2, day: 10 }, end: { month: 2, day: 14 } },
        statusMessages: [
          '💝 Loving {servers} servers',
          '💕 Spreading security love',
          '💖 Protecting with passion',
          '💗 Your server\'s Valentine',
          '💘 Cupid\'s security arrow',
          '❤️ Love is in the air... and so is security',
          '💝 Happy Valentine\'s Day!'
        ],
        embedFooter: '💝 Happy Valentine\'s Day! • Nexus Security',
        welcomeGreeting: ['Happy Valentine\'s Day', 'Love & Security', 'Be Mine', 'XOXO'],
        theme: 'romantic'
      },
      NEW_YEAR: {
        name: 'New Year',
        emoji: '🎆',
        colors: {
          primary: 0xFFD700, // Gold
          secondary: 0xC0C0C0, // Silver
          accent: 0xFF1493 // Pink
        },
        dateRange: { start: { month: 12, day: 31 }, end: { month: 1, day: 1 } },
        statusMessages: [
          '🎆 New Year, New Security',
          '🎊 Celebrating {servers} servers',
          '🥂 Cheers to a secure year',
          '🎉 Party safely with Nexus',
          '✨ Sparkling security for the new year',
          '🎆 Happy New Year from Nexus!'
        ],
        embedFooter: '🎆 Happy New Year! • Nexus Security',
        welcomeGreeting: ['Happy New Year', 'Cheers to the New Year', 'New Year, New You', '2025!'],
        theme: 'celebration'
      },
      SPRING: {
        name: 'Spring',
        emoji: '🌸',
        colors: {
          primary: 0xFFB7C5, // Cherry Blossom Pink
          secondary: 0x90EE90, // Light Green
          accent: 0xFFFF00 // Yellow
        },
        dateRange: { start: { month: 3, day: 1 }, end: { month: 5, day: 31 } },
        statusMessages: [
          '🌸 Blooming security for {servers} servers',
          '🌷 Spring cleaning threats',
          '🌼 Fresh protection, fresh start',
          '🦋 Fluttering through security checks',
          '🌱 Growing stronger every day',
          '☀️ Sunshine and security'
        ],
        embedFooter: '🌸 Spring is here! • Nexus Security',
        welcomeGreeting: ['Happy Spring', 'Spring Greetings', 'Bloom with us'],
        theme: 'fresh'
      },
      SUMMER: {
        name: 'Summer',
        emoji: '☀️',
        colors: {
          primary: 0xFFA500, // Orange
          secondary: 0x87CEEB, // Sky Blue
          accent: 0xFFFF00 // Yellow
        },
        dateRange: { start: { month: 6, day: 1 }, end: { month: 8, day: 31 } },
        statusMessages: [
          '☀️ Sunny security for {servers} servers',
          '🏖️ Beach-level relaxation, fort-level security',
          '🌊 Making waves in protection',
          '🍉 Cool security for hot days',
          '🌴 Paradise protected by Nexus',
          '😎 Staying cool while keeping you safe'
        ],
        embedFooter: '☀️ Enjoy your summer! • Nexus Security',
        welcomeGreeting: ['Happy Summer', 'Summer Vibes', 'Enjoy the sunshine'],
        theme: 'bright'
      },
      FALL: {
        name: 'Fall',
        emoji: '🍂',
        colors: {
          primary: 0xD2691E, // Chocolate
          secondary: 0xFF8C00, // Dark Orange
          accent: 0x8B4513 // Saddle Brown
        },
        dateRange: { start: { month: 9, day: 1 }, end: { month: 11, day: 30 } },
        statusMessages: [
          '🍂 Falling for security in {servers} servers',
          '🍁 Autumn leaves, security stays',
          '🎃 Harvesting protection',
          '🌰 Gathering threats before they grow',
          '☕ Cozy security for cozy days',
          '🦃 Thankful for secure servers'
        ],
        embedFooter: '🍂 Happy Fall! • Nexus Security',
        welcomeGreeting: ['Happy Fall', 'Autumn Greetings', 'Fall into security'],
        theme: 'cozy'
      },
      WINTER: {
        name: 'Winter',
        emoji: '❄️',
        colors: {
          primary: 0x4682B4, // Steel Blue
          secondary: 0xB0E0E6, // Powder Blue
          accent: 0xFFFFFF // White
        },
        dateRange: { start: { month: 1, day: 7 }, end: { month: 2, day: 28 } },
        statusMessages: [
          '❄️ Winter protection for {servers} servers',
          '⛄ Building security snowmen',
          '🧊 Ice-cold threat detection',
          '🌨️ Snowing down on bad actors',
          '☃️ Frosty but friendly security',
          '🏔️ Peak security performance'
        ],
        embedFooter: '❄️ Stay warm and safe! • Nexus Security',
        welcomeGreeting: ['Happy Winter', 'Winter Greetings', 'Stay warm'],
        theme: 'cool'
      }
    };
  }

  /**
   * Get the current season/event based on today's date
   * @returns {Object} Current season data
   */
  getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const day = now.getDate();

    // Check special events first (they take priority)
    const specialEvents = ['NEW_YEAR', 'VALENTINES', 'HALLOWEEN', 'CHRISTMAS'];
    for (const eventKey of specialEvents) {
      const event = this.seasons[eventKey];
      if (this.isDateInRange(month, day, event.dateRange)) {
        return { key: eventKey, ...event };
      }
    }

    // Check regular seasons
    const regularSeasons = ['SPRING', 'SUMMER', 'FALL', 'WINTER'];
    for (const seasonKey of regularSeasons) {
      const season = this.seasons[seasonKey];
      if (this.isDateInRange(month, day, season.dateRange)) {
        return { key: seasonKey, ...season };
      }
    }

    // Fallback to a default season (should never happen)
    return { key: 'SPRING', ...this.seasons.SPRING };
  }

  /**
   * Check if a date falls within a range
   * @param {number} month - Current month (1-12)
   * @param {number} day - Current day
   * @param {Object} range - Date range object
   * @returns {boolean}
   */
  isDateInRange(month, day, range) {
    const { start, end } = range;
    
    // Handle year-crossing ranges (e.g., Dec 31 - Jan 1)
    if (start.month > end.month) {
      return (
        (month === start.month && day >= start.day) ||
        (month === end.month && day <= end.day) ||
        (month > start.month || month < end.month)
      );
    }
    
    // Handle same-month ranges
    if (start.month === end.month) {
      return month === start.month && day >= start.day && day <= end.day;
    }
    
    // Handle normal ranges
    return (
      (month === start.month && day >= start.day) ||
      (month === end.month && day <= end.day) ||
      (month > start.month && month < end.month)
    );
  }

  /**
   * Get a random status message for the current season
   * @param {number} serverCount - Number of servers the bot is in
   * @returns {string}
   */
  getRandomStatus(serverCount = 0) {
    const season = this.getCurrentSeason();
    const messages = season.statusMessages;
    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    return randomMessage.replace('{servers}', serverCount.toLocaleString());
  }

  /**
   * Get the primary color for the current season
   * @returns {number} Hex color code
   */
  getSeasonalColor() {
    const season = this.getCurrentSeason();
    return season.colors.primary;
  }

  /**
   * Get all colors for the current season
   * @returns {Object} Color object with primary, secondary, accent
   */
  getSeasonalColors() {
    const season = this.getCurrentSeason();
    return season.colors;
  }

  /**
   * Get the embed footer for the current season
   * @returns {string}
   */
  getSeasonalFooter() {
    const season = this.getCurrentSeason();
    return season.embedFooter;
  }

  /**
   * Get a random greeting for the current season
   * @returns {string}
   */
  getRandomGreeting() {
    const season = this.getCurrentSeason();
    const greetings = season.welcomeGreeting;
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  /**
   * Get the emoji for the current season
   * @returns {string}
   */
  getSeasonalEmoji() {
    const season = this.getCurrentSeason();
    return season.emoji;
  }

  /**
   * Get all seasonal data
   * @returns {Object}
   */
  getSeasonalData() {
    return this.getCurrentSeason();
  }

  /**
   * Check if we're currently in a special event period
   * @returns {boolean}
   */
  isSpecialEvent() {
    const season = this.getCurrentSeason();
    return ['NEW_YEAR', 'VALENTINES', 'HALLOWEEN', 'CHRISTMAS'].includes(season.key);
  }
}

module.exports = new SeasonalSystem();

