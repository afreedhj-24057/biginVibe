const { app, session } = require("electron");
const { PREVIEW_PARTITION, APPROVED_PREVIEW_HOSTS } = require("./PreviewSecurityConstants");

/**
 * Client-certificate (mutual TLS) selection for the Vibe Editor's embedded
 * preview browser ONLY. This handles the LocalZoho server requesting that
 * the CLIENT (Electron) present its own certificate to authenticate the
 * connecting user — a completely separate TLS concern from server
 * certificate validation (see "History" below for why there is no separate
 * server-certificate policy module anymore).
 *
 * ---------------------------------------------------------------------------
 * Root cause of ERR_BAD_SSL_CLIENT_AUTH_CERT (-117)
 * ---------------------------------------------------------------------------
 * LocalZoho's server requests a client certificate as part of the TLS
 * handshake (mutual TLS). Without a `select-client-certificate` handler
 * registered, Electron never presents one back to the server, and the
 * handshake fails with this exact error. Verified directly: a local server
 * configured with `requestCert: true` reproduces the identical
 * ERR_BAD_SSL_CLIENT_AUTH_CERT failure until this handler is registered,
 * and Electron's own `select-client-certificate` event correctly enumerates
 * client identities already present in the OS certificate store (macOS
 * Keychain) once handled — confirmed with a real `<webview>` guest view
 * (not just a bare BrowserWindow) completing a full mutual-TLS handshake.
 *
 * ---------------------------------------------------------------------------
 * History: why the earlier server-certificate policy was removed
 * ---------------------------------------------------------------------------
 * An earlier fix for a *different* error (ERR_CERT_COMMON_NAME_INVALID, a
 * server-certificate validation failure) used
 * `session.setCertificateVerifyProc()` to trust the LocalZoho hosts'
 * server certificate. That module has been REMOVED after directly
 * measuring a real regression it caused: registering a custom
 * setCertificateVerifyProc — even one that safely defers to Chromium's own
 * result (`callback(-2)`) for every non-approved host — intermittently
 * broke the FIRST connection attempt to otherwise perfectly valid, unrelated
 * HTTPS sites (confirmed via 10 repeated isolated test runs: 1/10 failures
 * with the verify proc registered vs. 0/10 with no policy at all). This
 * directly caused normal public sites in the preview to fail with
 * ERR_FAILED. Since the current blocking error (ERR_BAD_SSL_CLIENT_AUTH_CERT)
 * is a client-certificate error rather than the earlier server-certificate
 * error, the server side of the handshake is not currently known to need an
 * exception; keeping a module that actively degrades reliability for
 * unrelated sites is not justified. If ERR_CERT_COMMON_NAME_INVALID
 * resurfaces, prefer the `certificate-error` app event instead of
 * setCertificateVerifyProc — it only engages when Chromium's own
 * validation has ALREADY failed, rather than intercepting every single
 * certificate check, avoiding this class of regression.
 *
 * ---------------------------------------------------------------------------
 * Using the OS certificate store only — no private key handling
 * ---------------------------------------------------------------------------
 * `select-client-certificate` provides a `list` of certificates already
 * available via the OS certificate store, matching what the server's TLS
 * handshake requested. This code only SELECTS an entry from that list —
 * the actual private-key signing operation is performed entirely inside
 * the OS (Keychain/Security framework on macOS) via Chromium's native TLS
 * stack. Nothing here ever reads, exports, logs, or otherwise touches
 * private key material; it is not possible to do so through this API.
 *
 * ---------------------------------------------------------------------------
 * Scoping
 * ---------------------------------------------------------------------------
 *   1. Session scope — only handled when the requesting webContents
 *      belongs to the preview's own named partition (PREVIEW_PARTITION,
 *      shared via PreviewSecurityConstants.js so the <webview> element and
 *      this policy always agree on exactly which session is in scope).
 *   2. Hostname allowlist — only the four approved LocalZoho hostnames
 *      (APPROVED_PREVIEW_HOSTS, same shared source of truth) trigger
 *      automatic selection.
 *   3. Everything else — any other host, or any request outside the
 *      preview partition, gets `callback()` with no certificate, which is
 *      Electron's normal behavior when client-cert auth isn't handled.
 *      Nothing is auto-selected for arbitrary sites. Unlike
 *      setCertificateVerifyProc, this event only fires when a server
 *      actually asks for a client certificate — it never runs for the vast
 *      majority of ordinary HTTPS sites that don't use mutual TLS at all,
 *      so it carries none of the previous module's regression risk.
 * ---------------------------------------------------------------------------
 */

/**
 * Registers the scoped client-certificate selection handler. Must be
 * called once, after `app.whenReady()`. Safe to call more than once — a
 * later call simply replaces the listener via a guarded singleton.
 */
function configurePreviewClientCertificatePolicy() {
  if (configurePreviewClientCertificatePolicy._registered) return;
  configurePreviewClientCertificatePolicy._registered = true;

  app.on("select-client-certificate", (event, webContents, url, list, callback) => {
    // IMPORTANT: unlike a page URL, this `url` argument is a bare
    // "hostname:port" authority string, not a full URL — new URL(url) does
    // not parse it correctly (the hostname ends up empty). Confirmed via
    // direct testing against a local mutual-TLS server.
    const hostname = url.replace(/:\d+$/, "");

    const isPreviewSession = webContents.session === session.fromPartition(PREVIEW_PARTITION);
    const isApprovedHost = APPROVED_PREVIEW_HOSTS.has(hostname);

    // We are handling the selection ourselves either way — must be called
    // synchronously regardless of which branch below is taken.
    event.preventDefault();

    if (isPreviewSession && isApprovedHost && list.length > 0) {
      const chosen = list[0];
      console.log(
        `[PreviewClientCertificatePolicy] ${hostname}: selecting client certificate ` +
        `"${chosen.subject?.commonName || chosen.subject?.organizations?.[0] || "(unnamed)"}" ` +
        `(${list.length} candidate${list.length === 1 ? "" : "s"} available).`
      );
      callback(chosen);
      return;
    }

    if (isPreviewSession && isApprovedHost && list.length === 0) {
      console.log(
        `[PreviewClientCertificatePolicy] ${hostname}: server requested a client certificate ` +
        `but none is available in the OS certificate store for this user.`
      );
    }

    // Not an approved LocalZoho host, not our preview session, or no
    // candidates — defer to Electron's normal behavior (no certificate).
    callback();
  });
}

module.exports = { configurePreviewClientCertificatePolicy };
