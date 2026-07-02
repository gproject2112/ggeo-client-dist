// GGEO Admin Panel — SPA

var Admin = {
    currentTab: "dashboard",
    users: [],
    devices: [],
    locations: [],
    dashboardInterval: null,

    _t: function(key, fallback) {
        if (typeof I18N !== "undefined") return I18N.t(key, fallback);
        return fallback || key;
    },

    _escape: function(s) {
        if (s == null) return "";
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    },

    init: async function() {
        try {
            var user = await App.api("GET", "/api/auth/me");
            if (user.role !== "client_admin" && user.role !== "admin") {
                window.location.href = "/";
                return;
            }
            Admin._currentUserId = user.user_id || user.id;
            Admin.currentUser = user;
            window.currentUser = user;
            var ai = document.getElementById("avatarInitial");
            if (ai) ai.textContent = (user.username || "?").charAt(0).toUpperCase();
            var nm = document.getElementById("avatarMenuName");
            if (nm) nm.textContent = user.username;
            var rl = document.getElementById("avatarMenuRole");
            if (rl) rl.textContent = user.role;
            var lg = document.getElementById("avatarMenuLogin");
            if (lg && typeof formatLoginAt === "function") {
                lg.textContent = formatLoginAt(user.login_at);
            }
        } catch (e) {
            window.location.href = "/login";
            return;
        }
        try {
            var ci = await fetch("/api/auth/client-info", {credentials: "same-origin"});
            if (ci.ok) {
                var cj = await ci.json();
                var nodeEl = document.getElementById("nodeName");
                if (nodeEl && cj && cj.client_name) {
                    nodeEl.textContent = cj.client_name.toUpperCase();
                }
            }
        } catch (_) {}

        Admin.Health.start();
        Admin.Limits.refresh().then(function(){
            if (Admin.users && Admin.users.length) Admin.Limits.update("users", Admin.users.length);
            if (Admin.devices && Admin.devices.length) Admin.Limits.update("devices", Admin.devices.length);
            if (Admin.locations && Admin.locations.length) Admin.Limits.update("locations", Admin.locations.length);
        });
        this.switchTab("users");
    },

    switchTab: function(tabName) {
        this.currentTab = tabName;
        document.querySelectorAll(".rail-item").forEach(function(btn) {
            btn.classList.toggle("active", btn.dataset.tab === tabName);
        });
        document.querySelectorAll(".mobile-admin-nav button").forEach(function(btn) {
            btn.classList.toggle("active", btn.dataset.mobTab === tabName);
        });
        document.querySelectorAll(".tab-panel").forEach(function(s) {
            s.classList.toggle("active", s.dataset.panel === tabName);
        });

        if (Admin.Sessions && Admin.Sessions.pollInterval && tabName !== "activity") {
            clearInterval(Admin.Sessions.pollInterval);
            Admin.Sessions.pollInterval = null;
        }

        if (tabName === "users") Admin.Users.load();
        else if (tabName === "devices") Admin.Devices.load();
        else if (tabName === "locations") Admin.Locations.load();
        else if (tabName === "activity") {
            Admin.History.switchSub("active");
            Admin.History.populateFilters();
            Admin.Sessions.load();
            Admin.Sessions.startPolling();
        }
    },

    PER_PAGE: 10,

    _paginate: function(arr, page) {
        var per = Admin.PER_PAGE;
        var total = arr.length;
        var pages = Math.max(1, Math.ceil(total / per));
        var p = Math.min(Math.max(1, page), pages);
        var start = (p - 1) * per;
        return { items: arr.slice(start, start + per), page: p, pages: pages, total: total };
    },

    _renderPager: function(containerId, currentPage, totalPages, onClickFn) {
        var el = document.getElementById(containerId);
        if (!el) return;
        if (totalPages <= 1) { el.hidden = true; el.innerHTML = ""; return; }
        el.hidden = false;
        var p = currentPage;
        var parts = [];
        parts.push('<button class="history-pager-btn" ' + (p <= 1 ? "disabled" : "")
            + ' onclick="(' + onClickFn + ')(' + (p - 1) + ')">‹</button>');
        var nums = [];
        if (totalPages <= 7) {
            for (var i = 1; i <= totalPages; i++) nums.push(i);
        } else {
            nums.push(1);
            if (p > 3) nums.push("…");
            for (var j = Math.max(2, p - 1); j <= Math.min(totalPages - 1, p + 1); j++) nums.push(j);
            if (p < totalPages - 2) nums.push("…");
            nums.push(totalPages);
        }
        nums.forEach(function(n) {
            if (n === "…") {
                parts.push('<span class="history-pager-ellipsis">…</span>');
            } else {
                parts.push('<button class="history-pager-btn' + (n === p ? " active" : "")
                    + '" onclick="(' + onClickFn + ')(' + n + ')">' + n + '</button>');
            }
        });
        parts.push('<button class="history-pager-btn" ' + (p >= totalPages ? "disabled" : "")
            + ' onclick="(' + onClickFn + ')(' + (p + 1) + ')">›</button>');
        el.innerHTML = parts.join("");
    },

    toggleFilterCollapse: function(panelId, btn) {
        var el = document.getElementById(panelId);
        if (!el) return;
        var open = el.hidden;
        el.hidden = !open;
        if (btn) btn.classList.toggle("is-open", open);
    },

    updateFilterCount: function(toggleId, countId, filterIds) {
        var btn = document.getElementById(toggleId);
        var badge = document.getElementById(countId);
        if (!btn || !badge) return;
        var count = 0;
        (filterIds || []).forEach(function(id) {
            var f = document.getElementById(id);
            if (f && f.value) count++;
        });
        badge.textContent = count;
        badge.hidden = count === 0;
        btn.classList.toggle("has-active", count > 0);
    },

    _renderTableSkeleton: function(selector, cols, rows) {
        var tbody = document.querySelector(selector);
        if (!tbody) return;
        var html = "";
        var n = rows || 4;
        for (var i = 0; i < n; i++) {
            html += '<tr class="skeleton-row">';
            for (var c = 0; c < cols; c++) {
                html += '<td><span class="skeleton-bar"></span></td>';
            }
            html += '</tr>';
        }
        tbody.innerHTML = html;
    },

    _showProcessingToast: function(message) {
        if (typeof App === "undefined" || !App.toast) return null;
        var container = document.getElementById("toast-container");
        if (!container) {
            container = document.createElement("div");
            container.id = "toast-container";
            container.className = "toast-container";
            document.body.appendChild(container);
        }
        var el = document.createElement("div");
        el.className = "toast toast-processing";
        el.innerHTML = '<span class="btn-spinner" style="margin-right:6px;vertical-align:-2px"></span>'
            + Admin._escape(message);
        container.appendChild(el);
        return el;
    },

    _dismissProcessingToast: function(el) {
        if (!el) return;
        try {
            el.style.animation = "toast-out 0.2s ease-in forwards";
            setTimeout(function(){ if (el.parentNode) el.remove(); }, 220);
        } catch (e) { try { el.remove(); } catch (_) {} }
    },

    _showLoadingModal: function(title) {
        var T = Admin._t;
        var label = T("loading", "Loading…");
        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon"><span class="btn-spinner" style="width:16px;height:16px;border-width:2px;margin:0;vertical-align:0"></span></div>'
                + '<div><h3>' + (title || "") + '</h3><div class="sub">' + label + '</div></div>'
            + '</div>'
            + '<div class="modal-body" style="display:flex;flex-direction:column;gap:14px;padding:32px 26px">'
                + '<div class="skeleton-bar" style="height:14px;width:90%"></div>'
                + '<div class="skeleton-bar" style="height:14px;width:70%"></div>'
                + '<div class="skeleton-bar" style="height:14px;width:80%"></div>'
                + '<div class="skeleton-bar" style="height:14px;width:60%"></div>'
            + '</div>'
        );
    },

    _setSavingButton: function(btn, isSaving) {
        if (!btn) return;
        if (isSaving) {
            btn.dataset._origText = btn.innerHTML;
            btn.disabled = true;
            btn.classList.add("is-saving");
            var T = Admin._t;
            btn.innerHTML = '<span class="btn-spinner"></span> ' + T("saving", "Saving…");
        } else {
            if (btn.dataset._origText) btn.innerHTML = btn.dataset._origText;
            btn.disabled = false;
            btn.classList.remove("is-saving");
        }
    },

    showModal: function(html) {
        var content = document.getElementById("modal-content");
        var overlay = document.getElementById("modal-overlay");
        content.innerHTML = html;
        overlay.classList.add("open");
        overlay.style.display = "flex";
        if (!Admin._modalKeyHandler) {
            Admin._modalKeyHandler = function(e) {
                if (e.key === "Escape") Admin.hideModal();
            };
            document.addEventListener("keydown", Admin._modalKeyHandler);
        }
        if (!Admin._modalBackdropHandler) {
            Admin._modalBackdropHandler = function(e) {
                if (e.target === overlay) Admin.hideModal();
            };
            overlay.addEventListener("click", Admin._modalBackdropHandler);
        }
        setTimeout(function(){
            var first = content.querySelector("input:not([type=hidden]), select, textarea");
            if (first) try { first.focus(); } catch(e) {}
        }, 30);
    },
    hideModal: function() {
        var overlay = document.getElementById("modal-overlay");
        var content = document.getElementById("modal-content");
        overlay.classList.remove("open");
        overlay.style.display = "none";
        content.innerHTML = "";
        if (Admin._modalKeyHandler) {
            document.removeEventListener("keydown", Admin._modalKeyHandler);
            Admin._modalKeyHandler = null;
        }
        if (Admin._modalBackdropHandler) {
            overlay.removeEventListener("click", Admin._modalBackdropHandler);
            Admin._modalBackdropHandler = null;
        }
    },

    fmtDuration: function(sec) {
        if (sec == null) return "--";
        if (sec < 60) return sec + "s";
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        if (m < 60) return m + "m " + s + "s";
        var h = Math.floor(m / 60);
        return h + "h " + (m % 60) + "m";
    },
    fmtTs: function(ts) {
        return App.formatDateTime(ts);
    },
    _monthName: function(idx) {
        var keys = ["month_jan","month_feb","month_mar","month_apr","month_may",
                    "month_jun","month_jul","month_aug","month_sep","month_oct",
                    "month_nov","month_dec"];
        var fallback = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return Admin._t(keys[idx], fallback[idx]);
    },

    fmtRelative: function(ts) {
        if (ts == null) return "—";
        var d = (typeof ts === "number") ? new Date(ts * 1000) : new Date(ts);
        if (isNaN(d.getTime())) return "—";
        var diff = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diff < 0) diff = 0;
        if (diff < 30) return Admin._t("just_now", "just now");
        if (diff < 60) return diff + Admin._t("sec_ago_short", "s ago");
        if (diff < 3600) return Math.floor(diff / 60) + Admin._t("min_ago_short", "m ago");
        if (diff < 86400) return Math.floor(diff / 3600) + Admin._t("hour_ago_short", "h ago");
        if (diff < 172800) return Admin._t("yesterday_short", "Yesterday");
        if (diff < 604800) return Math.floor(diff / 86400) + Admin._t("day_ago_short", "d ago");
        return d.getDate() + " " + Admin._monthName(d.getMonth());
    },

    fmtFriendlyTime: function(ts) {
        if (ts == null) return "—";
        var d = (typeof ts === "number") ? new Date(ts * 1000) : new Date(ts);
        if (isNaN(d.getTime())) return "—";
        var hh = String(d.getHours()).padStart(2, "0");
        var mm = String(d.getMinutes()).padStart(2, "0");
        var time = hh + ":" + mm;
        var now = new Date();
        var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var startOfDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        var dayDiff = Math.round((startOfToday - startOfDate) / 86400000);
        if (dayDiff === 0) return Admin._t("today_short", "Today") + " " + time;
        if (dayDiff === 1) return Admin._t("yesterday_short", "Yesterday") + " " + time;
        if (dayDiff < 7) return dayDiff + Admin._t("day_ago_short", "d ago") + " " + time;
        return d.getDate() + " " + Admin._monthName(d.getMonth()) + " " + time;
    },

    fmtDurationHMS: function(sec) {
        if (sec == null || isNaN(sec)) return "—";
        sec = Math.max(0, Math.floor(sec));
        var h = String(Math.floor(sec / 3600)).padStart(2, "0");
        var m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
        var s = String(sec % 60).padStart(2, "0");
        return h + ":" + m + ":" + s;
    },
};

// ── Admin.Limits ─────────────────────────
Admin.Limits = {
    _max: {},
    _loaded: false,

    refresh: async function() {
        try {
            var s = await App.api("GET", "/api/admin/host-status");
            this._max = (s && s.limits) || {};
            this._loaded = true;
        } catch (e) { /* keep previous values; indicator shows '--' */ }
    },

    update: function(resource, count) {
        var max = this._max["max_" + resource];
        var usage = document.getElementById(resource + "-usage");
        var rc = document.getElementById("rc-" + resource);
        if (usage) {
            usage.textContent = (max != null) ? (count + " / " + max) : String(count);
        }
        if (rc) {
            rc.textContent = (max != null) ? (count + "/" + max) : String(count);
        }
    },
};

// ── Dashboard + DashboardChart ──
Admin.Dashboard = { load: function(){}, startPolling: function(){} };
Admin.DashboardChart = { init: function(){} };

