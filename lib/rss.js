"use strict";

const { stripHtml } = require("./text");

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return stripHtml(m[1]);
}

/**
 * Minimal RSS/Atom-ish item parser (no XML dependency).
 */
function parseRssItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, "title");
    if (!title) continue;
    items.push({
      title,
      description: extractTag(block, "description"),
      link: extractTag(block, "link"),
      pubDate: extractTag(block, "pubDate"),
    });
  }
  return items;
}

module.exports = { parseRssItems };
