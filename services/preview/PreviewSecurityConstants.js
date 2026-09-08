/**
 * Shared identity for the Vibe Editor's embedded preview browser's TLS
 * scoping — used by whichever preview certificate/authentication policies
 * are currently active (see PreviewClientCertificatePolicy.js).
 *
 * Kept as a single small module (rather than duplicated literals) so every
 * policy module and the <webview partition="..."> attribute in
 * PreviewPanel.js always agree on exactly which session/hosts are in scope.
 */

// Must match the `partition` attribute on the <webview> element in
// components/Preview/PreviewPanel.js exactly.
const PREVIEW_PARTITION = "persist:bigin-preview";

// The only internal Bigin LocalZoho environments any preview-scoped
// certificate/authentication exception may apply to.
const APPROVED_PREVIEW_HOSTS = new Set([
  "bigindev.localzoho.com",
  "biginqa.localzoho.com",
  "bigininteg1.localzoho.com",
  "biginauto.localzoho.com",
  "biginops1.localzoho.com",
  "bigin.localzoho.com",
]);

module.exports = { PREVIEW_PARTITION, APPROVED_PREVIEW_HOSTS };
