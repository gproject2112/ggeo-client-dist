// GGEO map.js — Leaflet, layer switch, search, target pin, cursor coords.

var GMap = {
    map: null,
    marker: null,
    homeMarker: null,
    deviceMarkers: {},
    selectedLat: null,
    selectedLon: null,
    _onSelectCallbacks: [],
    _layers: {dark: null, sat: null},
    _currentLayer: "dark",

    init: function(containerId) {
        var self = this;
        var el = document.getElementById(containerId);
        if (!el || typeof L === "undefined") return;

        self.map = L.map(el, {
            zoomControl: false,
            attributionControl: true,
        }).setView([-6.2088, 106.8456], 5);

        self._layers.dark = L.tileLayer(
            "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            {
                maxZoom: 20,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            }
        );
        self._layers.sat = L.tileLayer(
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            {
                maxZoom: 19,
                attribution: "Tiles &copy; Esri",
            }
        );
        self._layers.dark.addTo(self.map);

        self.map.on("click", function(e) {
            var lat = e.latlng.lat;
            var lon = e.latlng.lng;
            self.setPin(lat, lon);
            self._fireSelect(lat, lon);
        });

        self.map.on("mousemove", function(e) {
            var cur = document.getElementById("cursorCoord");
            if (cur) {
                cur.textContent = e.latlng.lat.toFixed(4)
                    + ", " + e.latlng.lng.toFixed(4);
            }
        });

        self.map.on("zoomend", function() {
            var zEl = document.getElementById("hudZoom");
            if (zEl) zEl.textContent = "ZOOM " + self.map.getZoom().toFixed(1);
        });

        self._tryGeolocation();
    },

    _tryGeolocation: function() {
        var self = this;
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            function(pos) {
                var lat = pos.coords.latitude;
                var lon = pos.coords.longitude;
                if (self.map && (self.map.getZoom() <= 6)) {
                    self.map.setView([lat, lon], 13);
                }
                if (!self.homeMarker) {
                    var icon = L.divIcon({
                        className: "home-pin-wrap",
                        html: '<div class="home-pin"></div>',
                        iconSize: [18, 18],
                        iconAnchor: [9, 9],
                    });
                    self.homeMarker = L.marker([lat, lon], {
                        icon: icon, interactive: false, zIndexOffset: -100,
                    }).addTo(self.map);
                }
            },
            function() { /* permission denied or timeout — keep default Jakarta center */ },
            { timeout: 8000, maximumAge: 600000, enableHighAccuracy: false }
        );
    },

    setLayer: function(name) {
        if (!this.map || !this._layers[name]) return;
        if (this._currentLayer === name) return;
        this.map.removeLayer(this._layers[this._currentLayer]);
        this._layers[name].addTo(this.map);
        this._currentLayer = name;
    },

    setPin: function(lat, lon) {
        if (!this.map) return;
        this.selectedLat = lat;
        this.selectedLon = lon;
    },

    setPinActive: function() {},
    setPinInactive: function() {},

    setDeviceMarker: function(udid, lat, lon, opts) {
        if (!this.map || !udid) return;
        if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return;
        opts = opts || {};
        var state = opts.state || "idle";
        var name = opts.name || "";
        var selected = !!opts.selected;
        var existing = this.deviceMarkers[udid];
        if (existing) {
            existing.setLatLng([lat, lon]);
            var iconEl = existing.getElement();
            if (iconEl) {
                iconEl.className = "ggeo-pin " + state + (selected ? " selected" : "");
                var lbl = iconEl.querySelector(".label");
                if (lbl) lbl.textContent = name;
            }
            return;
        }
        var pinIcon = L.divIcon({
            className: "ggeo-pin " + state + (selected ? " selected" : ""),
            html: '<span class="pulse p1"></span><span class="pulse p2"></span>'
                + '<span class="core"></span>'
                + (name ? '<span class="label">' + name + '</span>' : ''),
            iconSize: [18, 18],
            iconAnchor: [9, 9],
        });
        this.deviceMarkers[udid] = L.marker([lat, lon], {
            icon: pinIcon, interactive: false,
        }).addTo(this.map);
    },

    removeDeviceMarker: function(udid) {
        if (this.deviceMarkers[udid]) {
            this.map.removeLayer(this.deviceMarkers[udid]);
            delete this.deviceMarkers[udid];
        }
    },

    syncDeviceMarkers: function(activeUdids) {
        var keep = {};
        (activeUdids || []).forEach(function(u){ keep[u] = true; });
        var self = this;
        Object.keys(this.deviceMarkers).forEach(function(udid) {
            if (!keep[udid]) self.removeDeviceMarker(udid);
        });
    },

    flyTo: function(lat, lon, zoom) {
        if (!this.map) return;
        this.map.flyTo([lat, lon], zoom || 18, {duration: 1.2});
    },

    onSelect: function(fn) {
        this._onSelectCallbacks.push(fn);
    },

    _fireSelect: function(lat, lon, name) {
        this._onSelectCallbacks.forEach(function(fn) { fn(lat, lon, name || null); });
    },

    zoomIn: function() { if (this.map) this.map.zoomIn(); },
    zoomOut: function() { if (this.map) this.map.zoomOut(); },
    recenter: function() {
        if (!this.map) return;
        if (this.selectedLat != null && this.selectedLon != null) {
            this.map.flyTo([this.selectedLat, this.selectedLon], 18, {duration: 0.8});
        }
    },

    search: async function(query) {
        if (!query || query.length < 2) return [];
        try {
            var url = "https://nominatim.openstreetmap.org/search?q="
                + encodeURIComponent(query) + "&format=json&limit=5";
            var res = await fetch(url, {headers: {"Accept-Language": "en"}});
            var results = await res.json();
            return results.map(function(r) {
                return {
                    name: r.display_name,
                    lat: parseFloat(r.lat),
                    lon: parseFloat(r.lon),
                };
            });
        } catch (e) { return []; }
    },

    initSearch: function(inputId, resultsId) {
        var self = this;
        var input = document.getElementById(inputId);
        var results = document.getElementById(resultsId);
        if (!input || !results) return;
        var debounce = null;
        input.addEventListener("input", function() {
            clearTimeout(debounce);
            debounce = setTimeout(async function() {
                var q = input.value.trim();
                if (q.length < 2) {
                    results.classList.remove("show");
                    return;
                }
                var coordMatch = q.match(/^\s*(-?\d+\.?\d*)\s*[, ]\s*(-?\d+\.?\d*)\s*$/);
                if (coordMatch) {
                    var lat = parseFloat(coordMatch[1]);
                    var lon = parseFloat(coordMatch[2]);
                    if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                        results.innerHTML = '<div class="sr-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12z"/></svg><span class="sr-name">' + lat.toFixed(6) + ', ' + lon.toFixed(6) + '<div class="sr-sub">Coordinates</div></span></div>';
                        results.classList.add("show");
                        results.firstChild.addEventListener("click", function() {
                            self.setPin(lat, lon);
                            self.flyTo(lat, lon);
                            self._fireSelect(lat, lon);
                            results.classList.remove("show");
                            input.value = "";
                        });
                        return;
                    }
                }
                var items = await self.search(q);
                if (items.length === 0) {
                    results.innerHTML = '<div class="sr-empty">No matches</div>';
                    results.classList.add("show");
                    return;
                }
                results.innerHTML = "";
                items.forEach(function(item) {
                    var shortName = item.name.split(",")[0];
                    var div = document.createElement("div");
                    div.className = "sr-item";
                    div.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12z"/></svg><span class="sr-name">' + shortName + '<div class="sr-sub">' + item.name + '</div></span><span class="sr-coord">' + item.lat.toFixed(4) + ', ' + item.lon.toFixed(4) + '</span>';
                    div.addEventListener("click", function() {
                        self.setPin(item.lat, item.lon);
                        self.flyTo(item.lat, item.lon);
                        self._fireSelect(item.lat, item.lon, shortName);
                        results.classList.remove("show");
                        input.value = "";
                    });
                    results.appendChild(div);
                });
                results.classList.add("show");
            }, 400);
        });
        document.addEventListener("click", function(e) {
            if (!input.contains(e.target) && !results.contains(e.target)) {
                results.classList.remove("show");
            }
        });
    },
};
