/**
 * Intercepts and redirects static resource requests in the preview panel.
 *
 * This module uses Electron's session.webRequest API to intercept HTTP/HTTPS
 * requests matching the CDN URL pattern and redirect them to a local static
 * server (typically localhost:3000).
 *
 * Pattern: https://static.localzohocdn.com/bigin.*?/biginclient/(.+)\.(.*)\.(.+)
 * Replacement: http://localhost:3000/$1.$2
 *
 * Example:
 *   Input:  https://static.localzohocdn.com/bigin-v1/biginclient/app.min.js.abc123
 *   Output: http://localhost:3000/app.min.js
 */

const { session } = require("electron");
const { PREVIEW_PARTITION } = require("./PreviewSecurityConstants");

// CDN source URL pattern matching
// Matches: https://static.localzohocdn.com/bigin.*?/biginclient/{filename}.{cacheBuster}
const CDN_URL_PATTERN = /https:\/\/static\.localzohocdn\.com\/bigin.*?\/biginclient\/(.+?)\.([^.]+)\.(.+)$/;

// ---------------------------------------------------------------------------
// Dynamic local static server target
// ---------------------------------------------------------------------------
// The user browses a real Bigin development instance (bigindev, biginqa,
// bigininteg1, biginauto, biginops1, etc.) inside the preview <webview>, NOT
// a fixed localhost URL. That remote page's HTML references its JS/CSS
// bundles from the CDN (static.localzohocdn.com/bigin*/biginclient/...).
// This interceptor rewrites those CDN requests to instead be served by the
// LOCAL dev server that EnvironmentManager just started for the open
// project — so edits show up live against a real Bigin environment.
//
// EnvironmentManager picks whatever port is actually free/listening (see
// EnvironmentManager._findAvailablePort, which tries 3000, 3001, 3002, ...
// sequentially) — it is NOT always 3000. electron/main.js updates the
// target port here via setLocalStaticServerPort() every time it observes an
// "environment.started" runtime event (EVENTS.ENVIRONMENT_STARTED carries
// the resolved `port`), so this always reflects whichever port the dev
// server for the CURRENTLY open project is actually running on.
// ---------------------------------------------------------------------------
let localStaticServerPort = null;

/**
 * Called by electron/main.js whenever EnvironmentManager reports a
 * successfully started dev server, with the port it actually detected
 * (ENVIRONMENT_STARTED payload's `port` field). Pass `null` on
 * "environment.stopped" so no requests are redirected while no dev server
 * is running for the active project.
 *
 * @param {number|null} port
 */
function setLocalStaticServerPort(port) {
  localStaticServerPort = port || null;
}

// Local static server base URL. Prefers the live port reported by
// EnvironmentManager (see setLocalStaticServerPort above); falls back to
// LOCAL_STATIC_SERVER_URL/localhost:3000 only if no dev server has reported
// in yet (e.g. very first request racing app startup).
const getLocalStaticServerUrl = () => {
  if (localStaticServerPort) {
    return `http://localhost:${localStaticServerPort}`;
  }
  return process.env.LOCAL_STATIC_SERVER_URL || "http://localhost:3000";
};

/**
 * Configure the static resource interceptor for the preview partition.
 * Must be called after the preview session is ready.
 */
function configurePreviewStaticResourceInterceptor() {
  const previewSession = session.fromPartition(PREVIEW_PARTITION);

  // Clear any existing interceptors to avoid duplicates
  previewSession.webRequest.onBeforeRequest(null);

  // Register the request interceptor
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details;

    // Check if the URL matches our CDN pattern
    const match = url.match(CDN_URL_PATTERN);

    if (match) {
      const [, filename, cacheBuster, extension] = match;
      const localUrl = `${getLocalStaticServerUrl()}/${filename}.${extension}`;

      console.log(
        `[PreviewStaticResourceInterceptor] Redirecting CDN request:\n` +
          `  From: ${url}\n` +
          `  To:   ${localUrl}`
      );

      // Redirect to local static server
      callback({ redirectURL: localUrl });
    } else {
      // Allow the request to proceed unchanged
      callback({});
    }
  });
}

module.exports = {
  configurePreviewStaticResourceInterceptor,
  getLocalStaticServerUrl,
  setLocalStaticServerPort,
};