// ── System Health (Stage F.2) ────────────────────
Admin.Health = {
    POLL_MS: 30000,
    _interval: null,

    start: function() {
        Admin.Health.refresh();
        if (!Admin.Health._interval) {
            Admin.Health._interval = setInterval(Admin.Health.refresh, Admin.Health.POLL_MS);
        }
    },

    refresh: async function() {
        try {
            var res = await fetch("/api/system-health", {credentials: "same-origin"});
            if (!res.ok) throw new Error("status " + res.status);
            var data = await res.json();
            Admin.Health.render(data);
        } catch (e) {
            Admin.Health.render(null);
        }
    },

    _statusClasses: function(status) {
        if (status === "ok") return {dot: "on", r: "ok"};
        if (status === "slow" || status === "warn") return {dot: "warm", r: "warn"};
        if (status === "error" || status === "down") return {dot: "off", r: "error"};
        return {dot: "neutral", r: "idle"};
    },

    _renderRows: function(rows) {
        var containers = document.querySelectorAll("#healthMenu, #systemHealth");
        containers.forEach(function(container) {
            var rowTag = container.id === "healthMenu" ? "span" : "div";
            var lastPush = container.querySelector(".health-last-push");
            container.querySelectorAll(".health-row").forEach(function(el) { el.remove(); });
            rows.forEach(function(row) {
                var rowEl = document.createElement(rowTag);
                rowEl.className = "health-row";
                rowEl.dataset.probe = row.key;
                var labelEl = document.createElement("span");
                labelEl.style.cssText = "color:var(--fg-dim);font-size:11.5px";
                labelEl.textContent = row.label || row.key;
                rowEl.appendChild(labelEl);
                var cls = Admin.Health._statusClasses(row.status);
                var rEl = document.createElement("span");
                rEl.className = "r " + cls.r;
                rEl.innerHTML = '<span class="dot ' + cls.dot + '"></span>' +
                                (row.status || "--").toUpperCase();
                rowEl.appendChild(rEl);
                if (lastPush) container.insertBefore(rowEl, lastPush);
                else container.appendChild(rowEl);
            });
        });
        Admin.Health._updateAggregateDot();
    },

    _updateAggregateDot: function() {
        var dot = document.getElementById("healthToggleDot");
        if (!dot) return;
        var rows = document.querySelectorAll('#systemHealth .health-row .r');
        var hasError = false, hasWarn = false, allIdle = true;
        rows.forEach(function(r) {
            if (r.classList.contains("error")) hasError = true;
            else if (r.classList.contains("warn")) hasWarn = true;
            if (!r.classList.contains("idle")) allIdle = false;
        });
        dot.className = "health-toggle-dot " + (hasError ? "error" : (hasWarn ? "warn" : (allIdle ? "idle" : "ok")));
    },

    _fmtHeartbeatAgo: function(sec) {
        var s = Math.floor(sec);
        if (s < 60) return s + Admin._t("sec_ago_short", "s ago");
        if (s < 3600) return Math.floor(s / 60) + Admin._t("min_ago_short", "m ago");
        if (s < 86400) return Math.floor(s / 3600) + Admin._t("hour_ago_short", "h ago");
        return Math.floor(s / 86400) + Admin._t("day_ago_short", "d ago");
    },

    render: function(d) {
        var lpEls = document.querySelectorAll(".health-last-push");
        var hbLabel = (typeof I18N !== "undefined" && I18N.t)
            ? I18N.t("last_heartbeat", "Last heartbeat")
            : "Last heartbeat";
        var setLastPush = function(text) {
            lpEls.forEach(function(el) { el.textContent = text; });
        };
        var rows = (d && d.rows) ? d.rows : [
            {key: "host_sync", label: "Host sync", status: "idle"},
            {key: "tunnel", label: "Tunnel", status: "idle"},
        ];
        Admin.Health._renderRows(rows);
        var hb = d ? d.last_heartbeat_ago_seconds : null;
        if (hb != null && !isNaN(hb)) {
            setLastPush(hbLabel + " " + Admin.Health._fmtHeartbeatAgo(hb));
        } else {
            setLastPush(hbLabel + " —");
        }
    },
};

// ── Users ──────────────────────────────────────────────────────

