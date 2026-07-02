// GGEO history.js — user's location apply history with pagination.

var History = {
    _page: 1,
    _limit: 5,

    init: function() {
        this._page = 1;
        this.load();
    },

    _t: function(key, fallback) {
        if (typeof I18N !== "undefined") return I18N.t(key);
        return fallback || key;
    },

    load: async function() {
        try {
            var url = "/api/history?page=" + this._page + "&limit=" + this._limit;
            var res = await fetch(url, { credentials: "include" });
            var payload = await res.json();
            if (!payload || payload.status !== "ok") {
                throw new Error(payload && payload.message ? payload.message : "fetch failed");
            }
            this.render(payload.data || [], payload.total || 0);
        } catch (e) {
            var panel = document.getElementById("history-panel");
            if (panel) panel.style.display = "none";
        }
    },

    render: function(data, total) {
        var container = document.getElementById("history-list");
        var pager = document.getElementById("history-pager");
        if (!container) return;

        if (data.length === 0 && this._page === 1) {
            container.innerHTML =
                '<div class="empty-state" style="padding:10px;font-size:12px">' +
                this._t("empty_history", "No history yet") + '</div>';
            if (pager) { pager.hidden = true; pager.innerHTML = ""; }
            return;
        }

        if (data.length === 0 && this._page > 1) {
            this._page = Math.max(1, this._page - 1);
            return this.load();
        }

        var trashSvg = '<svg viewBox="0 0 24 24">' +
            '<polyline points="3 6 5 6 21 6"/>' +
            '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
            '<path d="M10 11v6M14 11v6"/>' +
            '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>' +
            '</svg>';
        var useLabel = History._t("use", "Use");
        var deleteLabel = History._t("delete", "Delete");

        var html = "";
        data.forEach(function(h) {
            var ts = "--";
            ts = App.formatDateTime(h.applied_at);
            var hasName = h.location_name && h.location_name.length > 0;
            var primary = hasName
                ? '<div class="history-name">' + History._escape(h.location_name) + '</div>' +
                  '<div class="history-coords">' + h.latitude.toFixed(6) + ", " + h.longitude.toFixed(6) + '</div>'
                : '<div class="history-coords history-coords-primary">' +
                    h.latitude.toFixed(6) + ", " + h.longitude.toFixed(6) + '</div>';
            html += '<div class="history-item">' +
                '<div class="history-info">' +
                  primary +
                  '<div class="history-time">' + History._escape(ts) + '</div>' +
                '</div>' +
                '<div class="history-actions">' +
                  '<button class="btn btn-ghost btn-sm" onclick="History.reuse(' +
                    h.latitude + ',' + h.longitude + ')">' + useLabel + '</button>' +
                  '<button class="history-delete" onclick="History.del(' + h.id +
                    ')" title="' + deleteLabel + '" aria-label="' + deleteLabel + '">' +
                    trashSvg + '</button>' +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;

        History._renderPager(pager, total);
    },

    _renderPager: function(pager, total) {
        if (!pager) return;
        var pages = Math.max(1, Math.ceil(total / this._limit));
        if (pages <= 1) {
            pager.hidden = true;
            pager.innerHTML = "";
            return;
        }
        pager.hidden = false;

        var p = this._page;
        var parts = [];
        parts.push(
            '<button class="history-pager-btn" ' +
            (p === 1 ? "disabled" : "") +
            ' onclick="History.goTo(' + (p - 1) + ')" aria-label="Previous">&lsaquo;</button>'
        );
        var nums = History._pageNumbers(p, pages);
        nums.forEach(function(n) {
            if (n === "…") {
                parts.push('<span class="history-pager-ellipsis">…</span>');
            } else {
                parts.push(
                    '<button class="history-pager-btn' +
                    (n === p ? " active" : "") + '"' +
                    ' onclick="History.goTo(' + n + ')">' + n + '</button>'
                );
            }
        });
        parts.push(
            '<button class="history-pager-btn" ' +
            (p === pages ? "disabled" : "") +
            ' onclick="History.goTo(' + (p + 1) + ')" aria-label="Next">&rsaquo;</button>'
        );
        pager.innerHTML = parts.join("");
    },

    _pageNumbers: function(cur, total) {
        if (total <= 7) {
            var arr = [];
            for (var i = 1; i <= total; i++) arr.push(i);
            return arr;
        }
        var res = [1];
        var start = Math.max(2, cur - 1);
        var end = Math.min(total - 1, cur + 1);
        if (start > 2) res.push("…");
        for (var j = start; j <= end; j++) res.push(j);
        if (end < total - 1) res.push("…");
        res.push(total);
        return res;
    },

    goTo: function(page) {
        if (page < 1) return;
        this._page = page;
        this.load();
    },

    del: async function(entryId) {
        if (!entryId) return;
        try {
            await App.api("DELETE", "/api/history/" + entryId);
            App.toast(this._t("history_deleted", "Entry deleted"));
            this.load();
        } catch (e) {
            App.toast(
                this._t("err_delete", "Delete failed") + ": " + e.message,
                true
            );
        }
    },

    reuse: function(lat, lon) {
        document.getElementById("lat-input").value = lat;
        document.getElementById("lon-input").value = lon;
        if (typeof GMap !== "undefined" && GMap.setPin) {
            GMap.setPin(lat, lon);
            GMap.flyTo(lat, lon);
        }
        App.toast(this._t("coords_loaded", "Coordinates loaded"));
    },

    _escape: function(s) {
        if (s == null) return "";
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    },
};
