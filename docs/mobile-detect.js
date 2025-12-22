/**
 * Mobile Detection and Responsive Enhancement System
 * Detects device type and applies appropriate optimizations
 */

(function () {
  "use strict";

  const MobileDetect = {
    // Device detection
    isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    ),
    isTablet: /iPad|Android(?!.*Mobile)/i.test(navigator.userAgent),
    isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent),
    isAndroid: /Android/i.test(navigator.userAgent),
    isTouchDevice:
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      navigator.msMaxTouchPoints > 0,

    // Screen size detection
    isSmallScreen: () => window.innerWidth < 768,
    isMediumScreen: () =>
      window.innerWidth >= 768 && window.innerWidth < 1024,
    isLargeScreen: () => window.innerWidth >= 1024,

    // Get device type
    getDeviceType: function () {
      if (this.isTablet) return "tablet";
      if (this.isMobile) return "mobile";
      return "desktop";
    },

    // Get OS
    getOS: function () {
      if (this.isIOS) return "ios";
      if (this.isAndroid) return "android";
      if (navigator.userAgent.includes("Windows")) return "windows";
      if (navigator.userAgent.includes("Mac")) return "mac";
      if (navigator.userAgent.includes("Linux")) return "linux";
      return "unknown";
    },

    // Initialize mobile optimizations
    init: function () {
      const deviceType = this.getDeviceType();
      const os = this.getOS();

      // Add classes to body
      document.body.classList.add(`device-${deviceType}`);
      document.body.classList.add(`os-${os}`);

      if (this.isTouchDevice) {
        document.body.classList.add("touch-device");
      }

      // Apply mobile-specific optimizations
      if (this.isMobile || this.isTablet) {
        this.applyMobileOptimizations();
      }

      // Handle orientation changes
      window.addEventListener("orientationchange", () => {
        this.handleOrientationChange();
      });

      // Handle resize
      let resizeTimer;
      window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          this.handleResize();
        }, 250);
      });

      console.log(
        `📱 Device: ${deviceType} | OS: ${os} | Touch: ${this.isTouchDevice}`
      );
    },

    // Apply mobile-specific optimizations
    applyMobileOptimizations: function () {
      // Disable hover effects on mobile
      const style = document.createElement("style");
      style.textContent = `
        @media (hover: none) and (pointer: coarse) {
          * {
            -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
          }
          
          /* Disable hover animations on mobile */
          .btn:hover,
          .card:hover,
          a:hover {
            transform: none !important;
          }
        }
      `;
      document.head.appendChild(style);

      // Optimize images for mobile
      this.optimizeImages();

      // Add touch-friendly spacing
      this.addTouchFriendlySpacing();

      // Optimize navigation for mobile
      this.optimizeNavigation();

      // Prevent zoom on input focus (iOS)
      if (this.isIOS) {
        const inputs = document.querySelectorAll(
          'input[type="text"], input[type="email"], input[type="search"], textarea'
        );
        inputs.forEach((input) => {
          if (
            !input.style.fontSize ||
            parseInt(input.style.fontSize) < 16
          ) {
            input.style.fontSize = "16px";
          }
        });
      }
    },

    // Optimize images for mobile
    optimizeImages: function () {
      const images = document.querySelectorAll("img");
      images.forEach((img) => {
        // Add loading="lazy" if not already present
        if (!img.hasAttribute("loading")) {
          img.setAttribute("loading", "lazy");
        }

        // Add mobile-optimized class
        img.classList.add("mobile-optimized");
      });
    },

    // Add touch-friendly spacing
    addTouchFriendlySpacing: function () {
      const buttons = document.querySelectorAll(
        "button, .btn, a.btn, .dropdown-toggle"
      );
      buttons.forEach((btn) => {
        // Ensure minimum touch target size (44x44px)
        const rect = btn.getBoundingClientRect();
        if (rect.height < 44) {
          btn.style.minHeight = "44px";
          btn.style.paddingTop = "12px";
          btn.style.paddingBottom = "12px";
        }
      });
    },

    // Optimize navigation for mobile
    optimizeNavigation: function () {
      const nav = document.querySelector(".navbar");
      if (!nav) return;

      // Add mobile menu toggle if not exists
      if (!document.querySelector(".mobile-menu-toggle")) {
        const toggle = document.createElement("button");
        toggle.className = "mobile-menu-toggle";
        toggle.innerHTML = "☰";
        toggle.setAttribute("aria-label", "Toggle menu");

        toggle.addEventListener("click", () => {
          nav.classList.toggle("mobile-menu-open");
          toggle.innerHTML = nav.classList.contains("mobile-menu-open")
            ? "✕"
            : "☰";
        });

        const navRight = nav.querySelector(".nav-right");
        if (navRight) {
          nav.insertBefore(toggle, navRight);
        }
      }
    },

    // Handle orientation change
    handleOrientationChange: function () {
      const orientation =
        window.innerHeight > window.innerWidth ? "portrait" : "landscape";
      document.body.classList.remove("portrait", "landscape");
      document.body.classList.add(orientation);

      console.log(`📱 Orientation: ${orientation}`);
    },

    // Handle resize
    handleResize: function () {
      if (this.isSmallScreen()) {
        document.body.classList.add("small-screen");
        document.body.classList.remove("medium-screen", "large-screen");
      } else if (this.isMediumScreen()) {
        document.body.classList.add("medium-screen");
        document.body.classList.remove("small-screen", "large-screen");
      } else {
        document.body.classList.add("large-screen");
        document.body.classList.remove("small-screen", "medium-screen");
      }
    },

    // Get device info for analytics
    getDeviceInfo: function () {
      return {
        type: this.getDeviceType(),
        os: this.getOS(),
        touch: this.isTouchDevice,
        screenWidth: window.innerWidth,
        screenHeight: window.innerHeight,
        pixelRatio: window.devicePixelRatio || 1,
        orientation:
          window.innerHeight > window.innerWidth ? "portrait" : "landscape",
      };
    },
  };

  // Initialize on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      MobileDetect.init()
    );
  } else {
    MobileDetect.init();
  }

  // Expose to window for external use
  window.MobileDetect = MobileDetect;
})();