Admin.Users = {
    _preloadCount: async function() {
        try {
            var users = await App.api("GET", "/api/admin/users");
            Admin.users = users;
            Admin.Limits.update("users", users.length);
        } catch (e) { /* silent */ }
    },

    _page: 1,

    goToPage: function(p) {
        Admin.Users._page = p;
        Admin.Users._render();
    },

    load: async function() {
        Admin._renderTableSkeleton("#users-table tbody", 7);
        try {
            var needs = [App.api("GET", "/api/admin/users")];
            if (!Admin.devices || !Admin.devices.length) {
                needs.push(App.api("GET", "/api/admin/devices").then(function(d){Admin.devices=d;}).catch(function(){}));
            }
            var results = await Promise.all(needs);
            var users = results[0];
            Admin.users = users;
            Admin.Limits.update("users", users.length);
            Admin.Users._render();
        } catch (e) { App.toast(e.message, true); }
    },

    _render: function() {
        try {
            var users = Admin.users || [];
            var tbody = document.querySelector("#users-table tbody");
            if (!tbody) return;
            if (users.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' + Admin._t("empty_users", "No users") + '</td></tr>';
                Admin._renderPager("users-pager", 1, 1, "Admin.Users.goToPage");
                return;
            }
            var pg = Admin._paginate(users, Admin.Users._page || 1);
            Admin.Users._page = pg.page;
            var html = "";
            var editLabel = Admin._t("edit", "Edit");
            pg.items.forEach(function(u) {
                var perm = u.location_permission || "free";
                var locCell = u.location_name
                    ? Admin._escape(u.location_name)
                    : (u.default_lat != null ? 'Custom' : '<span style="color:var(--fg-mute)">—</span>');
                var initial = (u.username || "?").charAt(0).toUpperCase();
                var isOnline = u.is_online === true || u.online === true;
                var roleLabel = u.role === "client_admin"
                    ? '<span class="pill accent">client_admin</span>'
                    : '<span class="pill">User</span>';
                var permClass = perm === "locked" ? "warm" : "mute";
                var permColor = perm === "locked" ? "var(--warm)" : "var(--fg-dim)";
                var permLabel = perm === "locked"
                    ? Admin._t("perm_locked", "LOCKED")
                    : Admin._t("perm_free", "FREE");
                var permHtml = '<span class="mono" style="color:' + permColor + ';font-size:11px;letter-spacing:.05em;text-transform:uppercase">' + permLabel + '</span>';
                var deviceHtml;
                if (u.device_udid) {
                    var dvName = u.device_name;
                    if (!dvName && Admin.devices) {
                        var dv = Admin.devices.find(function(x){return x.udid === u.device_udid;});
                        if (dv) dvName = dv.name;
                    }
                    deviceHtml = Admin._escape(dvName || "—");
                } else {
                    deviceHtml = '<span style="color:var(--fg-mute)">—</span>';
                }
                var actionHtml = '<span class="row-actions">'
                    + '<button class="row-btn" onclick="Admin.Users.showEditModal(\'' + u.id + '\')">' + editLabel + '</button>';
                if (u.role !== "client_admin" || u.id !== Admin._currentUserId) {
                    actionHtml += '<button class="row-btn ico danger" title="' + Admin._t("delete","Delete") + '" onclick="Admin.Users.remove(\'' + u.id + '\', \'' + u.username + '\')">✕</button>';
                }
                actionHtml += '</span>';
                html += '<tr>' +
                    '<td data-label="Username"><div class="cell-user"><div class="av">' + initial + '</div><span style="font-weight:500">' + Admin._escape(u.username) + '</span>' +
                    (isOnline ? '<span class="dot on"></span>' : '') +
                    '</div></td>' +
                    '<td data-label="Role">' + roleLabel + '</td>' +
                    '<td data-label="Permission">' + permHtml + '</td>' +
                    '<td data-label="Device">' + deviceHtml + '</td>' +
                    '<td data-label="Location">' + locCell + '</td>' +
                    '<td data-label="Last Login" class="mono" style="color:var(--fg-mute);font-size:11.5px">' + Admin.fmtRelative(u.last_login) + '</td>' +
                    '<td data-label="Actions">' + actionHtml + '</td>' +
                    '</tr>';
            });
            tbody.innerHTML = html;
            Admin._renderPager("users-pager", pg.page, pg.pages, "Admin.Users.goToPage");
        } catch (e) {
            App.toast(e.message, true);
        }
    },

    _permissionSelectHtml: function(currentValue, locationMode) {
        var cur = currentValue || (locationMode === "locked" ? "locked" : "free");
        if (locationMode === "locked") {
            return '<label>Permission</label>' +
                '<select class="input" id="m-permission" disabled>' +
                  '<option value="locked" selected>locked (host policy)</option>' +
                '</select>' +
                '<input type="hidden" id="m-permission-hidden" value="locked">';
        }
        return '<label>Permission</label>' +
            '<select class="input" id="m-permission" onchange="Admin.Users.togglePermFields()">' +
              '<option value="free"' + (cur === "free" ? " selected" : "") + '>free</option>' +
              '<option value="locked"' + (cur === "locked" ? " selected" : "") + '>locked</option>' +
            '</select>';
    },

    _readPermission: function() {
        var hidden = document.getElementById("m-permission-hidden");
        if (hidden) return hidden.value;
        return document.getElementById("m-permission").value;
    },

    showCreateModal: async function() {
        Admin._showLoadingModal(Admin._t("create_user", "Create user"));
        var devices = await App.api("GET", "/api/admin/devices").catch(function(){return [];});
        var locations = await App.api("GET", "/api/admin/locations").catch(function(){return [];});
        var hostStatus = await fetch("/api/host-status").then(function(r){return r.json();}).catch(function(){return {limits: {}};});
        var locationMode = (hostStatus.limits && hostStatus.limits.location_mode) || "free";
        var maxUsers = (hostStatus.limits && hostStatus.limits.max_users) || "--";
        var seatNum = (Admin.users.length || 0) + 1;
        var T = Admin._t;
        var none = T("none_option", "— None —");

        var deviceOptions = '<option value="">' + none + '</option>' + devices.map(function(d) {
            return '<option value="' + d.udid + '">' + Admin._escape(d.name) + '</option>';
        }).join("");
        var locOptions = '<option value="">' + none + '</option>' + locations.map(function(l) {
            return '<option value="' + l.id + '">' + Admin._escape(l.name) + '</option>';
        }).join("");

        var permLockedActive = locationMode === "locked";
        var roleHtml = '<div class="seg" id="m-role-seg">'
            + '<button type="button" class="active" data-val="user" onclick="Admin.Users._selectSeg(this)">' + T("seg_user", "User") + '</button>'
            + '<button type="button" data-val="client_admin" onclick="Admin.Users._selectSeg(this)">' + T("seg_admin", "Admin") + '</button>'
            + '</div>';
        var permHtml = '<div class="seg" id="m-perm-seg">'
            + '<button type="button" class="' + (permLockedActive ? "active accent" : "accent") + '" data-val="locked" ' + (locationMode === "locked" ? "disabled" : "onclick=\"Admin.Users._selectSeg(this)\"") + '><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor"></span> ' + T("seg_locked", "Locked") + '</button>'
            + '<button type="button" class="' + (permLockedActive ? "accent" : "active accent") + '" data-val="free" ' + (locationMode === "locked" ? "disabled" : "onclick=\"Admin.Users._selectSeg(this)\"") + '><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor"></span> ' + T("seg_free", "Free") + '</button>'
            + '</div>';

        var seatLine = T("modal_create_user_sub", "New operator assigned to this node.")
            + " " + T("seat_of", "Seat {n} of {max}").replace("{n}", seatNum).replace("{max}", maxUsers) + ".";
        var seatMeta = T("seat_meta", "SEAT {n} / {max} · LOCAL").replace("{n}", seatNum).replace("{max}", maxUsers);

        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></div>'
                + '<div><h3>' + T("create_user", "Create user") + '</h3><div class="sub">' + seatLine + '</div></div>'
                + '<button class="close" onclick="Admin.hideModal()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div class="row"><label>' + T("label_username_modal", "Username") + '</label><input class="input" id="m-username" autocomplete="off"></div>'
                + '<div class="row"><label>' + T("label_role", "Role") + '</label>' + roleHtml + '</div>'
                + '<div class="row"><label>' + T("label_permission", "Permission") + '</label>' + permHtml
                    + '<div class="hint">' + T("hint_locked_free", "Locked users can only switch between assigned locations. Free users can set any coordinate.") + '</div>'
                + '</div>'
                + '<div class="row"><label>' + T("label_assigned_device", "Assigned device") + '</label><select class="input" id="m-device">' + deviceOptions + '</select></div>'
                + '<div class="row"><label>' + T("label_first_location", "First assigned location") + '</label><select class="input" id="m-loc-preset">' + locOptions + '</select>'
                    + '<div class="hint">' + T("hint_first_location", "Add more locations after the user is created via Edit.") + '</div>'
                + '</div>'
                + '<div class="row"><label>' + T("label_password", "Password") + '</label><input class="input" type="password" id="m-password" placeholder="' + T("password_placeholder_auto", "auto-generated if empty") + '"></div>'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">' + seatMeta + '</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">' + T("cancel", "Cancel") + '</button>'
                    + '<button class="btn btn-primary" onclick="Admin.Users.create()">' + T("create_user_btn", "Create user") + '</button>'
                + '</div>'
            + '</div>'
        );
    },

    _selectSeg: function(btn) {
        var seg = btn.parentElement;
        seg.querySelectorAll("button").forEach(function(b) { b.classList.remove("active"); });
        btn.classList.add("active");
    },

    _readSeg: function(segId) {
        var active = document.querySelector("#" + segId + " button.active");
        return active ? active.dataset.val : null;
    },

    togglePermFields: function() {},

    filter: function() {
        var qEl = document.getElementById("usersSearch");
        var rEl = document.getElementById("usersRoleFilter");
        var pEl = document.getElementById("usersPermFilter");
        var q = qEl ? qEl.value.trim().toLowerCase() : "";
        var rFilter = rEl ? rEl.value : "";
        var pFilter = pEl ? pEl.value : "";
        var rows = document.querySelectorAll("#users-table tbody tr");
        var users = Admin.users || [];
        rows.forEach(function(tr, i) {
            var u = users[i];
            if (!u) return;
            var matchSearch = !q
                || (u.username || "").toLowerCase().indexOf(q) !== -1
                || (u.device_name || "").toLowerCase().indexOf(q) !== -1;
            var matchRole = !rFilter || u.role === rFilter;
            var matchPerm = !pFilter || (u.location_permission || "free") === pFilter;
            tr.style.display = (matchSearch && matchRole && matchPerm) ? "" : "none";
        });
    },

    fillLoc: function() {
        var sel = document.getElementById("m-loc-preset");
        var opt = sel.options[sel.selectedIndex];
        if (opt.dataset.lat) {
            document.getElementById("m-lat").value = opt.dataset.lat;
            document.getElementById("m-lon").value = opt.dataset.lon;
        }
    },

    create: async function() {
        var errEl = document.getElementById("m-error");
        errEl.textContent = "";
        var body = {
            username: document.getElementById("m-username").value.trim(),
            password: document.getElementById("m-password").value,
            role: Admin.Users._readSeg("m-role-seg") || "user",
            location_permission: Admin.Users._readSeg("m-perm-seg") || "free",
            device_udid: document.getElementById("m-device").value || null,
        };
        var locPresetVal = document.getElementById("m-loc-preset").value;
        body.global_location_id = locPresetVal || null;
        var saveBtn = document.querySelector("#modal-content .modal-foot .btn-primary");
        Admin._setSavingButton(saveBtn, true);
        try {
            var newUser = await App.api("POST", "/api/admin/users", body);
            if (locPresetVal && newUser && newUser.id) {
                try {
                    await App.api("POST", "/api/admin/user-locations", {
                        user_id: newUser.id, location_id: locPresetVal,
                    });
                } catch (e2) { /* non-fatal */ }
            }
            App.toast(Admin._t("toast_user_created", "User created"));
            Admin.hideModal();
            Admin.Users.load();
        } catch (e) {
            errEl.textContent = e.message;
            Admin._setSavingButton(saveBtn, false);
        }
    },

    showEditModal: async function(id) {
        var user = Admin.users.find(function(u) { return u.id === id; });
        if (!user) return;
        Admin._showLoadingModal(Admin._t("edit_user", "Edit user") + " · " + Admin._escape(user.username));
        var devices = await App.api("GET", "/api/admin/devices").catch(function(){return [];});
        var locations = await App.api("GET", "/api/admin/locations").catch(function(){return [];});
        var hostStatus = await fetch("/api/host-status").then(function(r){return r.json();}).catch(function(){return {limits: {}};});
        var locationMode = (hostStatus.limits && hostStatus.limits.location_mode) || "free";
        var T = Admin._t;
        var none = T("none_option", "— None —");
        var deviceOptions = '<option value="">' + none + '</option>' + devices.map(function(d) {
            return '<option value="' + d.udid + '"' + (d.udid === user.device_udid ? ' selected' : '') + '>' + Admin._escape(d.name) + '</option>';
        }).join("");
        var locOptions = '<option value="">' + none + '</option>' + locations.map(function(l) {
            var sel = user.global_location_id === l.id ? ' selected' : '';
            return '<option value="' + l.id + '"' + sel + '>' + Admin._escape(l.name) + '</option>';
        }).join("");

        var roleUser = user.role === "user";
        var permLocked = user.location_permission === "locked";
        var hostLocked = locationMode === "locked";
        var roleHtml = '<div class="seg" id="m-role-seg">'
            + '<button type="button" class="' + (roleUser ? "active" : "") + '" data-val="user" onclick="Admin.Users._selectSeg(this)">' + T("seg_user", "User") + '</button>'
            + '<button type="button" class="' + (!roleUser ? "active" : "") + '" data-val="client_admin" onclick="Admin.Users._selectSeg(this)">' + T("seg_admin", "Admin") + '</button>'
            + '</div>';
        var permHtml = '<div class="seg" id="m-perm-seg">'
            + '<button type="button" class="' + (permLocked ? "active accent" : "accent") + '" data-val="locked" ' + (hostLocked ? "disabled" : "onclick=\"Admin.Users._selectSeg(this)\"") + '><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor"></span> ' + T("seg_locked", "Locked") + '</button>'
            + '<button type="button" class="' + (!permLocked ? "active accent" : "accent") + '" data-val="free" ' + (hostLocked ? "disabled" : "onclick=\"Admin.Users._selectSeg(this)\"") + '><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor"></span> ' + T("seg_free", "Free") + '</button>'
            + '</div>';

        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></div>'
                + '<div><h3>' + T("edit_user", "Edit user") + '</h3><div class="sub">' + T("modal_edit_user_sub", "Update settings for") + ' <span class="mono" style="color:var(--fg)">' + Admin._escape(user.username) + '</span></div></div>'
                + '<button class="close" onclick="Admin.hideModal()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div class="row"><label>' + T("label_username_modal", "Username") + '</label><input class="input" id="m-username" value="' + Admin._escape(user.username) + '"></div>'
                + '<div class="row"><label>' + T("label_role", "Role") + '</label>' + roleHtml + '</div>'
                + '<div class="row"><label>' + T("label_permission", "Permission") + '</label>' + permHtml
                    + '<div class="hint">' + T("hint_locked_free", "Locked users can only switch between assigned locations. Free users can set any coordinate.") + '</div>'
                + '</div>'
                + '<div class="row"><label>' + T("label_assigned_device", "Assigned device") + '</label><select class="input" id="m-device">' + deviceOptions + '</select></div>'
                + '<div class="row"><label>' + T("label_assigned_locations", "Assigned locations") + ' <span style="color:var(--fg-mute);font-weight:400" id="m-loc-count"></span></label>'
                    + '<div id="m-user-locations" style="display:flex;flex-direction:column;gap:6px;margin-bottom:4px"><div style="font-size:12px;color:var(--fg-mute)">' + T("loading", "Loading…") + '</div></div>'
                    + '<div style="display:flex;gap:8px"><select class="input" id="m-loc-add" style="flex:1">' + locOptions + '</select>'
                    + '<button class="btn btn-outline" type="button" onclick="Admin.Users.assignLocation(\'' + id + '\')">' + T("btn_add_short", "+ Add") + '</button></div>'
                    + '<div class="hint">' + T("hint_first_default", "First location is the default · Locked users can only switch within this list.") + '</div>'
                + '</div>'
                + '<div class="row"><label>' + T("label_new_password", "New password") + '</label><input class="input" type="password" id="m-password" placeholder="' + T("password_placeholder_keep", "Leave empty to keep current") + '"></div>'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">' + T("edit_mode", "EDIT MODE") + '</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">' + T("cancel", "Cancel") + '</button>'
                    + '<button class="btn btn-primary" onclick="Admin.Users.save(\'' + id + '\')">' + T("save_changes", "Save changes") + '</button>'
                + '</div>'
            + '</div>'
        );
        Admin.Users.loadAssignedLocations(id);
    },

    loadAssignedLocations: async function(userId) {
        var box = document.getElementById("m-user-locations");
        var count = document.getElementById("m-loc-count");
        if (!box) return;
        var T = Admin._t;
        try {
            var rows = await App.api("GET", "/api/admin/users/" + userId + "/locations");
            if (count) {
                var n = rows ? rows.length : 0;
                var tmpl = n === 1 ? T("location_count_one", "{n} location")
                                   : T("location_count_many", "{n} locations");
                count.textContent = "· " + tmpl.replace("{n}", n);
            }
            if (!rows || rows.length === 0) {
                box.innerHTML = '<div style="font-size:11.5px;color:var(--fg-mute);padding:6px 0">' + T("no_locations_assigned", "No locations assigned yet.") + '</div>';
                return;
            }
            var defaultLabel = T("badge_default", "DEFAULT");
            var removeLabel = T("btn_remove", "Remove");
            box.innerHTML = rows.map(function(r, idx) {
                var tag = idx === 0
                    ? '<span class="pill accent" style="font-size:9px;margin-left:6px;padding:1px 6px">' + defaultLabel + '</span>'
                    : '';
                return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg-void);border:1px solid var(--line-soft);border-radius:8px">'
                    + '<span style="font-size:12.5px">' + Admin._escape(r.name) + tag + ' <span class="mono" style="color:var(--fg-mute);font-size:10.5px">(' + r.latitude.toFixed(4) + ',' + r.longitude.toFixed(4) + ')</span></span>'
                    + '<button class="row-btn ico danger" title="' + removeLabel + '" aria-label="' + removeLabel + '" onclick="Admin.Users.unassignLocation(\'' + userId + '\',\'' + r.id + '\')">✕</button>'
                    + '</div>';
            }).join("");
        } catch (e) {
            box.innerHTML = '<div class="err-msg">' + T("failed_to_load", "Failed to load") + ': ' + e.message + '</div>';
        }
    },

    assignLocation: async function(userId) {
        var errEl = document.getElementById("m-error");
        errEl.textContent = "";
        var locSelect = document.getElementById("m-loc-add") || document.getElementById("m-loc-preset");
        var locId = locSelect ? locSelect.value : "";
        if (!locId) { errEl.textContent = Admin._t("pick_location_first", "Pick a location first"); return; }
        try {
            await App.api("POST", "/api/admin/user-locations", {
                user_id: userId, location_id: locId,
            });
            App.toast(Admin._t("location_assigned", "Location assigned"));
            await Admin.Users.loadAssignedLocations(userId);
        } catch (e) { errEl.textContent = e.message; }
    },

    unassignLocation: async function(userId, locId) {
        try {
            await App.api("DELETE", "/api/admin/user-locations/" + userId + "/" + locId);
            await Admin.Users.loadAssignedLocations(userId);
        } catch (e) {
            var errEl = document.getElementById("m-error");
            if (errEl) errEl.textContent = e.message;
        }
    },

    save: async function(id) {
        var errEl = document.getElementById("m-error");
        errEl.textContent = "";
        var body = {
            username: document.getElementById("m-username").value.trim(),
            role: Admin.Users._readSeg("m-role-seg") || "user",
            location_permission: Admin.Users._readSeg("m-perm-seg") || "free",
            device_udid: document.getElementById("m-device").value || null,
        };
        var pwd = document.getElementById("m-password").value;
        if (pwd) body.password = pwd;
        var saveBtn = document.querySelector("#modal-content .modal-foot .btn-primary");
        Admin._setSavingButton(saveBtn, true);
        try {
            await App.api("PUT", "/api/admin/users/" + id, body);
            App.toast(Admin._t("toast_user_updated", "User updated"));
            Admin.hideModal();
            Admin.Users.load();
        } catch (e) {
            errEl.textContent = e.message;
            Admin._setSavingButton(saveBtn, false);
        }
    },

    remove: function(id, username) {
        var user = Admin.users.find(function(u){return u.id === id;});
        var initial = (username || "?").charAt(0).toUpperCase();
        var devName = (user && user.device_udid)
            ? Admin._escape(user.device_name || user.device_udid.substring(0,12))
            : "—";
        var perm = (user && user.location_permission) || "free";
        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon" style="background:var(--danger-soft);color:var(--danger);border-color:oklch(0.68 0.2 25 / .35)">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 11v6M14 11v6"/><path d="M4 7h16"/><path d="M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>'
                + '</div>'
                + '<div><h3>Delete user?</h3><div class="sub">This removes the user and stops any active session.</div></div>'
                + '<button class="close" onclick="Admin.hideModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div style="padding:12px 14px;background:var(--bg-void);border:1px solid var(--line-soft);border-radius:10px;display:flex;align-items:center;gap:10px">'
                    + '<div class="av" style="width:28px;height:28px;border-radius:50%;background:var(--bg-elevated);border:1px solid var(--line-soft);display:flex;align-items:center;justify-content:center;font-size:11px">' + initial + '</div>'
                    + '<div style="flex:1"><div style="font-weight:500">' + Admin._escape(username) + '</div>'
                    + '<div style="font-size:11px;color:var(--fg-mute);font-family:var(--font-mono);text-transform:uppercase">' + perm + ' · ' + devName + '</div></div>'
                + '</div>'
                + '<div class="hint">Type <span class="mono" style="color:var(--fg)">' + Admin._escape(username) + '</span> to confirm.</div>'
                + '<input class="input" id="m-confirm-input" placeholder="' + Admin._escape(username) + '" oninput="Admin.Users._toggleConfirmDelete(\'' + Admin._escape(username).replace(/\\/g,"\\\\").replace(/'/g,"\\\'") + '\')">'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">IRREVERSIBLE</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">Cancel</button>'
                    + '<button class="btn" id="m-confirm-delete" disabled style="background:var(--danger-soft);color:var(--danger);border:1px solid oklch(0.68 0.2 25 / .35);opacity:.5;cursor:not-allowed" onclick="Admin.Users._doDelete(\'' + id + '\',\'' + username.replace(/'/g,"\\\'") + '\')">Delete user</button>'
                + '</div>'
            + '</div>'
        );
    },

    _toggleConfirmDelete: function(expected) {
        var input = document.getElementById("m-confirm-input");
        var btn = document.getElementById("m-confirm-delete");
        if (!input || !btn) return;
        var match = input.value.trim() === expected;
        btn.disabled = !match;
        btn.style.opacity = match ? "1" : ".5";
        btn.style.cursor = match ? "pointer" : "not-allowed";
    },

    _doDelete: async function(id, username) {
        var btn = document.getElementById("m-confirm-delete");
        Admin._setSavingButton(btn, true);
        try {
            await App.api("DELETE", "/api/admin/users/" + id);
            App.toast(Admin._t("toast_deleted", "Deleted") + ": " + username);
            Admin.hideModal();
            Admin.Users.load();
        } catch (e) {
            Admin._setSavingButton(btn, false);
            var err = document.getElementById("m-error");
            if (err) err.textContent = e.message;
            else App.toast(e.message, true);
        }
    },
};

// ── Devices ────────────────────────────────────────────────────

