/**
 * Test suite for PreviewStaticResourceInterceptor regex pattern matching.
 * Run with: node services/preview/PreviewStaticResourceInterceptor.test.js
 */

const CDN_URL_PATTERN = /https:\/\/static\.localzohocdn\.com\/bigin.*?\/biginclient\/(.+?)\.([^.]+)\.(.+)$/;

// Test cases: [input, shouldMatch, expectedFilename, expectedExtension]
const testCases = [
  // Valid cases - should match and redirect
  [
    "https://static.localzohocdn.com/bigin-v1/biginclient/app.min.js.abc123",
    true,
    "app",
    "min"
  ],
  [
    "https://static.localzohocdn.com/bigin-production/biginclient/styles.main.css.def456",
    true,
    "styles",
    "main"
  ],
  [
    "https://static.localzohocdn.com/bigin-dev-2024/biginclient/bundle.umd.js.ghi789",
    true,
    "bundle",
    "umd"
  ],
  [
    "https://static.localzohocdn.com/bigin-latest-v2.1.0/biginclient/vendor.lib.js.xyz999",
    true,
    "vendor",
    "lib"
  ],
  
  // Edge cases
  [
    "https://static.localzohocdn.com/bigin/biginclient/single.js.v1",
    true,
    "single",
    "js"
  ],
  
  // Invalid cases - should not match
  [
    "https://static.localzohocdn.com/bigin/otherclient/app.js.abc123",
    false,
    null,
    null
  ],
  [
    "https://cdn.example.com/bigin/biginclient/app.js.abc123",
    false,
    null,
    null
  ],
  [
    "http://localhost:3000/app.min.js",
    false,
    null,
    null
  ],
];

console.log("Testing PreviewStaticResourceInterceptor regex pattern...\n");

let passCount = 0;
let failCount = 0;

testCases.forEach(([url, shouldMatch, expectedFilename, expectedExtension], index) => {
  const match = url.match(CDN_URL_PATTERN);
  const isMatching = match !== null;

  if (isMatching === shouldMatch) {
    if (shouldMatch) {
      const [, filename, extension] = match;
      const expectedOutput = `http://localhost:3000/${expectedFilename}.${expectedExtension}`;
      const actualOutput = `http://localhost:3000/${filename}.${extension}`;

      if (filename === expectedFilename && extension === expectedExtension) {
        console.log(`✓ Test ${index + 1} PASSED`);
        console.log(`  Input:  ${url}`);
        console.log(`  Output: ${actualOutput}\n`);
        passCount++;
      } else {
        console.log(`✗ Test ${index + 1} FAILED (extraction mismatch)`);
        console.log(`  Input:    ${url}`);
        console.log(`  Expected: ${expectedOutput}`);
        console.log(`  Got:      ${actualOutput}\n`);
        failCount++;
      }
    } else {
      console.log(`✓ Test ${index + 1} PASSED (correctly did not match)`);
      console.log(`  Input: ${url}\n`);
      passCount++;
    }
  } else {
    console.log(`✗ Test ${index + 1} FAILED (match behavior incorrect)`);
    console.log(`  Input:    ${url}`);
    console.log(`  Expected: ${shouldMatch ? "match" : "no match"}`);
    console.log(`  Got:      ${isMatching ? "match" : "no match"}\n`);
    failCount++;
  }
});

console.log(`\n========================================`);
console.log(`Tests completed: ${passCount} passed, ${failCount} failed`);
console.log(`========================================`);

process.exit(failCount > 0 ? 1 : 0);
