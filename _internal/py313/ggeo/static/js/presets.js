// GGEO presets.js — saved location presets (free users only).

var Presets = {
    list: [],

    init: function() { this.load(); },

    load: async function() {
        try {
            var data = await App.api("GET", "/api/presets");
            this.list = data;
            this.render();
        } catch (e) {
            var panel = document.getElementById("presetsBlock");
            if (panel) panel.style.display = "none";
        }
    },

    render: function() {
        var container = document.getElementById("presetsList");
        var count = document.getElementById("presetsCount");
        var panel = document.getElementById("presetsBlock");
        if (!container) return;
        if (count) count.textContent = this.list.length;
        if (panel) panel.style.display = this.list.length === 0 ? "none" : "block";
        if (this.list.length === 0) {
            container.innerHTML = "";
            return;
        }
        var html = "";
        var self = this;
        this.list.forEach(function(p) {
            var safeName = String(p.name).replace(/'/g, "\\'");
            html += '<div class="preset" onclick="Presets.use(' + p.id + ')">'
                + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2"/></svg>'
                + '<div>'
                  + '<div class="pname">' + escapePresetHtml(p.name) + '</div>'
                  + '<div class="pcoord">' + p.latitude.toFixed(5) + ', ' + p.longitude.toFixed(5) + '</div>'
                + '</div>'
                + '<button class="rescan-btn" onclick="event.stopPropagation();Presets.remove(' + p.id + ',\'' + safeName + '\')" title="Delete" style="opacity:.6">×</button>'
                + '</div>';
        });
        container.innerHTML = html;
    },

    use: function(id) {
        var p = this.list.find(function(x) { return x.id === id; });
        if (!p) return;
        var lat = document.getElementById("latInput");
        var lon = document.getElementById("lonInput");
        if (lat) lat.value = p.latitude;
        if (lon) lon.value = p.longitude;
        if (typeof GMap !== "undefined" && GMap.setPin) {
            GMap.setPin(p.latitude, p.longitude);
            GMap.flyTo(p.latitude, p.longitude);
        }
        if (typeof updateAssignFromInputs === "function") updateAssignFromInputs();
        App.toast((typeof I18N !== "undefined" ? I18N.t("toast_loaded") : "Loaded") + ": " + p.name);
    },

    save: async function() {
        var lat = parseFloat(document.getElementById("latInput").value);
        var lon = parseFloat(document.getElementById("lonInput").value);
        if (isNaN(lat) || isNaN(lon)) {
            App.toast("Invalid coordinates", true);
            return;
        }
        var name = prompt("Preset name:");
        if (!name || !name.trim()) return;
        try {
            await App.api("POST", "/api/presets", {name: name.trim(), lat: lat, lon: lon});
            App.toast("Preset saved: " + name.trim());
            await this.load();
            if (typeof History !== "undefined") History.load();
        } catch (e) { App.toast(e.message, true); }
    },

    remove: async function(id, name) {
        var ok = await App.confirm("Delete preset '" + name + "'?",
            {title: "Delete preset", okText: "Delete"});
        if (!ok) return;
        try {
            await App.api("DELETE", "/api/presets/" + id);
            App.toast("Deleted");
            await this.load();
            if (typeof History !== "undefined") History.load();
        } catch (e) { App.toast(e.message, true); }
    },
};

function escapePresetHtml(str) {
    return String(str || "").replace(/&/g, "&amp;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
