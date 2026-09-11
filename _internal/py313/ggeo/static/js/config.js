// GGEO config.js — shared frontend constants (loaded before all other app scripts).

// CARTO basemap API key. Appended to every basemaps.cartocdn.com tile URL.
// Frontend keys are visible in the browser by nature — keep this a
// public/tiles-only key, never a secret with account privileges.
var GGEO_CARTO_API_KEY = "cb1_3hks_1_c3928bc6ebf7e83d270afd3b";

function ggeoCartoTiles(style) {
    return "https://{s}.basemaps.cartocdn.com/" + (style || "dark_all")
        + "/{z}/{x}/{y}{r}.png?api_key=" + GGEO_CARTO_API_KEY;
}