Admin.Devices = {
    _page: 1,

    goToPage: function(p) {
        Admin.Devices._page = p;
        Admin.Devices.filter();
    },

    _preloadCount: async function() {
        try {
            var devices = await App.api("GET", "/api/admin/devices");
            Admin.devices = devices;
            Admin.Limits.update("devices", devices.length);
        } catch (e) { /* silent */ }
    },

    load: async function() {
        Admin._renderTableSkeleton("#devices-table tbody", 7);
        try {
            var devices = await App.api("GET", "/api/admin/devices");
            Admin.devices = devices;
            Admin.Limits.update("devices", devices.length);
            var assignedMap = {};
            (Admin.users || []).forEach(function(u) {
                if (u.device_udid) {
                    if (!assignedMap[u.device_udid]) assignedMap[u.device_udid] = [];
                    assignedMap[u.device_udid].push({id: u.id, username: u.username});
                }
            });
            devices.forEach(function(d) {
                if (!d.assigned_users) d.assigned_users = assignedMap[d.udid] || [];
            });
            Admin.Devices.filter();
        } catch (e) { App.toast(e.message, true); }
    },

    filter: function() {
        var qEl = document.getElementById("devicesSearch");
        var sEl = document.getElementById("devicesStatusFilter");
        var cEl = document.getElementById("devicesConnFilter");
        var q = qEl ? qEl.value.trim().toLowerCase() : "";
        var sFilter = sEl ? sEl.value : "";
        var cFilter = cEl ? cEl.value : "";
        var filtered = (Admin.devices || []).filter(function(d) {
            if (q) {
                var hay = (d.name || "") + " " + (d.model || "") + " " + (d.udid || "");
                if (hay.toLowerCase().indexOf(q) === -1) return false;
            }
            if (sFilter === "active" && !d.is_active) return false;
            if (sFilter === "disabled" && d.is_active) return false;
            if (cFilter) {
                var wifiFlag = d.wifi_enabled === true || d.wifi_connections_enabled === true;
                var conn = wifiFlag ? "WIFI" : "USB";
                if (conn !== cFilter) return false;
            }
            return true;
        });
        Admin.Devices._render(filtered);
    },

    _render: function(devices) {
        try {
            var tbody = document.querySelector("#devices-table tbody");
            if (!tbody) return;
            if (devices.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--fg-mute)">' + Admin._t("empty_devices", "No registered devices") + '</td></tr>';
                Admin._renderPager("devices-pager", 1, 1, "Admin.Devices.goToPage");
                return;
            }
            var pg = Admin._paginate(devices, Admin.Devices._page || 1);
            Admin.Devices._page = pg.page;
            var pageDevices = pg.items;
            var html = "";
            var editLabel = Admin._t("edit", "Edit");
            pageDevices.forEach(function(d) {
                var statusPill = d.is_active
                    ? '<span class="pill accent"><span class="dot on"></span>' + Admin._t("pill_active", "ACTIVE") + '</span>'
                    : '<span class="pill"><span class="dot off"></span>' + Admin._t("pill_idle", "IDLE") + '</span>';
                var wifiFlag = d.wifi_enabled === true || d.wifi_connections_enabled === true;
                var connPill = d.is_active
                    ? (wifiFlag
                        ? '<span class="pill"><span class="dot on"></span>WiFi</span>'
                        : '<span class="pill accent"><span class="dot on"></span>USB</span>')
                    : '<span style="color:var(--fg-mute)">—</span>';
                var assignedUsers = d.assigned_users || (d.assigned_user ? [d.assigned_user] : []);
                var nUsers = assignedUsers.length;
                var assignedHtml;
                if (nUsers > 0) {
                    var tmpl = nUsers === 1 ? Admin._t("user_count_one", "{n} user")
                                            : Admin._t("user_count_many", "{n} users");
                    assignedHtml = '<span class="mono" style="font-size:11px">' + tmpl.replace("{n}", nUsers) + '</span>';
                } else {
                    assignedHtml = '<span style="color:var(--fg-mute)">—</span>';
                }
                var actions = '<span class="row-actions">'
                    + '<button class="row-btn" onclick="Admin.Devices.showEditModal(\'' + d.id + '\')">' + editLabel + '</button>'
                    + '<button class="row-btn ico danger" title="Delete" onclick="Admin.Devices.remove(\'' + d.id + '\', \'' + Admin._escape(d.name).replace(/'/g,"\\\'") + '\')">✕</button>'
                    + '</span>';
                html += '<tr>'
                    + '<td data-label="Name" style="font-weight:500">' + Admin._escape(d.name) + '</td>'
                    + '<td data-label="Model">' + Admin._escape(d.model || '—') + '</td>'
                    + '<td data-label="iOS" class="mono" style="font-size:11.5px">' + Admin._escape(d.ios_version || '—') + '</td>'
                    + '<td data-label="Status">' + statusPill + '</td>'
                    + '<td data-label="Connection">' + connPill + '</td>'
                    + '<td data-label="Assigned">' + assignedHtml + '</td>'
                    + '<td data-label="Actions">' + actions + '</td>'
                    + '</tr>';
            });
            tbody.innerHTML = html;
            Admin._renderPager("devices-pager", pg.page, pg.pages, "Admin.Devices.goToPage");
        } catch (e) { App.toast(e.message, true); }
    },

    showRegisterModal: function() {
        var slotNum = (Admin.devices.length || 0) + 1;
        var maxDevices = (Admin.Limits._max && Admin.Limits._max.max_devices) || "--";
        var T = Admin._t;
        var slotMeta = T("slot_meta", "SLOT {n} / {max}").replace("{n}", slotNum).replace("{max}", maxDevices);

        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg></div>'
                + '<div><h3>' + T("register_device", "Register device") + '</h3><div class="sub">' + T("modal_register_device_sub", "Auto-detect device via USB or WiFi.") + '</div></div>'
                + '<button class="close" onclick="Admin.hideModal()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div id="regScanIdle" style="padding:22px 18px;border:1px dashed var(--line);border-radius:10px;background:var(--bg-void);text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="width:28px;height:28px;color:var(--fg-mute)" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 5v4h-4"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 19v-4h4"/></svg>'
                    + '<div id="regIdleMsg" style="font-size:13px;color:var(--fg-mute)">' + T("no_devices_detected", "No devices detected yet") + '</div>'
                    + '<button class="btn btn-sm btn-primary" onclick="Admin.Devices.scan()">' + T("scan_for_devices", "Scan for devices") + '</button>'
                + '</div>'
                + '<div id="regScanning" style="display:none;padding:18px;border:1px dashed var(--line);border-radius:10px;background:var(--bg-void)">'
                    + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span class="scan-spin"></span><span style="font-size:13px;font-weight:500">' + T("scanning", "Scanning…") + '</span></div>'
                + '</div>'
                + '<div id="regScanResult" style="display:none"></div>'
                + '<div id="regFields" style="display:none">'
                    + '<div class="row" style="margin-top:14px"><label>' + T("label_device_name", "Device name") + '</label><input class="input" id="regName" placeholder="e.g. Bandung Scout 02"></div>'
                + '</div>'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">' + slotMeta + '</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">' + T("cancel", "Cancel") + '</button>'
                    + '<button class="btn btn-primary" id="regBtn" disabled style="opacity:.5;cursor:not-allowed" onclick="Admin.Devices.register()">' + T("register", "Register") + '</button>'
                + '</div>'
            + '</div>'
        );
    },

    scan: async function() {
        var idle = document.getElementById("regScanIdle");
        var scanning = document.getElementById("regScanning");
        var result = document.getElementById("regScanResult");
        var fields = document.getElementById("regFields");
        var regBtn = document.getElementById("regBtn");
        if (idle) idle.style.display = "none";
        if (scanning) scanning.style.display = "block";
        if (result) result.style.display = "none";
        if (fields) fields.style.display = "none";
        var T = Admin._t;
        try {
            var devices = await App.api("GET", "/api/admin/devices/scan");
            if (scanning) scanning.style.display = "none";
            if (devices.length === 0) {
                if (idle) idle.style.display = "flex";
                var msg = document.getElementById("regIdleMsg");
                if (msg) msg.textContent = T("no_unregistered", "No unregistered devices. Plug iPhone via USB and trust this computer.");
                return;
            }
            var d = devices[0];
            Admin._scannedUdid = d.udid;
            var connPill = d.connection === "USB"
                ? '<span class="pill accent"><span class="dot on"></span>USB</span>'
                : '<span class="pill"><span class="dot on"></span>WiFi</span>';
            if (result) {
                result.style.display = "block";
                result.innerHTML = '<div style="padding:14px;border:1px dashed var(--line);border-radius:10px;background:var(--bg-void)">'
                    + '<div style="display:flex;align-items:center;gap:12px">'
                        + '<span class="dot on"></span>'
                        + '<div style="flex:1">'
                            + '<div style="font-weight:500">' + Admin._escape(d.name) + ' · iOS ' + Admin._escape(d.ios_version || "—") + '</div>'
                            + '<div style="font-size:11px;color:var(--fg-mute);margin-top:2px">' + T("detected_via", "Detected via") + ' ' + Admin._escape(d.connection || "USB") + '</div>'
                        + '</div>'
                        + connPill
                    + '</div>'
                + '</div>';
            }
            if (fields) {
                fields.style.display = "block";
                document.getElementById("regName").value = d.name;
            }
            if (regBtn) {
                regBtn.disabled = false;
                regBtn.style.opacity = "1";
                regBtn.style.cursor = "pointer";
            }
        } catch (e) {
            if (scanning) scanning.style.display = "none";
            if (idle) idle.style.display = "flex";
            var err = document.getElementById("m-error");
            if (err) err.textContent = e.message;
        }
    },

    register: async function() {
        var errEl = document.getElementById("m-error");
        if (errEl) errEl.textContent = "";
        var nameInput = document.getElementById("regName");
        var name = nameInput ? nameInput.value.trim() : "";
        if (!name || !Admin._scannedUdid) {
            if (errEl) errEl.textContent = Admin._t("scan_first", "Scan a device first");
            return;
        }
        var saveBtn = document.getElementById("regBtn");
        Admin._setSavingButton(saveBtn, true);
        try {
            await App.api("POST", "/api/admin/devices", {udid: Admin._scannedUdid, name: name});
            App.toast(Admin._t("toast_device_registered", "Device registered"));
            Admin._scannedUdid = null;
            Admin.hideModal();
            Admin.Devices.load();
        } catch (e) {
            if (errEl) errEl.textContent = e.message;
            Admin._setSavingButton(saveBtn, false);
        }
    },

    showEditModal: async function(id) {
        var device = Admin.devices.find(function(d) { return d.id === id; });
        if (!device) return;
        var users = await App.api("GET", "/api/admin/users");
        var assignedUsers = device.assigned_users || (device.assigned_user ? [device.assigned_user] : []);
        var assignedIds = {};
        assignedUsers.forEach(function(u){ if (u && u.id) assignedIds[u.id] = true; });
        var T = Admin._t;
        var unassignedOptions = '<option value="">' + T("select_user_assign", "Select user to assign…") + '</option>' + users.filter(function(u){return !assignedIds[u.id];}).map(function(u) {
            return '<option value="' + u.id + '">' + Admin._escape(u.username) + '</option>';
        }).join("");
        var nUsers = assignedUsers.length;
        var userCountTmpl = nUsers === 1 ? T("user_count_one", "{n} user") : T("user_count_many", "{n} users");
        var userCountTxt = userCountTmpl.replace("{n}", nUsers);

        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg></div>'
                + '<div><h3>' + T("edit_device", "Edit device") + '</h3><div class="sub">' + T("modal_edit_user_sub", "Update settings for") + ' <span class="mono" style="color:var(--fg)">' + Admin._escape(device.name) + '</span></div></div>'
                + '<button class="close" onclick="Admin.hideModal()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div class="row"><label>' + T("label_device_name", "Device name") + '</label><input class="input" id="m-name" value="' + Admin._escape(device.name) + '"></div>'
                + '<div class="row"><label>' + T("label_model", "Model") + ' <span style="color:var(--fg-mute);font-weight:400">· ' + Admin._escape(device.model || "—") + '</span></label>'
                    + '<input class="input" id="m-model-friendly" placeholder="' + T("placeholder_model_friendly_short", "iPhone 13 Pro Max") + '" value="' + Admin._escape(device.model_friendly || "") + '">'
                + '</div>'
                + '<div class="row"><label>' + T("status", "Status") + '</label>'
                    + '<div class="seg" id="m-status-seg">'
                        + '<button type="button" class="' + (device.is_active ? "active" : "") + '" data-val="active" onclick="Admin.Users._selectSeg(this)">' + T("seg_active", "Active") + '</button>'
                        + '<button type="button" class="' + (!device.is_active ? "active" : "") + '" data-val="disabled" onclick="Admin.Users._selectSeg(this)">' + T("seg_disabled", "Disabled") + '</button>'
                    + '</div>'
                + '</div>'
                + '<div class="row"><label>' + T("th_assigned_users", "Assigned users") + ' <span style="color:var(--fg-mute);font-weight:400" id="m-assigned-count">· ' + userCountTxt + '</span></label>'
                    + '<div id="m-device-assigned" style="display:flex;flex-direction:column;gap:6px;margin-bottom:4px">' + Admin.Devices._renderAssignedList(id, assignedUsers) + '</div>'
                    + '<div style="display:flex;gap:8px"><select class="input" id="m-user-pick" style="flex:1">' + unassignedOptions + '</select>'
                    + '<button class="btn btn-outline" type="button" onclick="Admin.Devices.assignUser(\'' + id + '\')">' + T("btn_add_short", "+ Add") + '</button></div>'
                    + '<div class="hint">' + T("hint_multi_user_device", "Multiple users can share a device. They take turns claiming the spoof session.") + '</div>'
                + '</div>'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">' + T("edit_mode", "EDIT MODE") + '</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">' + T("cancel", "Cancel") + '</button>'
                    + '<button class="btn btn-primary" onclick="Admin.Devices.save(\'' + id + '\')">' + T("save_changes", "Save changes") + '</button>'
                + '</div>'
            + '</div>'
        );
    },

    _renderAssignedList: function(deviceId, users) {
        if (!users || users.length === 0) {
            return '<div style="font-size:11.5px;color:var(--fg-mute);padding:6px 0">' + Admin._t("no_users_assigned", "No users assigned yet.") + '</div>';
        }
        return users.map(function(u) {
            var initial = (u.username || "?").charAt(0).toUpperCase();
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg-void);border:1px solid var(--line-soft);border-radius:8px">'
                + '<span style="display:flex;align-items:center;gap:8px;font-size:12.5px">'
                    + '<span class="av" style="width:22px;height:22px;border-radius:50%;background:var(--bg-elevated);border:1px solid var(--line-soft);display:inline-flex;align-items:center;justify-content:center;font-size:10px">' + initial + '</span>'
                    + Admin._escape(u.username)
                + '</span>'
                + '<button class="row-btn ico danger" title="Unassign" onclick="Admin.Devices.unassignUser(\'' + deviceId + '\',\'' + u.id + '\')">✕</button>'
                + '</div>';
        }).join("");
    },

    assignUser: async function(deviceId) {
        var errEl = document.getElementById("m-error");
        if (errEl) errEl.textContent = "";
        var userId = document.getElementById("m-user-pick").value;
        if (!userId) { if (errEl) errEl.textContent = "Pick a user first"; return; }
        try {
            var device = Admin.devices.find(function(d){return d.id === deviceId;});
            await App.api("PUT", "/api/admin/users/" + userId, {device_udid: device.udid});
            App.toast("User assigned");
            Admin.Devices._refreshEditAssigned(deviceId);
        } catch (e) { if (errEl) errEl.textContent = e.message; }
    },

    unassignUser: async function(deviceId, userId) {
        try {
            await App.api("PUT", "/api/admin/users/" + userId, {device_udid: null});
            Admin.Devices._refreshEditAssigned(deviceId);
        } catch (e) {
            var err = document.getElementById("m-error");
            if (err) err.textContent = e.message;
        }
    },

    _refreshEditAssigned: async function(deviceId) {
        try {
            var devices = await App.api("GET", "/api/admin/devices");
            Admin.devices = devices;
            var device = devices.find(function(d){return d.id === deviceId;});
            if (!device) return;
            var assignedUsers = device.assigned_users || (device.assigned_user ? [device.assigned_user] : []);
            var box = document.getElementById("m-device-assigned");
            var cnt = document.getElementById("m-assigned-count");
            if (box) box.innerHTML = Admin.Devices._renderAssignedList(deviceId, assignedUsers);
            if (cnt) cnt.textContent = "· " + assignedUsers.length + " user" + (assignedUsers.length === 1 ? "" : "s");
        } catch (e) {}
    },

    save: async function(id) {
        var errEl = document.getElementById("m-error");
        var status = Admin.Users._readSeg("m-status-seg");
        var modelFriendlyEl = document.getElementById("m-model-friendly");
        var modelFriendlyVal = modelFriendlyEl ? modelFriendlyEl.value.trim() : "";
        var body = {
            name: document.getElementById("m-name").value.trim(),
            is_active: status === "active",
            model_friendly: modelFriendlyVal || null,
        };
        var saveBtn = document.querySelector("#modal-content .modal-foot .btn-primary");
        Admin._setSavingButton(saveBtn, true);
        try {
            await App.api("PUT", "/api/admin/devices/" + id, body);
            App.toast(Admin._t("toast_device_updated", "Device updated"));
            Admin.hideModal();
            Admin.Devices.load();
        } catch (e) {
            errEl.textContent = e.message;
            Admin._setSavingButton(saveBtn, false);
        }
    },

    remove: function(id, name) {
        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon" style="background:var(--danger-soft);color:var(--danger);border-color:oklch(0.68 0.2 25 / .35)">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 11v6M14 11v6"/><path d="M4 7h16"/><path d="M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>'
                + '</div>'
                + '<div><h3>Remove device?</h3><div class="sub">This unregisters the device from this client.</div></div>'
                + '<button class="close" onclick="Admin.hideModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div style="padding:12px 14px;background:var(--bg-void);border:1px solid var(--line-soft);border-radius:10px;font-size:13px">' + Admin._escape(name) + '</div>'
                + '<div class="hint">Type <span class="mono" style="color:var(--fg)">' + Admin._escape(name) + '</span> to confirm.</div>'
                + '<input class="input" id="m-confirm-input" placeholder="' + Admin._escape(name) + '" oninput="Admin.Devices._toggleConfirmDelete(\'' + Admin._escape(name).replace(/\\/g,"\\\\").replace(/'/g,"\\\'") + '\')">'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">IRREVERSIBLE</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">Cancel</button>'
                    + '<button class="btn" id="m-confirm-delete" disabled style="background:var(--danger-soft);color:var(--danger);border:1px solid oklch(0.68 0.2 25 / .35);opacity:.5;cursor:not-allowed" onclick="Admin.Devices._doDelete(\'' + id + '\',\'' + name.replace(/'/g,"\\\'") + '\')">Remove device</button>'
                + '</div>'
            + '</div>'
        );
    },

    _toggleConfirmDelete: function(expected) {
        var input = document.getElementById("m-confirm-input");
        var btn = document.getElementById("m-confirm-delete");
        if (!input || !btn) return;
        var match = input.value.trim() === expected;
        btn.disabled = !match;
        btn.style.opacity = match ? "1" : ".5";
        btn.style.cursor = match ? "pointer" : "not-allowed";
    },

    _doDelete: async function(id, name) {
        var btn = document.getElementById("m-confirm-delete");
        Admin._setSavingButton(btn, true);
        try {
            await App.api("DELETE", "/api/admin/devices/" + id);
            App.toast(Admin._t("toast_deleted", "Deleted") + ": " + name);
            Admin.hideModal();
            Admin.Devices.load();
        } catch (e) {
            Admin._setSavingButton(btn, false);
            var err = document.getElementById("m-error");
            if (err) err.textContent = e.message;
            else App.toast(e.message, true);
        }
    },
};

