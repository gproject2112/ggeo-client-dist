// GGEO app.js — main app logic, toast notifications, auto-fill coordinates.

var App = {
    toast: function(message, isError) {
        var container = document.getElementById("toast-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "toast-container";
            container.className = "toast-container";
            document.body.appendChild(container);
        }
        // Auto-translate if message is an i18n key
        if (typeof I18N !== "undefined" && I18N.translations) {
            var dict = I18N.translations[I18N.lang] || I18N.translations.en;
            if (dict && dict[message] !== undefined) {
                message = dict[message];
            }
        }
        var el = document.createElement("div");
        el.className = "toast" + (isError ? " toast-error" : "");
        el.textContent = message;
        container.appendChild(el);

        setTimeout(function() {
            el.style.animation = "toast-out 0.25s ease-in forwards";
            setTimeout(function() { el.remove(); }, 250);
        }, 3000);
    },

    formatDuration: function(seconds) {
        if (seconds == null) return "--";
        if (seconds < 60) return seconds.toFixed(1) + "s";
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        if (m < 60) return m + "m " + s + "s";
        var h = Math.floor(m / 60);
        return h + "h " + (m % 60) + "m";
    },

    _parseServerTime: function(value) {
        if (value == null) return null;
        if (typeof value === "number") return new Date(value * 1000);
        var s = String(value);
        if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
        var d = new Date(s.replace(" ", "T") + "Z");
        return isNaN(d.getTime()) ? null : d;
    },

    formatDateTime: function(value) {
        var d = App._parseServerTime(value);
        if (!d) return "--";
        try {
            return d.toLocaleString("en-GB", {
                timeZone: "Asia/Jakarta",
                year: "numeric", month: "2-digit", day: "2-digit",
                hour: "2-digit", minute: "2-digit", second: "2-digit",
                hour12: false,
            });
        } catch (e) { return d.toISOString(); }
    },

    formatTime: function(value) {
        var d = App._parseServerTime(value);
        if (!d) return "--";
        try {
            return d.toLocaleTimeString("en-GB", {
                timeZone: "Asia/Jakarta",
                hour: "2-digit", minute: "2-digit", second: "2-digit",
                hour12: false,
            });
        } catch (e) { return "--"; }
    },

    setupCoordAutofill: function(latInput, lonInput) {
        function handle(e) {
            var text = (e.clipboardData || window.clipboardData).getData("text").trim();
            text = text.replace(/[()]/g, "").trim();
            var parts = text.split(/[,\s]+/).filter(function(p) { return p.length > 0; });
            if (parts.length === 2) {
                var lat = parseFloat(parts[0]);
                var lon = parseFloat(parts[1]);
                if (!isNaN(lat) && !isNaN(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                    e.preventDefault();
                    latInput.value = parts[0];
                    lonInput.value = parts[1];
                    var msg = (typeof I18N !== "undefined" ? I18N.t("toast_coords_filled") : "Coordinates filled");
                    App.toast(msg + ": " + parts[0] + ", " + parts[1]);
                }
            }
        }
        latInput.addEventListener("paste", handle);
        lonInput.addEventListener("paste", handle);
    },

    confirm: function(message, opts) {
        opts = opts || {};
        var title = opts.title || "Konfirmasi";
        var okText = opts.okText || "OK";
        var cancelText = opts.cancelText || "Batal";
        var danger = opts.danger !== false;
        return new Promise(function(resolve) {
            var scrim = document.createElement("div");
            scrim.className = "app-confirm-scrim";
            scrim.innerHTML =
                '<div class="app-confirm-box">' +
                  '<div class="app-confirm-title"></div>' +
                  '<div class="app-confirm-msg"></div>' +
                  '<div class="app-confirm-actions">' +
                    '<button type="button" class="btn btn-outline app-confirm-cancel"></button>' +
                    '<button type="button" class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + ' app-confirm-ok"></button>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(scrim);
            scrim.querySelector(".app-confirm-title").textContent = title;
            scrim.querySelector(".app-confirm-msg").textContent = message;
            var okBtn = scrim.querySelector(".app-confirm-ok");
            var cancelBtn = scrim.querySelector(".app-confirm-cancel");
            okBtn.textContent = okText;
            cancelBtn.textContent = cancelText;
            function close(val) {
                document.body.removeChild(scrim);
                resolve(val);
            }
            okBtn.addEventListener("click", function() { close(true); });
            cancelBtn.addEventListener("click", function() { close(false); });
            scrim.addEventListener("click", function(e) {
                if (e.target === scrim) close(false);
            });
            setTimeout(function() { okBtn.focus(); }, 0);
        });
    },

    api: async function(method, path, body) {
        var opts = { method: method, headers: {} };
        if (body) {
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        var res = await fetch(path, opts);
        var json = await res.json();
        if (json.status !== "ok") {
            var err = new Error(json.message || json.error || json.detail || "Request failed");
            err.error = json.error;
            err.detail = json.detail;
            err.active_by_username = json.active_by_username;
            err.active_by_user_id = json.active_by_user_id;
            err.status_code = res.status;
            throw err;
        }
        return json.data;
    },
};

App.hostStatus = {
    _banner: null,
    _pollInterval: null,
    POLL_MS: 10000,

    start: function() {
        this.poll();
        if (!this._pollInterval) {
            this._pollInterval = setInterval(this.poll.bind(this), this.POLL_MS);
        }
    },

    poll: function() {
        fetch("/api/host-status")
            .then(function(r) { return r.json(); })
            .then(function(s) { App.hostStatus.render(s); })
            .catch(function() {
                App.hostStatus.render({ is_valid: false, reason: "fetch_failed" });
            });
    },

    render: function(s) {
        if (s.is_valid && !s.is_suspended && (s.consecutive_failures || 0) === 0) {
            this._hideBanner();
            return;
        }
        if (s.is_suspended) {
            this._showBanner("Client ditangguhkan oleh administrator", "error");
        } else if (!s.is_valid) {
            this._showBanner("Koneksi ke server terputus — GPS tidak tersedia", "error");
        } else if (s.consecutive_failures > 0) {
            this._showBanner(
                "Koneksi tidak stabil (" + s.consecutive_failures + "/5 gagal)",
                "warning"
            );
        }
    },

    _showBanner: function(msg, level) {
        if (!this._banner) {
            this._banner = document.createElement("div");
            this._banner.id = "host-status-banner";
            this._banner.style.cssText =
                "position:fixed;top:0;left:0;right:0;padding:10px 16px;" +
                "text-align:center;color:white;font-weight:500;font-size:13px;" +
                "z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,0.2);";
            document.body.appendChild(this._banner);
        }
        this._banner.style.background = level === "error" ? "#ef4444" : "#eab308";
        this._banner.textContent = msg;
    },

    _hideBanner: function() {
        if (this._banner) {
            this._banner.remove();
            this._banner = null;
        }
    }
};

(function() {
    var boot = function() {
        if (window.location.pathname !== "/login") {
            App.hostStatus.start();
        }
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
