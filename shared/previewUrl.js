const DOMAIN_WITHOUT_PROTOCOL = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i;
const IPV4_WITHOUT_PROTOCOL = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/;
const LOCALHOST_WITHOUT_PROTOCOL = /^localhost(?::\d+)?(?:[/?#]|$)/i;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Converts browser address-bar input into an absolute URL without changing
 * explicit schemes or relative paths used by the local preview app.
 */
function normalizePreviewUrl(input) {
  if (typeof input !== "string") return "";
  const value = input.trim();
  if (!value) return "";

  if (value.startsWith("//")) return `https:${value}`;
  if (LOCALHOST_WITHOUT_PROTOCOL.test(value) || IPV4_WITHOUT_PROTOCOL.test(value)) {
    return `http://${value}`;
  }
  if (URL_SCHEME.test(value)) return value;
  if (DOMAIN_WITHOUT_PROTOCOL.test(value)) return `https://${value}`;

  return value;
}

module.exports = { normalizePreviewUrl };