// ── Locations ───────────────────────────────────────────────────

Admin.Locations = {
    _page: 1,

    goToPage: function(p) {
        Admin.Locations._page = p;
        Admin.Locations._render();
    },

    _preloadCount: async function() {
        try {
            var locations = await App.api("GET", "/api/admin/locations");
            Admin.locations = locations;
            Admin.Limits.update("locations", locations.length);
        } catch (e) { /* silent */ }
    },

    load: async function() {
        Admin._renderTableSkeleton("#locations-table tbody", 6);
        try {
            var locations = await App.api("GET", "/api/admin/locations");
            Admin.locations = locations;
            Admin.Limits.update("locations", locations.length);
            Admin.Locations._render();
        } catch (e) { App.toast(e.message, true); }
    },

    _render: function() {
        var locations = Admin.locations || [];
        var tbody = document.querySelector("#locations-table tbody");
        if (!tbody) return;
        if (locations.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--fg-mute)">' + Admin._t("empty_locations", "No global locations") + '</td></tr>';
            Admin._renderPager("locations-pager", 1, 1, "Admin.Locations.goToPage");
            Admin.Locations._renderMap([]);
            return;
        }
        var pg = Admin._paginate(locations, Admin.Locations._page || 1);
        Admin.Locations._page = pg.page;
        var html = "";
        var editLabel = Admin._t("edit", "Edit");
        pg.items.forEach(function(l) {
            var userCount = (l.assigned_users && l.assigned_users.length) || 0;
            var usersStr = userCount > 0
                ? '<span class="mono" style="color:var(--fg-dim)">' + userCount + ' user' + (userCount === 1 ? '' : 's') + '</span>'
                : '<span style="color:var(--fg-mute)">—</span>';
            var isHostSourced = l.is_universal === true;
            var creatorLabel = isHostSourced
                ? '<span class="mono" style="color:var(--accent);font-size:10.5px;letter-spacing:.06em">HOST</span>'
                : '<span style="color:var(--fg-mute)">' + Admin._escape(l.creator_username || "—") + '</span>';
            var actions = isHostSourced
                ? '<span class="row-actions"><span class="mono" style="font-size:10px;color:var(--fg-mute);letter-spacing:.06em" title="Host-sourced locations are read-only">READ-ONLY</span></span>'
                : '<span class="row-actions">'
                    + '<button class="row-btn" onclick="Admin.Locations.showEditModal(\'' + l.id + '\')">' + editLabel + '</button>'
                    + '<button class="row-btn ico danger" title="Delete" onclick="Admin.Locations.remove(\'' + l.id + '\', \'' + Admin._escape(l.name).replace(/'/g,"\\\'") + '\')">✕</button>'
                + '</span>';
            html += '<tr>'
                + '<td data-label="Name" style="font-weight:500">' + Admin._escape(l.name) + '</td>'
                + '<td data-label="Lat" class="mono" style="font-size:11.5px">' + l.latitude.toFixed(5) + '</td>'
                + '<td data-label="Lon" class="mono" style="font-size:11.5px">' + l.longitude.toFixed(5) + '</td>'
                + '<td data-label="Users">' + usersStr + '</td>'
                + '<td data-label="Created by" style="font-size:12px">' + creatorLabel + '</td>'
                + '<td data-label="Actions">' + actions + '</td>'
                + '</tr>';
        });
        tbody.innerHTML = html;
        Admin._renderPager("locations-pager", pg.page, pg.pages, "Admin.Locations.goToPage");
        Admin.Locations._renderMap(locations);
    },

    _mapInstance: null,
    _markers: [],

    _renderMap: function(locations) {
        var el = document.getElementById("mapAdmin");
        if (!el || typeof L === "undefined") return;
        var doRender = function() {
            if (!Admin.Locations._mapInstance) {
                Admin.Locations._mapInstance = L.map(el, {
                    zoomControl: false,
                    attributionControl: false,
                }).setView([-2.5, 118], 4);
                L.control.zoom({position: "topright"}).addTo(Admin.Locations._mapInstance);
                L.tileLayer(
                    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
                    {maxZoom: 18, attribution: '&copy; OSM &copy; CARTO'}
                ).addTo(Admin.Locations._mapInstance);
            } else {
                Admin.Locations._mapInstance.invalidateSize();
            }
            Admin.Locations._markers.forEach(function(m) {
                Admin.Locations._mapInstance.removeLayer(m);
            });
            Admin.Locations._markers = [];
            var bounds = [];
            locations.forEach(function(l) {
                var pinIcon = L.divIcon({
                    className: "ggeo-pin",
                    html: '<span class="pulse p1"></span><span class="core"></span>',
                    iconSize: [14, 14],
                    iconAnchor: [7, 7],
                });
                var m = L.marker([l.latitude, l.longitude], {icon: pinIcon, title: l.name})
                    .addTo(Admin.Locations._mapInstance);
                Admin.Locations._markers.push(m);
                bounds.push([l.latitude, l.longitude]);
            });
            var tag = document.getElementById("locMapTag");
            if (tag) tag.textContent = locations.length + " LOCATION" + (locations.length === 1 ? "" : "S");
            if (bounds.length > 0) {
                Admin.Locations._mapInstance.fitBounds(bounds, {padding: [30, 30], maxZoom: 12});
            }
        };
        requestAnimationFrame(function() {
            requestAnimationFrame(doRender);
        });
    },

    showCreateModal: function() {
        Admin.Locations._editingId = null;
        var T = Admin._t;
        var meta = T("created_by_meta", "CREATED BY {user} · LOCAL").replace("{user}", "admin");
        Admin.Locations._showLocModal({
            title: T("add_location", "Add location"),
            sub: T("modal_add_location_sub", "Pin a coordinate on the map, or paste lat/lon."),
            meta: meta,
            saveLabel: T("save_location", "Save location"),
            onSaveFn: "Admin.Locations.create()",
        });
    },

    showEditModal: function(id) {
        var loc = Admin.locations.find(function(l) { return l.id === id; });
        if (!loc) return;
        Admin.Locations._editingId = id;
        var T = Admin._t;
        Admin.Locations._showLocModal({
            title: T("edit_location", "Edit location"),
            sub: T("modal_edit_location_sub", "Update name, coordinates, or notes."),
            meta: T("edit_mode", "EDIT MODE"),
            saveLabel: T("save_changes", "Save changes"),
            data: loc,
            onSaveFn: "Admin.Locations.save('" + id + "')",
        });
    },

    _showLocModal: function(opts) {
        var data = opts.data || {};
        var T = Admin._t;
        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg></div>'
                + '<div><h3>' + opts.title + '</h3><div class="sub">' + opts.sub + '</div></div>'
                + '<button class="close" onclick="Admin.hideModal()" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div class="row"><label>' + T("label_name", "Name") + '</label><input class="input" id="m-name" placeholder="e.g. Semarang Branch" value="' + Admin._escape(data.name || "") + '"></div>'
                + '<div class="row two">'
                    + '<div class="field"><label>' + T("label_latitude", "Latitude") + '</label><input class="input mono" id="m-lat" value="' + (data.latitude != null ? data.latitude : "") + '"></div>'
                    + '<div class="field"><label>' + T("label_longitude", "Longitude") + '</label><input class="input mono" id="m-lon" value="' + (data.longitude != null ? data.longitude : "") + '"></div>'
                + '</div>'
                + '<div class="row"><label>' + T("label_map_preview", "Map preview") + '</label>'
                    + '<div style="height:280px;border-radius:10px;overflow:hidden;border:1px solid var(--line-soft);position:relative;background:var(--bg-void)">'
                        + '<div class="real-map" id="mapModal" style="position:absolute;inset:0"></div>'
                        + '<div class="mini-zoom">'
                            + '<button type="button" data-mini-zoom="in" onclick="Admin.Locations._modalZoom(1)" title="Zoom in" aria-label="Zoom in"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>'
                            + '<button type="button" data-mini-zoom="out" onclick="Admin.Locations._modalZoom(-1)" title="Zoom out" aria-label="Zoom out"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>'
                        + '</div>'
                    + '</div>'
                    + '<div class="hint">' + T("hint_pin_map", "Click the map or drag the pin to set coordinates.") + '</div>'
                + '</div>'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">' + opts.meta + '</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">' + T("cancel", "Cancel") + '</button>'
                    + '<button class="btn btn-primary" onclick="' + opts.onSaveFn + '">' + opts.saveLabel + '</button>'
                + '</div>'
            + '</div>'
        );
        Admin.Locations._initModalMap(data);
        App.setupCoordAutofill(document.getElementById("m-lat"), document.getElementById("m-lon"));
    },

    _modalMap: null,
    _modalMarker: null,

    _initModalMap: function(data) {
        var el = document.getElementById("mapModal");
        if (!el || typeof L === "undefined") return;
        var lat = data.latitude != null ? parseFloat(data.latitude) : -6.2088;
        var lon = data.longitude != null ? parseFloat(data.longitude) : 106.8456;
        var zoom = data.latitude != null ? 14 : 5;
        if (Admin.Locations._modalMap) {
            try { Admin.Locations._modalMap.remove(); } catch(e) {}
            Admin.Locations._modalMap = null;
            Admin.Locations._modalMarker = null;
        }
        Admin.Locations._modalMap = L.map(el, {
            zoomControl: false,
            attributionControl: false,
        }).setView([lat, lon], zoom);
        L.tileLayer(
            "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            {maxZoom: 18}
        ).addTo(Admin.Locations._modalMap);
        var pinIcon = L.divIcon({
            className: "ggeo-pin",
            html: '<span class="pulse p1"></span><span class="core"></span>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        });
        Admin.Locations._modalMarker = L.marker([lat, lon], {icon: pinIcon, draggable: true})
            .addTo(Admin.Locations._modalMap);
        Admin.Locations._modalMap.on("click", function(e) {
            Admin.Locations._modalMarker.setLatLng(e.latlng);
            document.getElementById("m-lat").value = e.latlng.lat.toFixed(8);
            document.getElementById("m-lon").value = e.latlng.lng.toFixed(8);
        });
        Admin.Locations._modalMarker.on("dragend", function(e) {
            var ll = e.target.getLatLng();
            document.getElementById("m-lat").value = ll.lat.toFixed(8);
            document.getElementById("m-lon").value = ll.lng.toFixed(8);
        });
        var syncPin = function() {
            var l = parseFloat(document.getElementById("m-lat").value);
            var lo = parseFloat(document.getElementById("m-lon").value);
            if (!isNaN(l) && !isNaN(lo) && l >= -90 && l <= 90 && lo >= -180 && lo <= 180) {
                if (Admin.Locations._modalMarker) Admin.Locations._modalMarker.setLatLng([l, lo]);
                if (Admin.Locations._modalMap) Admin.Locations._modalMap.flyTo([l, lo], 14, {duration: 0.6});
            }
        };
        ["m-lat","m-lon"].forEach(function(id){
            var el2 = document.getElementById(id);
            el2.addEventListener("input", syncPin);
            el2.addEventListener("paste", function() { setTimeout(syncPin, 60); });
        });
        setTimeout(function(){ if (Admin.Locations._modalMap) Admin.Locations._modalMap.invalidateSize(); }, 200);
    },

    _modalZoom: function(delta) {
        if (!Admin.Locations._modalMap) return;
        Admin.Locations._modalMap.setZoom(Admin.Locations._modalMap.getZoom() + delta);
    },

    create: async function() {
        var errEl = document.getElementById("m-error");
        errEl.textContent = "";
        var saveBtn = document.querySelector("#modal-content .modal-foot .btn-primary");
        Admin._setSavingButton(saveBtn, true);
        try {
            await App.api("POST", "/api/admin/locations", {
                name: document.getElementById("m-name").value.trim(),
                latitude: parseFloat(document.getElementById("m-lat").value),
                longitude: parseFloat(document.getElementById("m-lon").value),
            });
            App.toast(Admin._t("toast_location_saved", "Location saved"));
            Admin.hideModal();
            Admin.Locations.load();
        } catch (e) {
            errEl.textContent = e.message;
            Admin._setSavingButton(saveBtn, false);
        }
    },

    save: async function(id) {
        var errEl = document.getElementById("m-error");
        var saveBtn = document.querySelector("#modal-content .modal-foot .btn-primary");
        Admin._setSavingButton(saveBtn, true);
        try {
            await App.api("PUT", "/api/admin/locations/" + id, {
                name: document.getElementById("m-name").value.trim(),
                latitude: parseFloat(document.getElementById("m-lat").value),
                longitude: parseFloat(document.getElementById("m-lon").value),
            });
            App.toast(Admin._t("toast_location_saved", "Location saved"));
            Admin.hideModal();
            Admin.Locations.load();
        } catch (e) {
            errEl.textContent = e.message;
            Admin._setSavingButton(saveBtn, false);
        }
    },

    remove: function(id, name) {
        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon" style="background:var(--danger-soft);color:var(--danger);border-color:oklch(0.68 0.2 25 / .35)">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 11v6M14 11v6"/><path d="M4 7h16"/><path d="M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>'
                + '</div>'
                + '<div><h3>Delete location?</h3><div class="sub">Removes the location and unassigns it from any users.</div></div>'
                + '<button class="close" onclick="Admin.hideModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body">'
                + '<div style="padding:12px 14px;background:var(--bg-void);border:1px solid var(--line-soft);border-radius:10px;font-size:13px">' + Admin._escape(name) + '</div>'
                + '<div class="hint">Type <span class="mono" style="color:var(--fg)">' + Admin._escape(name) + '</span> to confirm.</div>'
                + '<input class="input" id="m-confirm-input" placeholder="' + Admin._escape(name) + '" oninput="Admin.Locations._toggleConfirmDelete(\'' + Admin._escape(name).replace(/\\/g,"\\\\").replace(/'/g,"\\\'") + '\')">'
                + '<div class="err-msg" id="m-error"></div>'
            + '</div>'
            + '<div class="modal-foot">'
                + '<span class="meta">IRREVERSIBLE</span>'
                + '<div class="actions">'
                    + '<button class="btn btn-outline" onclick="Admin.hideModal()">Cancel</button>'
                    + '<button class="btn" id="m-confirm-delete" disabled style="background:var(--danger-soft);color:var(--danger);border:1px solid oklch(0.68 0.2 25 / .35);opacity:.5;cursor:not-allowed" onclick="Admin.Locations._doDelete(\'' + id + '\',\'' + name.replace(/'/g,"\\\'") + '\')">Delete location</button>'
                + '</div>'
            + '</div>'
        );
    },

    _toggleConfirmDelete: function(expected) {
        var input = document.getElementById("m-confirm-input");
        var btn = document.getElementById("m-confirm-delete");
        if (!input || !btn) return;
        var match = input.value.trim() === expected;
        btn.disabled = !match;
        btn.style.opacity = match ? "1" : ".5";
        btn.style.cursor = match ? "pointer" : "not-allowed";
    },

    _doDelete: async function(id, name) {
        var btn = document.getElementById("m-confirm-delete");
        Admin._setSavingButton(btn, true);
        try {
            await App.api("DELETE", "/api/admin/locations/" + id);
            App.toast(Admin._t("toast_deleted", "Deleted") + ": " + name);
            Admin.hideModal();
            Admin.Locations.load();
        } catch (e) {
            Admin._setSavingButton(btn, false);
            var err = document.getElementById("m-error");
            if (err) err.textContent = e.message;
            else App.toast(e.message, true);
        }
    },
};

// ── Activity ───────────────────────────────────────────────────

Admin.Activity = {
    _page: 1,
    _limit: 10,
    _userId: "",

    init: async function() {
        var users = (Admin.users && Admin.users.length)
            ? Admin.users
            : await App.api("GET", "/api/admin/users").catch(function(){return [];});
        if (!Admin.users || !Admin.users.length) Admin.users = users;
        var sel = document.getElementById("lh-user");
        if (sel) {
            var prev = sel.value;
            sel.innerHTML = '<option value="">' + Admin._t("all_users", "All Users") + '</option>' +
                users.map(function(u) {
                    return '<option value="' + u.id + '">' + Admin._escape(u.username) + '</option>';
                }).join("");
            sel.value = prev;
        }
        this._page = 1;
        this.load();
    },

    filterChange: function() {
        var sel = document.getElementById("lh-user");
        Admin.Activity._userId = sel ? sel.value : "";
        Admin.Activity._page = 1;
        Admin.Activity.load();
    },

    apply: function() {
        this._page = 1;
        this.load();
    },

    load: async function() {
        var qs = "page=" + this._page + "&limit=" + this._limit;
        if (Admin.Activity._userId) qs += "&user_id=" + encodeURIComponent(Admin.Activity._userId);
        try {
            var res = await fetch("/api/admin/login-history?" + qs, {
                credentials: "include",
            });
            var payload = await res.json();
            if (!payload || payload.status !== "ok") {
                throw new Error(payload && payload.message ? payload.message : "load failed");
            }
            Admin.Activity._render(payload.data || [], payload.total || 0);
        } catch (e) {
            App.toast(Admin._t("err_load", "Load failed") + ": " + e.message, true);
        }
    },

    /** delete all login_history (optional user scope). */
    deleteAll: async function() {
        var msg = Admin.Activity._userId
            ? Admin._t("confirm_delete_all_filtered", "Delete all login history for selected user?")
            : Admin._t("confirm_delete_all_login", "Delete ALL login history? This cannot be undone.");
        if (!(await App.confirm(msg, {title:"Konfirmasi"}))) return;
        var toastEl = Admin._showProcessingToast(Admin._t("processing_delete", "Deleting…"));
        try {
            var qs = Admin.Activity._userId
                ? "?user_id=" + encodeURIComponent(Admin.Activity._userId) : "";
            var res = await fetch("/api/admin/login-history" + qs, {
                method: "DELETE", credentials: "include",
            });
            var payload = await res.json();
            if (!payload || payload.status !== "ok") {
                throw new Error(payload && payload.message ? payload.message : "delete failed");
            }
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("deleted_count", "Deleted") + ": " + (payload.deleted || 0));
            Admin.Activity._page = 1;
            Admin.Activity.load();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("err_delete", "Delete failed") + ": " + e.message, true);
        }
    },

    _render: function(data, total) {
        var tbody = document.querySelector("#login-history-table tbody");
        var pager = document.getElementById("login-history-pager");
        if (!tbody) return;
        if (data.length === 0 && Admin.Activity._page === 1) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-state">' +
                Admin._t("empty_login_history", "No login history") + '</td></tr>';
            if (pager) { pager.hidden = true; pager.innerHTML = ""; }
            return;
        }
        if (data.length === 0 && Admin.Activity._page > 1) {
            Admin.Activity._page = Math.max(1, Admin.Activity._page - 1);
            return Admin.Activity.load();
        }

        var html = "";
        data.forEach(function(r) {
            var loggedIn = App.formatDateTime(r.logged_in_at);
            var loggedOut = r.logged_out_at ? App.formatDateTime(r.logged_out_at) :
                '<span style="color:var(--text-muted)">—</span>';
            html += '<tr>' +
                '<td data-label="User">' + Admin._escape(r.username || "--") + '</td>' +
                '<td data-label="Logged In">' + loggedIn + '</td>' +
                '<td data-label="Logged Out">' + loggedOut + '</td>' +
                '<td data-label="IP Address">' + Admin._escape(r.ip_address || "--") + '</td>' +
                '</tr>';
        });
        tbody.innerHTML = html;

        Admin.Activity._renderPager(pager, total);
    },

    _renderPager: function(pager, total) {
        if (!pager) return;
        var limit = Admin.Activity._limit;
        var pages = Math.max(1, Math.ceil(total / limit));
        if (pages <= 1) {
            pager.hidden = true;
            pager.innerHTML = "";
            return;
        }
        pager.hidden = false;
        var p = Admin.Activity._page;
        var parts = [];
        parts.push(
            '<button class="history-pager-btn" ' +
            (p === 1 ? "disabled" : "") +
            ' onclick="Admin.Activity.goTo(' + (p - 1) + ')" aria-label="Previous">&lsaquo;</button>'
        );
        var nums = Admin.Sessions._pageNumbers(p, pages);
        nums.forEach(function(n) {
            if (n === "…") {
                parts.push('<span class="history-pager-ellipsis">…</span>');
            } else {
                parts.push(
                    '<button class="history-pager-btn' + (n === p ? " active" : "") +
                    '" onclick="Admin.Activity.goTo(' + n + ')">' + n + '</button>'
                );
            }
        });
        parts.push(
            '<button class="history-pager-btn" ' +
            (p === pages ? "disabled" : "") +
            ' onclick="Admin.Activity.goTo(' + (p + 1) + ')" aria-label="Next">&rsaquo;</button>'
        );
        pager.innerHTML = parts.join("");
    },

    goTo: function(page) {
        if (page < 1) return;
        Admin.Activity._page = page;
        Admin.Activity.load();
    },

    del: async function(entryId) {
        if (!entryId) return;
        var toastEl = Admin._showProcessingToast(Admin._t("processing_delete", "Deleting…"));
        try {
            await App.api("DELETE", "/api/admin/login-history/" + entryId);
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("history_deleted", "Entry deleted"));
            Admin.Activity.load();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("err_delete", "Delete failed") + ": " + e.message, true);
        }
    },
};

