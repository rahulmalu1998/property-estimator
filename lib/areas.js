"use strict";

function areaKey(area) {
  const citySlug =
    area.citySlug ||
    area.city ||
    area.slug ||
    "city";
  return citySlug + "::" + area.name;
}

module.exports = { areaKey };
