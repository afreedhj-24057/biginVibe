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

// Local static server base URL (configurable via environment or hardcoded default)
const getLocalStaticServerUrl = () => {
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

module.exports = { configurePreviewStaticResourceInterceptor, getLocalStaticServerUrl };