// ── Sessions ───────────────────────────────────────────────────

Admin.Sessions = {
    pollInterval: null,
    _histPage: 1,
    _histLimit: 10,
    _histUserId: "",
    _recentlyKilled: {},
    _RECENT_KILL_TTL_MS: 10000,
    _activePage: 1,

    goToPage: function(p) {
        Admin.Sessions._activePage = p;
        Admin.Sessions._renderActive();
    },

    _markKilled: function(udid) {
        Admin.Sessions._recentlyKilled[udid] = Date.now();
    },

    _isRecentlyKilled: function(udid) {
        var t = Admin.Sessions._recentlyKilled[udid];
        if (!t) return false;
        if (Date.now() - t > Admin.Sessions._RECENT_KILL_TTL_MS) {
            delete Admin.Sessions._recentlyKilled[udid];
            return false;
        }
        return true;
    },

    initHistFilter: async function() {
        try {
            var users = await App.api("GET", "/api/admin/users");
            var sel = document.getElementById("sh-user");
            if (!sel) return;
            var prev = sel.value;
            sel.innerHTML = '<option value="">' + Admin._t("all_users", "All Users") + '</option>' +
                users.map(function(u) {
                    return '<option value="' + u.id + '">' + Admin._escape(u.username) + '</option>';
                }).join("");
            sel.value = prev;
        } catch (e) { /* silent */ }
    },

    histFilterChange: function() {
        var sel = document.getElementById("sh-user");
        Admin.Sessions._histUserId = sel ? sel.value : "";
        Admin.Sessions._histPage = 1;
        Admin.Sessions.loadHistory();
    },

    _resolveLocName: function(lat, lon) {
        if (lat == null || lon == null) return null;
        if (!Admin.locations || !Admin.locations.length) return null;
        var tLat = parseFloat(lat);
        var tLon = parseFloat(lon);
        if (isNaN(tLat) || isNaN(tLon)) return null;
        var THRESHOLD_DEG = 0.00045;
        for (var i = 0; i < Admin.locations.length; i++) {
            var l = Admin.locations[i];
            if (l.latitude == null) continue;
            var dLat = Math.abs(parseFloat(l.latitude) - tLat);
            var dLon = Math.abs(parseFloat(l.longitude) - tLon);
            if (dLat < THRESHOLD_DEG && dLon < THRESHOLD_DEG) return l.name;
        }
        return null;
    },

    _fmtSinceRelative: function(timestamp) {
        if (timestamp == null) return "—";
        var t = (typeof timestamp === "number") ? timestamp : Date.parse(timestamp) / 1000;
        if (isNaN(t)) return "—";
        var sec = Math.max(0, Math.floor(Date.now() / 1000 - t));
        if (sec < 60) return sec + Admin._t("sec_ago_short", "s ago");
        if (sec < 3600) return Math.floor(sec / 60) + Admin._t("min_ago_short", "m ago");
        if (sec < 86400) {
            var h = Math.floor(sec / 3600);
            var m = Math.floor((sec % 3600) / 60);
            return h + "h " + m + Admin._t("min_ago_short", "m ago");
        }
        return Math.floor(sec / 86400) + Admin._t("day_ago_short", "d ago");
    },

    load: async function() {
        if (!document.querySelector("#sessions-table tbody tr:not(.skeleton-row)")) {
            Admin._renderTableSkeleton("#sessions-table tbody", 6, 3);
        }
        try {
            var needs = [App.api("GET", "/api/admin/sessions")];
            if (!Admin.users || !Admin.users.length) {
                needs.push(App.api("GET", "/api/admin/users").then(function(d){Admin.users=d;}));
            }
            if (!Admin.devices || !Admin.devices.length) {
                needs.push(App.api("GET", "/api/admin/devices").then(function(d){Admin.devices=d;}));
            }
            var results = await Promise.all(needs);
            var sessionsRaw = results[0];
            var sessions = sessionsRaw.filter(function(s){
                if (Admin.Sessions._isRecentlyKilled(s.udid)) return false;
                if (s.is_simulating === false) return false;
                if (s.status === "inactive" || s.status === "stopped") return false;
                return true;
            });
            Admin.Sessions._lastSessions = sessions;
            Admin.Sessions._renderActive();
        } catch (e) { App.toast(e.message, true); }
    },

    _renderActive: function() {
        var sessions = Admin.Sessions._lastSessions || [];
        var tbody = document.querySelector("#sessions-table tbody");
        if (!tbody) return;
        var hcActive = document.getElementById("hcActive");
        if (hcActive) hcActive.textContent = sessions.length;
        if (sessions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--fg-mute)">' + Admin._t("empty_sessions", "No active sessions") + '</td></tr>';
            Admin._renderPager("sessions-pager", 1, 1, "Admin.Sessions.goToPage");
            return;
        }
        var pg = Admin._paginate(sessions, Admin.Sessions._activePage || 1);
        Admin.Sessions._activePage = pg.page;
        var userByDevice = {};
        (Admin.users || []).forEach(function(u) {
            if (u.device_udid) {
                if (!userByDevice[u.device_udid]) userByDevice[u.device_udid] = [];
                userByDevice[u.device_udid].push(u.username);
            }
        });
        var devByUdid = {};
        (Admin.devices || []).forEach(function(d) { devByUdid[d.udid] = d; });

        var html = "";
        pg.items.forEach(function(s) {
            var coords = s.lat != null ? s.lat.toFixed(5) + ", " + s.lon.toFixed(5) : "—";
            var locName = s.location_name
                || Admin.Sessions._resolveLocName(s.lat, s.lon);
            var locCell = locName
                ? '<span>' + Admin._escape(locName) + '</span>'
                : '<span class="mono" style="color:var(--fg-dim);font-size:11px">' + coords + '</span>';

            var users = userByDevice[s.udid] || [];
            var userCell;
            if (users.length > 0) {
                userCell = Admin._escape(users.join(", "));
            } else {
                var adminName = Admin.currentUser && Admin.currentUser.username;
                userCell = adminName
                    ? '<span style="color:var(--fg-mute);font-style:italic">' + Admin._escape(adminName) + '</span>'
                    : '<span style="color:var(--fg-mute)">—</span>';
            }

            var dev = devByUdid[s.udid];
            var devName = (dev && dev.name) || s.name || "—";
            var devModel = dev && (dev.model_friendly || dev.model);
            var devCell = '<div style="line-height:1.3">'
                + '<div>' + Admin._escape(devName) + '</div>'
                + (devModel ? '<div style="font-size:10.5px;color:var(--fg-mute)">' + Admin._escape(devModel) + '</div>' : '')
                + '</div>';

            var connText = "—";
            if (dev) {
                if (dev.connection) {
                    connText = dev.connection.toUpperCase().replace(/^NETWORK$/, "WIFI");
                } else if (dev.wifi_enabled === true || dev.wifi_connections_enabled === true) {
                    connText = "WIFI";
                } else {
                    connText = "USB";
                }
            }
            var connClass = connText === "USB" ? "pill accent" : "pill";
            var connPill = connText === "—"
                ? '<span style="color:var(--fg-mute)">—</span>'
                : '<span class="' + connClass + '"><span class="dot on"></span>' + connText + '</span>';

            var sinceRel = Admin.Sessions._fmtSinceRelative(s.spoof_started_at);
            var sinceAbs = Admin.Sessions._fmtElapsed(s.spoof_started_at);
            var since = '<div style="line-height:1.3">'
                + '<div>' + sinceRel + '</div>'
                + '<div class="mono" style="font-size:10.5px;color:var(--fg-mute)">' + sinceAbs + '</div>'
                + '</div>';

            var stopLabel = Admin._t("stop_session", "Stop");
            html += '<tr>'
                + '<td data-label="User">' + userCell + '</td>'
                + '<td data-label="Device">' + devCell + '</td>'
                + '<td data-label="Connection">' + connPill + '</td>'
                + '<td data-label="Location">' + locCell + '</td>'
                + '<td data-label="Since">' + since + '</td>'
                + '<td data-label="Actions"><button class="row-btn danger" onclick="Admin.Sessions.forceDisconnect(\'' + s.udid + '\')">' + stopLabel + '</button></td>'
                + '</tr>';
        });
        tbody.innerHTML = html;
        Admin._renderPager("sessions-pager", pg.page, pg.pages, "Admin.Sessions.goToPage");
        if (Admin.History && Admin.History.filterChange) Admin.History.filterChange();
    },

    _fmtElapsed: function(timestamp) {
        if (timestamp == null) return "—";
        var t = (typeof timestamp === "number") ? timestamp : Date.parse(timestamp) / 1000;
        if (isNaN(t)) return "—";
        var sec = Math.max(0, Math.floor(Date.now() / 1000 - t));
        var h = String(Math.floor(sec / 3600)).padStart(2, "0");
        var m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
        var s = String(sec % 60).padStart(2, "0");
        return h + ":" + m + ":" + s;
    },

    loadHistory: async function() {
        try {
            var page = Admin.Sessions._histPage;
            var limit = Admin.Sessions._histLimit;
            var qs = "page=" + page + "&limit=" + limit;
            if (Admin.Sessions._histUserId) {
                qs += "&user_id=" + encodeURIComponent(Admin.Sessions._histUserId);
            }
            var res = await fetch(
                "/api/admin/sessions/history?" + qs,
                { credentials: "include" }
            );
            var payload = await res.json();
            if (!payload || payload.status !== "ok") {
                throw new Error(payload && payload.message ? payload.message : "load failed");
            }
            Admin.Sessions._renderHistory(payload.data || [], payload.total || 0);
        } catch (e) {
            console.warn("loadHistory error:", e.message);
        }
    },

    deleteAllHistory: async function() {
        var msg = Admin.Sessions._histUserId
            ? Admin._t("confirm_delete_all_filtered", "Delete all session history for selected user?")
            : Admin._t("confirm_delete_all", "Delete ALL session history? This cannot be undone.");
        if (!(await App.confirm(msg, {title:"Konfirmasi"}))) return;
        var toastEl = Admin._showProcessingToast(Admin._t("processing_delete", "Deleting…"));
        try {
            var qs = Admin.Sessions._histUserId
                ? "?user_id=" + encodeURIComponent(Admin.Sessions._histUserId) : "";
            var res = await fetch("/api/admin/sessions/history" + qs, {
                method: "DELETE", credentials: "include",
            });
            var payload = await res.json();
            if (!payload || payload.status !== "ok") {
                throw new Error(payload && payload.message ? payload.message : "delete failed");
            }
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("deleted_count", "Deleted") + ": " + (payload.deleted || 0));
            Admin.Sessions._histPage = 1;
            Admin.Sessions.loadHistory();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("err_delete", "Delete failed") + ": " + e.message, true);
        }
    },

    _renderHistory: function(data, total) {
        var tbody = document.querySelector("#session-history-table tbody");
        var pager = document.getElementById("session-history-pager");
        if (!tbody) return;

        if (data.length === 0 && Admin.Sessions._histPage === 1) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' +
                Admin._t("empty_history", "No history yet") + '</td></tr>';
            if (pager) { pager.hidden = true; pager.innerHTML = ""; }
            return;
        }
        if (data.length === 0 && Admin.Sessions._histPage > 1) {
            Admin.Sessions._histPage = Math.max(1, Admin.Sessions._histPage - 1);
            return Admin.Sessions.loadHistory();
        }

        var endReasonMap = {
            user: Admin._t("end_reason_user", "User deactivate"),
            admin_force: Admin._t("end_reason_admin", "Admin force"),
            disconnect: Admin._t("end_reason_disconnect", "Disconnected"),
            server_stop: Admin._t("end_reason_server_stop", "Server stop"),
        };

        var html = "";
        data.forEach(function(s) {
            var resolvedName = s.location_name
                || Admin.Sessions._resolveLocName(s.latitude, s.longitude);
            var locationCell;
            if (resolvedName) {
                locationCell =
                    '<div class="history-name">' + Admin._escape(resolvedName) + '</div>' +
                    '<div class="history-coords">' +
                    (s.latitude != null ? parseFloat(s.latitude).toFixed(6) : "--") +
                    ", " +
                    (s.longitude != null ? parseFloat(s.longitude).toFixed(6) : "--") +
                    '</div>';
            } else {
                locationCell = '<div class="history-coords-primary">' +
                    (s.latitude != null ? parseFloat(s.latitude).toFixed(6) : "--") +
                    ", " +
                    (s.longitude != null ? parseFloat(s.longitude).toFixed(6) : "--") +
                    '</div>';
            }
            var duration = s.duration_seconds != null
                ? App.formatDuration(s.duration_seconds) : "--";
            var reasonLabel = endReasonMap[s.end_reason] || (s.end_reason || "--");
            var ts = App.formatDateTime(s.activated_at);
            var deviceLabel = s.device_name
                ? Admin._escape(s.device_name)
                : Admin._escape((s.device_udid || "--").slice(0, 12)) + '…';
            html += '<tr>' +
                '<td data-label="User">' + Admin._escape(s.username || "--") + '</td>' +
                '<td data-label="Device">' + deviceLabel + '</td>' +
                '<td data-label="Location">' + locationCell + '</td>' +
                '<td data-label="Duration">' + duration + '</td>' +
                '<td data-label="End Reason">' + Admin._escape(reasonLabel) + '</td>' +
                '<td data-label="Activated">' + Admin._escape(ts) + '</td>' +
                '</tr>';
        });
        tbody.innerHTML = html;

        Admin.Sessions._renderHistoryPager(pager, total);
    },

    _renderHistoryPager: function(pager, total) {
        if (!pager) return;
        var limit = Admin.Sessions._histLimit;
        var pages = Math.max(1, Math.ceil(total / limit));
        if (pages <= 1) {
            pager.hidden = true;
            pager.innerHTML = "";
            return;
        }
        pager.hidden = false;
        var p = Admin.Sessions._histPage;
        var parts = [];
        parts.push(
            '<button class="history-pager-btn" ' +
            (p === 1 ? "disabled" : "") +
            ' onclick="Admin.Sessions.histGoTo(' + (p - 1) + ')" aria-label="Previous">&lsaquo;</button>'
        );
        var nums = Admin.Sessions._pageNumbers(p, pages);
        nums.forEach(function(n) {
            if (n === "…") {
                parts.push('<span class="history-pager-ellipsis">…</span>');
            } else {
                parts.push(
                    '<button class="history-pager-btn' + (n === p ? " active" : "") +
                    '" onclick="Admin.Sessions.histGoTo(' + n + ')">' + n + '</button>'
                );
            }
        });
        parts.push(
            '<button class="history-pager-btn" ' +
            (p === pages ? "disabled" : "") +
            ' onclick="Admin.Sessions.histGoTo(' + (p + 1) + ')" aria-label="Next">&rsaquo;</button>'
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

    histGoTo: function(page) {
        if (page < 1) return;
        Admin.Sessions._histPage = page;
        Admin.Sessions.loadHistory();
    },

    delHistory: async function(sessionId) {
        if (!sessionId) return;
        var toastEl = Admin._showProcessingToast(Admin._t("processing_delete", "Deleting…"));
        try {
            await App.api("DELETE", "/api/admin/sessions/history/" + sessionId);
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("history_deleted", "Entry deleted"));
            Admin.Sessions.loadHistory();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("err_delete", "Delete failed") + ": " + e.message, true);
        }
    },

    startPolling: function() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        var self = this;
        this.pollInterval = setInterval(function() {
            self._pollActiveOnly();
        }, 5000);
    },

    _pollActiveOnly: async function() {
        try {
            await Admin.Sessions.load();
        } catch (e) { /* silent poll fail */ }
    },

    forceDisconnect: async function(udid) {
        var T = Admin._t;
        if (!(await App.confirm(T("confirm_force_disconnect", "Force disconnect this session?"),
            {title: T("force_disconnect", "Force Disconnect"), okText: T("stop_session", "Stop")}))) return;
        var toastEl = Admin._showProcessingToast(T("processing_stop", "Stopping session…"));
        try {
            await App.api("POST", "/api/admin/sessions/" + udid + "/kill");
            Admin.Sessions._markKilled(udid);
            Admin._dismissProcessingToast(toastEl);
            App.toast(T("toast_stopped", "Stopped"));
            Admin.Sessions.load();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(e.message, true);
        }
    },

    deactivateAll: async function() {
        var T = Admin._t;
        if (!(await App.confirm(T("confirm_deactivate_all", "Stop ALL active sessions?"),
            {title: T("deactivate_all", "Deactivate All"), okText: T("deactivate_all_short", "Stop All")}))) return;
        var toastEl = Admin._showProcessingToast(T("processing_stop_all", "Stopping all sessions…"));
        try {
            var currentUdids = (Admin.Sessions._lastSessions || []).map(function(s){return s.udid;});
            var pay = await App.api("POST", "/api/admin/sessions/kill-all");
            currentUdids.forEach(function(u){ Admin.Sessions._markKilled(u); });
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("deactivated_count", "Deactivated") + ": " + (pay && pay.count != null ? pay.count : 0));
            Admin.Sessions.load();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("err_deactivate", "Deactivate failed") + ": " + e.message, true);
        }
    },
};

