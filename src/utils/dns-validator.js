const dns = require('dns').promises;

/**
 * Check if a hostname is resolvable
 */
async function isHostnameResolvable(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Generate common hostname variations to check
 * e.g., "staging-api.domain.com" -> ["api-staging.domain.com", "staging.api.domain.com"]
 */
function generateHostnameVariations(hostname) {
  const parts = hostname.split('.');
  if (parts.length < 3) return [];
  
  const subdomain = parts[0];
  const domain = parts.slice(1).join('.');
  
  const variations = [];
  
  // Check for hyphenated subdomains
  if (subdomain.includes('-')) {
    const subParts = subdomain.split('-');
    // Reverse order: "staging-api" -> "api-staging"
    const reversed = [...subParts].reverse();
    variations.push(`${reversed.join('-')}.${domain}`);
    // Dot notation: "staging-api" -> "staging.api"
    variations.push(`${subParts.join('.')}.${domain}`);
  }
  
  return variations;
}

/**
 * Find a resolvable alternative hostname
 */
async function findResolvableAlternative(hostname) {
  const variations = generateHostnameVariations(hostname);
  
  for (const variation of variations) {
    if (await isHostnameResolvable(variation)) {
      return variation;
    }
  }
  
  return null;
}

module.exports = {
  isHostnameResolvable,
  generateHostnameVariations,
  findResolvableAlternative
};


