"use strict";

function stripHtml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForMatch(s) {
  return stripHtml(s).toLowerCase();
}

module.exports = { stripHtml, normalizeForMatch };