// ── System ──────────────────────────────────────────────────────

// ── History  ─────────────────

Admin.History = {
    _sub: "active",
    _sessionPage: 1,
    _loginPage: 1,
    _perPage: 10,

    init: function() {
        Admin.History.populateFilters();
    },

    populateFilters: async function() {
        try {
            if (!Admin.users || !Admin.users.length) {
                Admin.users = await App.api("GET", "/api/admin/users").catch(function(){return [];});
            }
            if (!Admin.devices || !Admin.devices.length) {
                Admin.devices = await App.api("GET", "/api/admin/devices").catch(function(){return [];});
            }
            if (!Admin.locations || !Admin.locations.length) {
                Admin.locations = await App.api("GET", "/api/admin/locations").catch(function(){return [];});
            }
        } catch (e) { /* non-fatal */ }
        var T = Admin._t;
        var uSel = document.getElementById("hist-user");
        if (uSel) {
            var uPrev = uSel.value;
            uSel.innerHTML = '<option value="">' + T("all_users", "All users") + '</option>'
                + (Admin.users || []).map(function(u){
                    return '<option value="' + Admin._escape(u.username) + '">' + Admin._escape(u.username) + '</option>';
                }).join("");
            uSel.value = uPrev;
        }
        var lSel = document.getElementById("hist-location");
        if (lSel) {
            var lPrev = lSel.value;
            lSel.innerHTML = '<option value="">' + T("all_locations", "All locations") + '</option>'
                + (Admin.locations || []).map(function(l){
                    return '<option value="' + Admin._escape(l.name) + '">' + Admin._escape(l.name) + '</option>';
                }).join("");
            lSel.value = lPrev;
        }
        var dSel = document.getElementById("hist-device");
        if (dSel) {
            var dPrev = dSel.value;
            dSel.innerHTML = '<option value="">' + T("all_devices", "All devices") + '</option>'
                + (Admin.devices || []).map(function(d){
                    return '<option value="' + Admin._escape(d.name) + '">' + Admin._escape(d.name) + '</option>';
                }).join("");
            dSel.value = dPrev;
        }
    },

    _activeFilters: function() {
        var u = document.getElementById("hist-user");
        var l = document.getElementById("hist-location");
        var d = document.getElementById("hist-device");
        return {
            user: u ? u.value : "",
            location: l ? l.value : "",
            device: d ? d.value : "",
        };
    },

    applyTableFilter: function(tableSelector, getRowData) {
        var f = Admin.History._activeFilters();
        if (!f.user && !f.location && !f.device) return;
        var rows = document.querySelectorAll(tableSelector + " tbody tr");
        rows.forEach(function(tr) {
            var d = getRowData(tr);
            var matchU = !f.user || (d.user || "").toLowerCase() === f.user.toLowerCase();
            var matchL = !f.location || (d.location || "").toLowerCase() === f.location.toLowerCase();
            var matchD = !f.device || (d.device || "").toLowerCase() === f.device.toLowerCase();
            tr.style.display = (matchU && matchL && matchD) ? "" : "none";
        });
    },

    switchSub: function(sub) {
        if (!["active", "session", "login"].includes(sub)) return;
        Admin.History._sub = sub;
        document.querySelectorAll("#historySubtabs button").forEach(function(b) {
            b.classList.toggle("active", b.dataset.sub === sub);
        });
        ["active", "session", "login"].forEach(function(s) {
            var panel = document.getElementById("hist-panel-" + s);
            if (panel) panel.hidden = (s !== sub);
        });
        document.querySelectorAll(".hist-active-only").forEach(function(el) {
            el.hidden = (sub !== "active");
        });
        document.querySelectorAll(".hist-session-only").forEach(function(el) {
            el.hidden = (sub !== "session");
        });
        document.querySelectorAll(".hist-login-only").forEach(function(el) {
            el.hidden = (sub !== "login");
        });
        document.querySelectorAll(".hist-hide-on-active").forEach(function(el) {
            el.hidden = (sub === "active");
        });
        if (sub === "session") {
            Admin.History.loadSessionHistory();
        } else if (sub === "login") {
            Admin.History.loadLoginHistory();
        }
    },

    goToSessionPage: function(p) {
        Admin.History._sessionPage = p;
        Admin.History.loadSessionHistory();
    },

    goToLoginPage: function(p) {
        Admin.History._loginPage = p;
        Admin.History.loadLoginHistory();
    },

    loadSessionHistory: async function() {
        var tbody = document.querySelector("#session-history-table tbody");
        if (!tbody) return;
        Admin._renderTableSkeleton("#session-history-table tbody", 7);
        try {
            var resp = await fetch(
                "/api/admin/sessions/history?page=" + Admin.History._sessionPage +
                "&per_page=" + Admin.History._perPage,
                { credentials: "include" },
            );
            var payload = await resp.json();
            var rows = (payload && payload.data) || [];
            var total = payload.total || rows.length;
            var pages = Math.max(1, Math.ceil(total / Admin.History._perPage));
            var hcSession = document.getElementById("hcSession");
            if (hcSession) hcSession.textContent = total;
            if (rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--fg-mute)">No session history yet.</td></tr>';
                Admin._renderPager("session-history-pager", 1, 1, "Admin.History.goToSessionPage");
                return;
            }
            tbody.innerHTML = rows.map(function(r) {
                var dev = r.device_name || (r.device_udid || "—").slice(0, 12) + "…";
                var locName = r.location_name
                    || Admin.Sessions._resolveLocName(r.latitude, r.longitude)
                    || (r.latitude != null
                        ? '<span class="mono" style="color:var(--fg-dim);font-size:11px">' + parseFloat(r.latitude).toFixed(5) + ', ' + parseFloat(r.longitude).toFixed(5) + '</span>'
                        : '<span style="color:var(--fg-mute)">—</span>');
                var locCell = (typeof locName === "string" && locName.indexOf("<") < 0)
                    ? Admin._escape(locName) : locName;
                var durSec = r.duration_seconds != null
                    ? '<span class="mono" style="color:var(--accent)">' + Admin.fmtDurationHMS(r.duration_seconds) + '</span>'
                    : '<span class="mono" style="color:var(--fg-mute)">—</span>';
                var reason = (r.end_reason || "—").toUpperCase();
                var reasonLabel = reason;
                var reasonClass = "pill";
                if (/^(USER|ADMIN|MANUAL)$/i.test(reason)) {
                    reasonLabel = "MANUAL";
                    reasonClass = "pill";
                } else if (/disconnect|error|server_stop|network/i.test(reason)) {
                    reasonLabel = "DISCONNECT";
                    reasonClass = "pill danger";
                } else if (/timeout|idle/i.test(reason)) {
                    reasonLabel = "TIMEOUT";
                    reasonClass = "pill warm";
                }
                var reasonPill = reason === "—"
                    ? '<span style="color:var(--fg-mute)">—</span>'
                    : '<span class="' + reasonClass + '">' + Admin._escape(reasonLabel) + '</span>';
                var actionBtn = '<button class="row-btn ico danger" title="Delete entry" onclick="Admin.History.removeSessionEntry(\'' + (r.id || '') + '\')">✕</button>';
                return '<tr>'
                    + '<td data-label="User">' + Admin._escape(r.username || "—") + '</td>'
                    + '<td data-label="Device">' + Admin._escape(dev) + '</td>'
                    + '<td data-label="Location">' + locCell + '</td>'
                    + '<td data-label="Activated" class="mono" style="color:var(--fg-dim);font-size:11.5px">' + Admin.fmtFriendlyTime(r.activated_at) + '</td>'
                    + '<td data-label="Duration">' + durSec + '</td>'
                    + '<td data-label="End Reason">' + reasonPill + '</td>'
                    + '<td data-label="Actions">' + actionBtn + '</td>'
                    + '</tr>';
            }).join("");
            Admin._renderPager("session-history-pager", Admin.History._sessionPage, pages, "Admin.History.goToSessionPage");
            if (Admin.History && Admin.History.filterChange) Admin.History.filterChange();
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--danger)">Failed to load: ' + Admin._escape(e.message) + '</td></tr>';
        }
    },

    loadLoginHistory: async function() {
        var tbody = document.querySelector("#login-history-table tbody");
        if (!tbody) return;
        Admin._renderTableSkeleton("#login-history-table tbody", 4);
        try {
            var resp = await fetch(
                "/api/admin/login-history?page=" + Admin.History._loginPage +
                "&per_page=" + Admin.History._perPage,
                { credentials: "include" },
            );
            var payload = await resp.json();
            var rows = (payload && payload.data) || [];
            var total = payload.total || rows.length;
            var pages = Math.max(1, Math.ceil(total / Admin.History._perPage));
            var hcLogin = document.getElementById("hcLogin");
            if (hcLogin) hcLogin.textContent = total;
            if (rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--fg-mute)">No login history yet.</td></tr>';
                Admin._renderPager("login-history-pager", 1, 1, "Admin.History.goToLoginPage");
                return;
            }
            tbody.innerHTML = rows.map(function(r) {
                var loggedOut = r.logged_out_at
                    ? '<span class="mono" style="color:var(--fg-dim);font-size:11.5px">' + Admin.fmtFriendlyTime(r.logged_out_at) + '</span>'
                    : '<span style="color:var(--fg-mute)">—</span>';
                return '<tr>'
                    + '<td data-label="User">' + Admin._escape(r.username || "—") + '</td>'
                    + '<td data-label="IP" class="mono" style="font-size:11.5px;color:var(--fg-dim)">' + Admin._escape(r.ip_address || "—") + '</td>'
                    + '<td data-label="Logged In" class="mono" style="font-size:11.5px;color:var(--fg-dim)">' + Admin.fmtFriendlyTime(r.logged_in_at) + '</td>'
                    + '<td data-label="Logged Out">' + loggedOut + '</td>'
                    + '</tr>';
            }).join("");
            Admin._renderPager("login-history-pager", Admin.History._loginPage, pages, "Admin.History.goToLoginPage");
            if (Admin.History && Admin.History.filterChange) Admin.History.filterChange();
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--danger)">Failed to load: ' + Admin._escape(e.message) + '</td></tr>';
        }
    },

    filterChange: function() {
        if (Admin.History._sub === "session") {
            Admin.History.applyTableFilter("#session-history-table", function(tr){
                return {
                    user: tr.cells[0] ? tr.cells[0].textContent.trim() : "",
                    device: tr.cells[1] ? tr.cells[1].textContent.trim() : "",
                    location: tr.cells[2] ? tr.cells[2].textContent.trim() : "",
                };
            });
        } else if (Admin.History._sub === "login") {
            Admin.History.applyTableFilter("#login-history-table", function(tr){
                return {
                    user: tr.cells[0] ? tr.cells[0].textContent.trim() : "",
                    device: "",
                    location: "",
                };
            });
        } else {
            Admin.History.applyTableFilter("#sessions-table", function(tr){
                return {
                    user: tr.cells[0] ? tr.cells[0].textContent.trim() : "",
                    device: tr.cells[1] ? tr.cells[1].textContent.trim().split("\n")[0].trim() : "",
                    location: tr.cells[3] ? tr.cells[3].textContent.trim() : "",
                };
            });
        }
    },

    deleteAll: function() {
        if (Admin.History._sub === "session") {
            Admin.Sessions.deleteAllHistory();
        } else if (Admin.History._sub === "login") {
            Admin.History._deleteAllLogin();
        }
    },

    _deleteAllLogin: async function() {
        Admin.showModal(
            '<div class="modal-head">'
                + '<div class="icon" style="background:var(--danger-soft);color:var(--danger);border-color:oklch(0.68 0.2 25 / .35)">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 11v6M14 11v6"/><path d="M4 7h16"/><path d="M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>'
                + '</div>'
                + '<div><h3>Delete login history?</h3><div class="sub">Removes all login trail entries permanently.</div></div>'
                + '<button class="close" onclick="Admin.hideModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
            + '</div>'
            + '<div class="modal-body"><div class="hint">This will erase the entire login history. Cannot be undone.</div><div class="err-msg" id="m-error"></div></div>'
            + '<div class="modal-foot"><span class="meta">IRREVERSIBLE</span><div class="actions">'
                + '<button class="btn btn-outline" onclick="Admin.hideModal()">Cancel</button>'
                + '<button class="btn" style="background:var(--danger-soft);color:var(--danger);border:1px solid oklch(0.68 0.2 25 / .35)" onclick="Admin.History._doDeleteAllLogin()">Delete all</button>'
            + '</div></div>'
        );
    },

    _doDeleteAllLogin: async function() {
        var btn = document.getElementById("m-confirm-delete");
        Admin._setSavingButton(btn, true);
        try {
            var res = await fetch("/api/admin/login-history", {method: "DELETE", credentials: "include"});
            var p = await res.json();
            if (!p || p.status !== "ok") throw new Error(p && p.message ? p.message : "delete failed");
            App.toast(Admin._t("deleted_count", "Deleted") + ": " + (p.deleted || 0));
            Admin.hideModal();
            Admin.History.loadLoginHistory();
        } catch (e) {
            Admin._setSavingButton(btn, false);
            var err = document.getElementById("m-error");
            if (err) err.textContent = e.message;
        }
    },

    removeSessionEntry: async function(id) {
        if (!id) return;
        var toastEl = Admin._showProcessingToast(Admin._t("processing_delete", "Deleting…"));
        try {
            await fetch("/api/admin/sessions/history/" + id, {method: "DELETE", credentials: "include"});
            Admin._dismissProcessingToast(toastEl);
            App.toast(Admin._t("history_deleted", "Entry deleted"));
            Admin.History.loadSessionHistory();
        } catch (e) {
            Admin._dismissProcessingToast(toastEl);
            App.toast(e.message, true);
        }
    },
};
// ── Logs viewer ────────────────────────────

Admin.Logs = { load: function(){}, clear: function(){} };

Admin.System = { load: function(){} };

async function doLogout() {
    try { await fetch("/api/auth/logout", {method: "POST"}); } catch(e) {}
    window.location.href = "/login";
}
