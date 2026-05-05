// GGEO device.js — device control, SSE, device list cards, target-card.

var Device = {
    MAX_RETRY_DISPLAY: 5,

    eventSource: null,
    devices: [],
    _iosWarningShown: {},
    _selectedUdid: null,
    _selectedName: null,
    _statusCallbacks: [],
    _lastStatusOn: null,
    _lastSessionName: null,
    _lastSummary: null,
    _lastStateSig: null,
    _lastSessions: {},
    _lastToastedState: {},
    _previewLocationName: {},
    _previewLocationCoord: {},
    _missingDevices: [],

    renderMissing: function(list) {
        var self = this;
        self._missingDevices = list || [];
        var container = document.getElementById("missingDevices");
        if (!container) return;
        if (!list || !list.length) {
            container.style.display = "none";
            container.innerHTML = "";
            return;
        }
        var html = '<div class="missing-header">'
            + '<span class="missing-icon">!</span> '
            + self._t("missing_title", "Tidak Terdeteksi")
            + '</div>';
        list.forEach(function(d) {
            var ago = "";
            if (d.last_seen) {
                var diff = Math.floor((Date.now() / 1000) - d.last_seen);
                if (diff < 3600) ago = Math.floor(diff / 60) + " menit lalu";
                else if (diff < 86400) ago = Math.floor(diff / 3600) + " jam lalu";
                else ago = Math.floor(diff / 86400) + " hari lalu";
            }
            html += '<div class="missing-row" data-udid="' + d.udid + '">'
                + '<div class="missing-info">'
                + '<span class="missing-name">' + (d.name || d.udid.slice(0, 12)) + '</span>'
                + (ago ? '<span class="missing-ago">' + self._t("last_seen", "Terakhir") + ': ' + ago + '</span>' : '')
                + '</div>'
                + '<button class="missing-find-btn" onclick="Device.findDevice(\'' + d.udid + '\', this)">'
                + self._t("try_find", "Coba Temukan")
                + '</button>'
                + '</div>';
        });
        container.innerHTML = html;
        container.style.display = "block";
    },

    findDevice: async function(udid, btn) {
        var self = this;
        if (btn) {
            btn.disabled = true;
            btn.textContent = self._t("finding", "Mencari...");
        }
        try {
            var res = await fetch("/api/device/find", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({udid: udid}),
            });
            var json = await res.json();
            if (json.status === "ok" && json.data && json.data.found) {
                App.toast(self._t("device_found", "Device ditemukan"));
                self.scan();
            } else {
                if (btn) btn.textContent = self._t("not_found", "Tidak ditemukan");
                App.toast(self._t("device_not_found_net", "Tidak ditemukan di jaringan ini"), true);
                setTimeout(function() {
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = self._t("try_find", "Coba Temukan");
                    }
                }, 3000);
            }
        } catch (e) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = self._t("try_find", "Coba Temukan");
            }
            App.toast(self._t("err_find_failed", "Gagal mencari device"), true);
        }
    },

    _syncMapMarkers: function() {
        if (typeof GMap === "undefined" || !GMap.map) return;
        var self = this;
        var seenUdids = [];
        (this.devices || []).forEach(function(d) {
            var sess = self._lastSessions ? self._lastSessions[d.udid] : null;
            var state = self._stateOf(sess);
            var pCoord = self._previewLocationCoord ? self._previewLocationCoord[d.udid] : null;
            var sLat = sess && sess.lat;
            var sLon = sess && sess.lon;
            var lat = pCoord ? pCoord.lat : (sLat != null ? sLat : null);
            var lon = pCoord ? pCoord.lon : (sLon != null ? sLon : null);
            if (lat == null || lon == null) {
                GMap.removeDeviceMarker(d.udid);
                return;
            }
            seenUdids.push(d.udid);
            GMap.setDeviceMarker(d.udid, lat, lon, {
                state: state,
                name: d.name || "",
                selected: d.udid === self._selectedUdid,
            });
        });
        GMap.syncDeviceMarkers(seenUdids);
    },

    _emitTransitionToast: function(udid, prevState, newState, session) {
        if (typeof App === "undefined" || !App.toast) return;
        if (prevState === newState) return;
        var name = (session && session.name)
            || this._displayDeviceName({ udid: udid, name: this._device_names ? this._device_names[udid] : null })
            || this.get_device_name ? this.get_device_name(udid) : udid.slice(0, 8);
        var dev = this.devices && this.devices.find(function(d){return d.udid===udid;});
        if (dev && dev.name) name = dev.name;
        var locName = (this._previewLocationName && this._previewLocationName[udid])
            || (session && session.location_name) || "";
        var locSuffix = locName ? " → " + locName : "";
        var T = this._t;
        if (newState === "connecting" && prevState !== "reconnecting") {
            App.toast(name + ": " + T("toast_activating", "activating") + locSuffix);
        } else if (newState === "active") {
            if (prevState === "connecting") {
                App.toast(name + ": " + T("toast_active", "GPS active") + locSuffix);
            } else if (prevState === "reconnecting") {
                App.toast(name + ": " + T("toast_reconnected", "reconnected"));
            }
        } else if (newState === "reconnecting" && prevState !== "reconnecting") {
            App.toast(name + ": " + T("toast_reconnecting", "reconnecting…"), true);
        } else if (newState === "deactivating" && prevState !== "deactivating") {
            App.toast(name + ": " + T("toast_deactivating", "stopping…"));
        } else if (newState === "error" && prevState !== "error") {
            App.toast(name + ": " + T("toast_error", "error"), true);
        } else if (newState === "idle" && (prevState === "active" || prevState === "reconnecting")) {
            App.toast(name + ": " + T("toast_disconnected", "disconnected"), true);
        }
    },

    setPreviewLocation: function(udid, name, lat, lon) {
        if (!udid) return;
        if (name === null) {
            delete this._previewLocationName[udid];
        } else if (name) {
            this._previewLocationName[udid] = name;
        }
        if (lat != null && lon != null) {
            this._previewLocationCoord[udid] = { lat: lat, lon: lon };
        }
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
        this._syncMapMarkers();
    },

    clearPreviewLocation: function(udid) {
        delete this._previewLocationName[udid];
        delete this._previewLocationCoord[udid];
    },

    clearPreviewLocationName: function(udid) {
        if (!udid) return;
        delete this._previewLocationName[udid];
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
    },

    _fmtConnectDuration: function(sec) {
        if (sec == null || isNaN(sec)) return null;
        return Number(sec).toFixed(2) + "s";
    },

    _MODEL_MAP: {
        "iPhone10,1": "iPhone 8", "iPhone10,2": "iPhone 8 Plus",
        "iPhone10,3": "iPhone X", "iPhone10,4": "iPhone 8",
        "iPhone10,5": "iPhone 8 Plus", "iPhone10,6": "iPhone X",
        "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max",
        "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro",
        "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2nd gen)",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12",
        "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
        "iPhone14,6": "iPhone SE (3rd gen)", "iPhone14,7": "iPhone 14",
        "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro",
        "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15",
        "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro",
        "iPhone16,2": "iPhone 15 Pro Max", "iPhone17,1": "iPhone 16 Pro",
        "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16",
        "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
        "iPad7,11": "iPad (7th gen)", "iPad7,12": "iPad (7th gen)",
        "iPad8,1": "iPad Pro 11", "iPad8,2": "iPad Pro 11",
        "iPad8,3": "iPad Pro 11", "iPad8,4": "iPad Pro 11",
        "iPad8,5": "iPad Pro 12.9 (3rd gen)", "iPad8,6": "iPad Pro 12.9 (3rd gen)",
        "iPad8,7": "iPad Pro 12.9 (3rd gen)", "iPad8,8": "iPad Pro 12.9 (3rd gen)",
        "iPad8,9": "iPad Pro 11 (2nd gen)", "iPad8,10": "iPad Pro 11 (2nd gen)",
        "iPad8,11": "iPad Pro 12.9 (4th gen)", "iPad8,12": "iPad Pro 12.9 (4th gen)",
        "iPad11,1": "iPad mini (5th gen)", "iPad11,2": "iPad mini (5th gen)",
        "iPad11,3": "iPad Air (3rd gen)", "iPad11,4": "iPad Air (3rd gen)",
        "iPad11,6": "iPad (8th gen)", "iPad11,7": "iPad (8th gen)",
        "iPad12,1": "iPad (9th gen)", "iPad12,2": "iPad (9th gen)",
        "iPad13,1": "iPad Air (4th gen)", "iPad13,2": "iPad Air (4th gen)",
        "iPad13,4": "iPad Pro 11 (3rd gen)", "iPad13,5": "iPad Pro 11 (3rd gen)",
        "iPad13,6": "iPad Pro 11 (3rd gen)", "iPad13,7": "iPad Pro 11 (3rd gen)",
        "iPad13,8": "iPad Pro 12.9 (5th gen)", "iPad13,9": "iPad Pro 12.9 (5th gen)",
        "iPad13,10": "iPad Pro 12.9 (5th gen)", "iPad13,11": "iPad Pro 12.9 (5th gen)",
        "iPad13,16": "iPad Air (5th gen)", "iPad13,17": "iPad Air (5th gen)",
        "iPad13,18": "iPad (10th gen)", "iPad13,19": "iPad (10th gen)",
        "iPad14,1": "iPad mini (6th gen)", "iPad14,2": "iPad mini (6th gen)",
        "iPad14,3": "iPad Pro 11 (4th gen)", "iPad14,4": "iPad Pro 11 (4th gen)",
        "iPad14,5": "iPad Pro 12.9 (6th gen)", "iPad14,6": "iPad Pro 12.9 (6th gen)",
        "iPad14,8": "iPad Air 11 (M2)", "iPad14,9": "iPad Air 11 (M2)",
        "iPad14,10": "iPad Air 13 (M2)", "iPad14,11": "iPad Air 13 (M2)",
        "iPad16,1": "iPad mini (7th gen)", "iPad16,2": "iPad mini (7th gen)",
        "iPad16,3": "iPad Pro 11 (M4)", "iPad16,4": "iPad Pro 11 (M4)",
        "iPad16,5": "iPad Pro 13 (M4)", "iPad16,6": "iPad Pro 13 (M4)",
    },

    _friendlyModel: function(raw) {
        if (!raw) return null;
        return this._MODEL_MAP[raw] || raw;
    },

    _modelOverrideKey: function(udid) { return "ggeo_model_friendly_" + udid; },

    getModelOverride: function(udid) {
        try { return localStorage.getItem(this._modelOverrideKey(udid)) || null; }
        catch (e) { return null; }
    },

    setModelOverride: function(udid, val) {
        try {
            if (val) localStorage.setItem(this._modelOverrideKey(udid), val);
            else localStorage.removeItem(this._modelOverrideKey(udid));
        } catch (e) {}
    },

    _displayDeviceName: function(d) {
        if (!d) return "—";
        return d.name || d.udid || "—";
    },

    _displayDeviceModel: function(d) {
        if (!d) return null;
        var override = d.model_friendly || (d.udid ? this.getModelOverride(d.udid) : null);
        var friendly = override || this._friendlyModel(d.model);
        if (!friendly) return null;
        if (friendly === d.name) return null;
        return friendly;
    },

    _hasValidCoordFor: function(udid) {
        var pCoord = this._previewLocationCoord[udid];
        if (pCoord && pCoord.lat != null && pCoord.lon != null
            && pCoord.lat >= -90 && pCoord.lat <= 90
            && pCoord.lon >= -180 && pCoord.lon <= 180) {
            return true;
        }
        if (udid !== this._selectedUdid) return false;
        var lat = parseFloat((document.getElementById("latInput") || {}).value);
        var lon = parseFloat((document.getElementById("lonInput") || {}).value);
        return !isNaN(lat) && !isNaN(lon)
            && lat >= -90 && lat <= 90
            && lon >= -180 && lon <= 180;
    },

    _t: function(key, fallback) {
        if (typeof I18N !== "undefined") return I18N.t(key, fallback);
        return fallback || key;
    },

    initSSE: function() {
        var self = this;
        if (self.eventSource) self.eventSource.close();
        self.eventSource = new EventSource("/api/device/events");
        self.startLiveCounter();
        self.eventSource.addEventListener("status", function(e) {
            try {
                var data = JSON.parse(e.data);
                self.processStatusEvent(data);
            } catch (err) {}
        });
        self.eventSource.onerror = function() {};
        // Fetch initial status so power button reflects active state immediately
        fetch("/api/device/status", {credentials: "same-origin"})
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(envelope) {
                if (envelope && envelope.data) self.processStatusEvent(envelope.data);
            })
            .catch(function() {});
    },

    scan: async function() {
        var self = this;
        if (self._scanning) return;
        self._scanning = true;
        var rescan = document.getElementById("rescanBtn");
        var scanEmpty = document.getElementById("scanEmpty");
        var scanResult = document.getElementById("scanResult");
        var scanSummary = document.getElementById("scanSummary");
        var scanHead = document.getElementById("scanHead");
        var scanSpin = document.getElementById("scanSpin");
        var scanProgress = document.getElementById("scanProgress");
        var scanBar = document.getElementById("scanBar");
        var deviceList = document.getElementById("deviceList");

        if (rescan) rescan.classList.add("spin");
        if (scanSpin) scanSpin.style.display = "inline-block";
        if (scanHead) scanHead.textContent = self._t("scanning_devices", "Scanning…");
        if (scanEmpty) scanEmpty.style.display = "flex";
        var scanMini = document.querySelector("#scanEmpty .scan-mini");
        if (scanMini) scanMini.style.display = (self.devices && self.devices.length) ? "none" : "flex";
        if (scanResult) scanResult.style.display = "none";
        if (scanProgress) scanProgress.style.display = "block";
        if (scanBar) scanBar.style.width = "0%";
        var scanStartedAt = Date.now();
        var progressIv = setInterval(function() {
            var elapsed = Date.now() - scanStartedAt;
            var pct = Math.min(90, 90 * (1 - Math.exp(-elapsed / 5000)));
            if (scanBar) scanBar.style.width = pct + "%";
        }, 100);
        self._scanProgressIv = progressIv;
        var MIN_SCAN_MS = 600;

        try {
            var scanRes = await fetch("/api/device/scan");
            var scanJson = await scanRes.json();
            if (scanJson.status !== "ok") throw new Error(scanJson.message || "Scan failed");
            var data = scanJson.data || [];
            var missingData = scanJson.missing || [];
            var silentDevices = data.filter(function(d) { return d.bonjour_silent; });
            var normalDevices = data.filter(function(d) { return !d.bonjour_silent; });
            self.devices = normalDevices;

            var hint = document.getElementById("bonjourSilentHint");
            if (hint) {
                if (silentDevices.length > 0) {
                    var names = silentDevices.map(function(d) { return d.name; }).join(", ");
                    var tmpl = self._t("device_bonjour_silent_hint",
                        "Device {names} not detected. Try rebooting the iPhone.");
                    hint.textContent = tmpl.replace("{names}", names);
                    hint.hidden = false;
                } else { hint.hidden = true; }
            }

            normalDevices.forEach(function(d) {
                if (d.ios_untested && !self._iosWarningShown[d.udid]) {
                    self._iosWarningShown[d.udid] = true;
                    App.toast(self._t("err_ios_untested", "iOS version not yet verified"), true);
                }
            });

            self.devices = normalDevices;
            self._cleanupOrphanSessions(normalDevices);
            self.renderDeviceList(normalDevices);
            self._syncMapMarkers();
            var hasCards = normalDevices.length > 0;
            if (scanEmpty) scanEmpty.style.display = hasCards ? "none" : "flex";
            if (scanResult && hasCards) {
                scanResult.style.display = "flex";
                scanSummary.textContent = normalDevices.length + " " +
                    self._t("devices_found", "devices");
            }
            if (self._scanToastEnabled !== false) {
                if (hasCards) {
                    var summaryToast = normalDevices.length + " "
                        + self._t("devices_found", "devices");
                    if (silentDevices.length > 0) {
                        summaryToast += " (+" + silentDevices.length + " "
                            + self._t("silent", "silent") + ")";
                    }
                    App.toast(summaryToast);
                } else {
                    App.toast(self._t("no_devices", "No devices"), true);
                }
            }
            self._scanToastEnabled = true;
            if (deviceList) deviceList.style.display = hasCards ? "flex" : "none";
            if (scanHead && !hasCards && !missingData.length) {
                scanHead.textContent = self._t("no_devices", "No devices");
            }
            self.renderMissing(missingData);
        } catch (e) {
            App.toast(self._t("err_scan_failed", "Scan failed") + ": " + e.message, true);
        } finally {
            var elapsed = Date.now() - scanStartedAt;
            if (elapsed < MIN_SCAN_MS) {
                await new Promise(function(r) { setTimeout(r, MIN_SCAN_MS - elapsed); });
            }
            if (self._scanProgressIv) { clearInterval(self._scanProgressIv); self._scanProgressIv = null; }
            if (scanBar) {
                scanBar.style.width = "100%";
                setTimeout(function() {
                    if (scanProgress) scanProgress.style.display = "none";
                    if (scanBar) scanBar.style.width = "0%";
                    var scanMiniRestore = document.querySelector("#scanEmpty .scan-mini");
                    if (scanMiniRestore) scanMiniRestore.style.display = "flex";
                    if (scanEmpty && self.devices && self.devices.length) {
                        scanEmpty.style.display = "none";
                    }
                }, 350);
            }
            if (rescan) rescan.classList.remove("spin");
            if (scanSpin) scanSpin.style.display = "none";
            self._scanning = false;
        }
    },

    renderDeviceList: function(devices) {
        var container = document.getElementById("deviceList");
        if (!container) return;
        var html = "";
        var self = this;
        // Auto-select first active/reconnecting device if none selected yet — visual highlight
        if (!self._selectedUdid) {
            var firstActive = devices.find(function(d) {
                var s = self._lastSessions ? self._lastSessions[d.udid] : null;
                return self._isUdidActive(s) || self._isUdidReconnecting(s);
            });
            if (firstActive) {
                self._selectedUdid = firstActive.udid;
                self._selectedName = firstActive.name;
            }
        }
        devices.forEach(function(d) {
            var session = self._lastSessions ? self._lastSessions[d.udid] : null;
            var state = self._stateOf(session);
            var isActive = state === "active";
            var isReconn = state === "reconnecting";
            var isConnecting = state === "connecting";
            var isDeact = state === "deactivating";
            var isError = state === "error";

            var cls = "dev";
            if (d.udid === self._selectedUdid) cls += " selected";
            cls += " state-" + state;
            if (state === "idle") cls += " off";
            if (isReconn) cls += " reconn";
            if (isConnecting) cls += " connecting";
            if (isDeact) cls += " deact";
            if (isError) cls += " err";

            var dotCls = "dev-dot";
            if (isActive) dotCls += " on";
            else if (isReconn || isConnecting) dotCls += " warn";
            else if (isDeact || isError) dotCls += " err";

            var rawConn = (d.connection || "").toUpperCase();
            var conn = rawConn === "NETWORK" ? "WIFI" : rawConn;

            var lat = session && session.lat;
            var lon = session && session.lon;
            var preview = self._previewLocationName[d.udid];
            var previewCoord = self._previewLocationCoord[d.udid];
            var hasSession = !!session;
            var locName = preview
                || (session && session.location_name)
                || (hasSession ? d.location_name : null)
                || null;
            var coordLat = previewCoord ? previewCoord.lat : (lat != null ? lat : null);
            var coordLon = previewCoord ? previewCoord.lon : (lon != null ? lon : null);
            var coordTxt = (coordLat != null && coordLon != null)
                ? coordLat.toFixed(5) + ", " + coordLon.toFixed(5)
                : "";
            if (!locName && coordTxt) locName = coordTxt;

            var upTxt = "";
            if (isReconn) {
                var n = session && session.retry_count;
                var maxR = self.MAX_RETRY_DISPLAY || 5;
                upTxt = (n != null && n > 0)
                    ? "retry " + Math.min(n, maxR) + "/" + maxR
                    : "retry…";
            } else if (isActive) {
                upTxt = session && session.spoof_started_at
                    ? self._fmtElapsedHMS(session.spoof_started_at)
                    : "00:00:00";
            } else if (isConnecting) {
                upTxt = self._t("status_connecting", "connecting…");
            } else if (isDeact) {
                upTxt = self._t("status_deactivating", "stopping…");
            } else if (isError) {
                upTxt = self._t("status_error", "error");
            }

            var actTxt = "";
            if (isReconn) {
                var rstart = session && session.disconnect_started_at;
                if (rstart) actTxt = self._fmtElapsedMS(rstart);
            } else if (isActive) {
                var formatted = self._fmtConnectDuration(session && session.connect_duration);
                if (formatted) actTxt = formatted;
            } else if (isConnecting) {
                var cStart = session && session.connect_started_at;
                if (cStart) {
                    var cEla = Math.max(0, Date.now() / 1000 - cStart);
                    actTxt = cEla.toFixed(1) + "s";
                }
            } else if (isDeact) {
                var dStart = session && session._deactivating_at;
                if (dStart) {
                    var dEla = Math.max(0, Date.now() / 1000 - dStart);
                    actTxt = dEla.toFixed(1) + "s";
                }
            }

            var togCls = "tgl" + (isActive || isReconn || isConnecting || isDeact ? " on" : "");
            var idleNoCoord = (state === "idle") && !self._hasValidCoordFor(d.udid);
            if (idleNoCoord) togCls += " no-coord";
            var isBusy = isConnecting || isDeact || isReconn;
            var togDisabled = (isConnecting || isDeact) ? " disabled" : "";

            var ownerId = session && session.activated_by_user_id;
            var ownerName = session && session.activated_by_username;
            var u = window.currentUser;
            var ownedByOther = false;
            if (ownerId && u && ownerId !== u.user_id && u.role !== "client_admin") {
                ownedByOther = true;
                togCls += " owned-other";
                togDisabled = " disabled";
            }

            var togBusy = isBusy ? ' data-busy="true"' : "";
            var togTitle = "";
            if (ownedByOther) togTitle = self._t("device_in_use_by", "In use by ") + (ownerName || "another user");
            else if (isConnecting) togTitle = self._t("status_connecting", "Connecting…");
            else if (isDeact) togTitle = self._t("status_deactivating", "Stopping…");
            else if (isReconn) togTitle = self._t("status_reconnecting", "Reconnecting…");
            else if (idleNoCoord) togTitle = self._t("pick_location_first_short", "Pick a location first");

            var attribBadge = "";
            if (ownedByOther) {
                attribBadge = '<span class="dev-badge attrib" title="'
                    + escapeHtml(ownerName || "")
                    + '">' + escapeHtml((self._t("by_label", "by ")) + (ownerName || "")) + '</span>';
            }

            var displayName = self._displayDeviceName(d);
            var displayModel = self._displayDeviceModel(d);
            html += '<div class="' + cls + (ownedByOther ? " owned-other" : "") + '" data-udid="' + d.udid + '" onclick="Device.selectDevice(\'' + d.udid + '\')">'
                + '<div class="dev-head">'
                  + '<span class="' + dotCls + '"></span>'
                  + '<span class="dev-name" title="' + escapeHtml(displayName) + '">' + escapeHtml(displayName) + '</span>'
                  + '<span class="dev-badge">' + conn + '</span>'
                  + attribBadge
                  + '<button class="' + togCls + '" data-tgl' + togDisabled + togBusy
                    + (togTitle ? ' title="' + togTitle + '" aria-label="' + togTitle + '"' : '')
                    + ' onclick="event.stopPropagation();Device.toggleFromCard(\'' + d.udid + '\')"></button>'
                + '</div>'
                + (displayModel ? '<div class="dev-model">' + escapeHtml(displayModel) + '</div>' : '')
                + (locName ? '<div class="dev-loc">' + escapeHtml(locName) + '</div>' : '')
                + '<div class="dev-foot">'
                  + '<span class="mono coord">' + escapeHtml(coordTxt) + '</span>'
                  + (upTxt ? '<span class="mono up">' + escapeHtml(upTxt) + '</span>' : '')
                  + (actTxt ? '<span class="mono act">' + escapeHtml(actTxt) + '</span>' : '')
                + '</div>'
                + '</div>';
        });
        container.innerHTML = html;
    },

    _fmtElapsedHMS: function(startedAt) {
        if (!startedAt) return "00:00:00";
        var sec = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
        var h = String(Math.floor(sec / 3600)).padStart(2, "0");
        var m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
        var s = String(sec % 60).padStart(2, "0");
        return h + ":" + m + ":" + s;
    },

    _fmtElapsedMS: function(startedAt) {
        if (!startedAt) return "—";
        var sec = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
        var m = String(Math.floor(sec / 60)).padStart(2, "0");
        var s = String(sec % 60).padStart(2, "0");
        return m + ":" + s;
    },

    _fmtShortElapsed: function(startedAt) {
        if (!startedAt) return "—";
        var sec = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
        if (sec < 60) return sec + "s";
        if (sec < 3600) return Math.floor(sec / 60) + "m";
        if (sec < 86400) return Math.floor(sec / 3600) + "h";
        return Math.floor(sec / 86400) + "d";
    },

    _isUdidReconnecting: function(s) {
        return !!(s && (
            s.is_reconnecting === true
            || s.status === "reconnecting"
            || s.connection_status === "reconnecting"
        ));
    },

    _isUdidConnecting: function(s) {
        if (!s) return false;
        var cs = s.connection_status || "";
        var st = s.status || "";
        return cs.indexOf("connecting") === 0 || st.indexOf("connecting") === 0;
    },

    _isUdidDeactivating: function(s) {
        if (!s) return false;
        return s.connection_status === "deactivating" || s.status === "deactivating";
    },

    _isUdidError: function(s) {
        if (!s) return false;
        var cs = s.connection_status || "";
        return cs.indexOf("error") === 0;
    },

    _stateOf: function(s) {
        if (!s) return "idle";
        if (this._isUdidDeactivating(s)) return "deactivating";
        if (this._isUdidReconnecting(s)) return "reconnecting";
        if (this._isUdidError(s)) return "error";
        if (this._isUdidActive(s)) return "active";
        if (this._isUdidConnecting(s)) return "connecting";
        return "idle";
    },

    selectDevice: function(udid) {
        this._selectedUdid = udid;
        var d = this.devices.find(function(x) { return x.udid === udid; });
        this._selectedName = d ? d.name : null;
        var latIn = document.getElementById("latInput");
        var lonIn = document.getElementById("lonInput");
        if (latIn && lonIn && !latIn.readOnly) {
            var pCoord = this._previewLocationCoord[udid];
            var session = this._lastSessions[udid];
            if (pCoord && pCoord.lat != null && pCoord.lon != null) {
                latIn.value = Number(pCoord.lat).toFixed(8);
                lonIn.value = Number(pCoord.lon).toFixed(8);
                if (typeof GMap !== "undefined" && GMap.setPin) {
                    GMap.setPin(pCoord.lat, pCoord.lon);
                    GMap.flyTo(pCoord.lat, pCoord.lon);
                }
            } else if (session && session.lat != null && session.lon != null) {
                latIn.value = Number(session.lat).toFixed(8);
                lonIn.value = Number(session.lon).toFixed(8);
            } else {
                latIn.value = "";
                lonIn.value = "";
            }
        }
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
        this._syncMapMarkers();
        var bottomRow = document.getElementById("bottomRow");
        if (bottomRow) bottomRow.style.display = "flex";
        this.recomputeSelectedState();
    },

    toggleFromCard: function(udid) {
        var sess = this._lastSessions[udid];
        var state = this._stateOf(sess);
        if (state === "connecting" || state === "deactivating") return;
        if (state === "active" || state === "reconnecting") {
            this.deactivate(udid);
        } else {
            this._selectedUdid = udid;
            var lat = parseFloat(document.getElementById("latInput").value);
            var lon = parseFloat(document.getElementById("lonInput").value);
            if (isNaN(lat) || isNaN(lon)) {
                App.toast(this._t("toast_pick_location_first", "Pick a location first"), true);
                return;
            }
            this.activate(udid, lat, lon);
        }
    },

    _applyOptimisticConnecting: function(udid, lat, lon) {
        var dev = this.devices.find(function(d){return d.udid===udid;});
        var existing = this._lastSessions[udid] || {};
        var locName = existing.location_name || (this._previewLocationName && this._previewLocationName[udid]);
        if (!locName) {
            var resolved = this._resolveLocationName ? this._resolveLocationName(lat, lon) : null;
            if (resolved) locName = resolved;
        }
        var nowSec = Date.now() / 1000;
        this._lastSessions[udid] = Object.assign({}, existing, {
            udid: udid,
            name: existing.name || (dev ? dev.name : udid.slice(0, 12)),
            lat: lat,
            lon: lon,
            connection_status: "connecting",
            status: "connecting",
            connect_started_at: nowSec,
            connect_elapsed: 0,
            location_name: locName || existing.location_name,
            _optimistic: true,
            _optimistic_at: nowSec,
        });
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
        this.recomputeSelectedState();
    },

    _applyOptimisticActive: function(udid, lat, lon, data) {
        var dev = this.devices.find(function(d){return d.udid===udid;});
        var existing = this._lastSessions[udid] || {};
        var locName = (data && data.location_name)
            || existing.location_name
            || (this._previewLocationName && this._previewLocationName[udid]);
        if (!locName) {
            var resolved = this._resolveLocationName ? this._resolveLocationName(lat, lon) : null;
            if (resolved) locName = resolved;
        }
        var nowSec = Date.now() / 1000;
        var connectStarted = existing.connect_started_at || nowSec;
        var connectDuration = (data && data.connect_duration != null)
            ? data.connect_duration
            : Math.max(0, nowSec - connectStarted);
        this._lastSessions[udid] = Object.assign({}, existing, {
            udid: udid,
            name: existing.name || (data && data.name) || (dev ? dev.name : udid.slice(0, 12)),
            lat: lat,
            lon: lon,
            connection_status: "active",
            status: "active",
            is_active: true,
            is_simulating: true,
            spoof_started_at: nowSec,
            connect_started_at: connectStarted,
            connect_duration: connectDuration,
            location_name: locName || existing.location_name,
            _optimistic: true,
            _optimistic_at: nowSec,
        });
        if (dev) dev.active = true;
        if (this._lastToastedState) this._lastToastedState[udid] = "active";
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
        this._syncMapMarkers();
        this.recomputeSelectedState();
    },

    _applyOptimisticDeactivating: function(udid) {
        var existing = this._lastSessions[udid] || {};
        var nowSec = Date.now() / 1000;
        this._lastSessions[udid] = Object.assign({}, existing, {
            udid: udid,
            connection_status: "deactivating",
            status: "deactivating",
            _deactivating_at: nowSec,
            _optimistic: true,
            _optimistic_at: nowSec,
        });
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
        this.recomputeSelectedState();
    },

    _rollbackOptimistic: function(udid, snapshot) {
        if (snapshot) this._lastSessions[udid] = snapshot;
        else delete this._lastSessions[udid];
        this.renderDeviceList(this.devices);
        this._refreshTargetCard();
        this.recomputeSelectedState();
    },

    activate: async function(udid, lat, lon) {
        var self = this;
        var snapshot = self._lastSessions[udid] ? Object.assign({}, self._lastSessions[udid]) : null;
        self._applyOptimisticConnecting(udid, lat, lon);
        var doActivate = async function() {
            var data = await App.api("POST", "/api/device/activate", {
                udid: udid, lat: lat, lon: lon,
            });
            self._applyOptimisticActive(udid, lat, lon, data);
            App.toast(self._t("toast_location_applied", "Activated") + ": " + data.name);
            GMap.setPinActive();
        };
        try {
            await doActivate();
        } catch (e) {
            if (e && e.error === "DEVICE_IN_USE") {
                self._rollbackOptimistic(udid, snapshot);
                var by = e.active_by_username || self._t("another_user", "another user");
                App.toast(self._t("err_device_in_use", "Device in use by ") + by, true);
                return;
            }
            if (/already.?active/i.test(e.message)) {
                try {
                    await App.api("POST", "/api/device/deactivate", {udid: udid});
                    await new Promise(function(r){setTimeout(r, 500);});
                    await doActivate();
                } catch (e2) {
                    self._rollbackOptimistic(udid, snapshot);
                    App.toast(e2.message, true);
                }
                return;
            }
            self._rollbackOptimistic(udid, snapshot);
            App.toast(e.message, true);
        }
    },

    activateSelected: function() {
        if (!this._selectedUdid) return;
        var lat = parseFloat(document.getElementById("latInput").value);
        var lon = parseFloat(document.getElementById("lonInput").value);
        if (isNaN(lat) || isNaN(lon)) {
            App.toast(this._t("err_invalid_coord", "Invalid coordinates"), true);
            return;
        }
        this.activate(this._selectedUdid, lat, lon);
    },

    deactivate: async function(udid) {
        var self = this;
        var snapshot = self._lastSessions[udid] ? Object.assign({}, self._lastSessions[udid]) : null;
        self._applyOptimisticDeactivating(udid);
        try {
            await App.api("POST", "/api/device/deactivate", { udid: udid });
            App.toast(self._t("toast_stopped", "Deactivated"));
            GMap.setPinInactive();
        } catch (e) {
            self._rollbackOptimistic(udid, snapshot);
            App.toast(self._t("toast_stopped", "Failed") + ": " + e.message, true);
        }
    },

    deactivateAll: async function() {
        var self = this;
        var snapshot = {};
        Object.keys(self._lastSessions).forEach(function(udid){
            snapshot[udid] = Object.assign({}, self._lastSessions[udid]);
            self._applyOptimisticDeactivating(udid);
        });
        try {
            await App.api("POST", "/api/device/deactivate-all");
            App.toast(self._t("toast_stopped", "All deactivated"));
            GMap.setPinInactive();
        } catch (e) {
            self._lastSessions = snapshot;
            self.renderDeviceList(self.devices);
            self._refreshTargetCard();
            self.recomputeSelectedState();
            App.toast(e.message, true);
        }
    },

    _cleanupOrphanSessions: function(scannedDevices) {
        var self = this;
        var sessionMap = self._lastSessions || {};
        var scannedUdids = scannedDevices.map(function(d){return d.udid;});
        Object.keys(sessionMap).forEach(function(udid) {
            if (scannedUdids.indexOf(udid) !== -1) return;
            var s = sessionMap[udid];
            if (!s) return;
            if (self._isUdidActive(s) || self._isUdidReconnecting(s)) {
                return;
            }
            delete sessionMap[udid];
            self._clearActivationDuration(udid);
            if (self._selectedUdid === udid) {
                self._selectedUdid = null;
                self._selectedName = null;
                var br = document.getElementById("bottomRow");
                if (br) br.style.display = "none";
            }
        });
    },

    _isUdidActive: function(s) {
        return !!(s && (
            s.is_active === true
            || s.connection_status === "active"
            || s.is_simulating
            || s.status === "simulating"
            || s.status === "connected"
        ));
    },

    _isSelectedActive: function() {
        if (!this._selectedUdid) return false;
        return this._isUdidActive(this._lastSessions[this._selectedUdid]);
    },

    processStatusEvent: function(data) {
        var sessionMap = data.sessions || {};
        var prev = this._lastSessions || {};
        var nowSec = Date.now() / 1000;
        Object.keys(prev).forEach(function(udid){
            var ps = prev[udid];
            if (!ps) return;
            if (ps._optimistic) {
                var age = nowSec - (ps._optimistic_at || nowSec);
                if (age >= 30) return;
                if (ps.status === "deactivating" || ps.connection_status === "deactivating") {
                    if (sessionMap[udid]) {
                        var ns = sessionMap[udid];
                        var nsCs = ns.connection_status || "";
                        if (nsCs === "reconnecting" || nsCs === "active") {
                            sessionMap[udid] = ps;
                        }
                    } else {
                        return;
                    }
                    return;
                }
                if (!sessionMap[udid]) sessionMap[udid] = ps;
            }
            var newSess = sessionMap[udid];
            if (newSess && ps.connect_started_at != null) {
                var prevConn = (ps.connection_status || "").indexOf("connecting") === 0;
                var newConn = (newSess.connection_status || "").indexOf("connecting") === 0;
                if (prevConn && newConn) {
                    newSess.connect_started_at = ps.connect_started_at;
                }
            }
        });
        var self = this;
        Object.keys(sessionMap).forEach(function(udid){
            var s = sessionMap[udid];
            if (!s) { delete sessionMap[udid]; return; }
            if (s._optimistic) return;
            var deadFlags = s.is_active === false
                || s.connection_status === "inactive"
                || s.is_simulating === false
                || s.status === "inactive"
                || s.status === "stopped";
            var liveFlags = s.is_active === true
                || s.connection_status === "active"
                || s.connection_status === "reconnecting"
                || (s.connection_status || "").indexOf("connecting") === 0
                || s.is_simulating === true
                || s.status === "simulating"
                || s.status === "connected"
                || s.status === "reconnecting"
                || (s.status || "").indexOf("connecting") === 0
                || s.status === "deactivating"
                || s.connection_status === "deactivating";
            if (deadFlags && !liveFlags) {
                delete sessionMap[udid];
            }
        });
        this._lastSessions = sessionMap;
        var keys = Object.keys(sessionMap);

        var allUdids = {};
        Object.keys(prev).forEach(function(u){ allUdids[u] = true; });
        keys.forEach(function(u){ allUdids[u] = true; });
        Object.keys(allUdids).forEach(function(udid){
            var prevState = self._stateOf(prev[udid]);
            var newState = self._stateOf(sessionMap[udid]);
            var lastToasted = self._lastToastedState[udid];
            if (newState === lastToasted) return;
            if (lastToasted === undefined && newState === "idle") {
                self._lastToastedState[udid] = newState;
                return;
            }
            self._emitTransitionToast(udid, prevState, newState, sessionMap[udid] || prev[udid]);
            self._lastToastedState[udid] = newState;
        });

        keys.forEach(function(k) {
            var s = sessionMap[k];
            if (!s || s.lat == null || s.lon == null) return;
            if (s.location_name) return;
            var matched = Device._resolveLocationName(s.lat, s.lon);
            if (matched) s.location_name = matched;
        });

        var unreachableNames = [];
        keys.forEach(function(udid) {
            var s = sessionMap[udid];
            if (s && s.wifi_unreachable) unreachableNames.push(s.name);
        });
        var hint = document.getElementById("wifiUnreachableHint");
        if (hint) {
            if (unreachableNames.length > 0) {
                var tmpl = Device._t("device_wifi_unreachable_hint",
                    "Device \"{names}\" not reachable via WiFi. Reconnect via USB.");
                hint.textContent = tmpl.replace("{names}", unreachableNames.join(", "));
                hint.hidden = false;
            } else { hint.hidden = true; }
        }

        var activeUdids = keys.filter(function(k) { return Device._isUdidActive(sessionMap[k]); });
        var totalActive = activeUdids.length;
        var fsTotal = document.getElementById("fsTotal");
        var fsActive = document.getElementById("fsActive");
        var fsIdle = document.getElementById("fsIdle");
        var deviceCount = Device.devices.length || keys.length;
        if (fsTotal) fsTotal.textContent = deviceCount;
        if (fsActive) fsActive.textContent = totalActive;
        if (fsIdle) fsIdle.textContent = Math.max(0, deviceCount - totalActive);

        Device.devices.forEach(function(d) {
            d.active = Device._isUdidActive(sessionMap[d.udid]);
        });
        Device.renderDeviceList(Device.devices);
        Device._refreshTargetCard();
        Device._syncMapMarkers();
        // Ensure deviceList is visible if we have any cards (covers SSE-only render before scan)
        var deviceListEl = document.getElementById("deviceList");
        if (deviceListEl && Device.devices.length > 0) {
            deviceListEl.style.display = "flex";
        }
        var scanResultEl = document.getElementById("scanResult");
        var scanSummaryEl = document.getElementById("scanSummary");
        if (scanResultEl && Device.devices.length > 0) {
            scanResultEl.style.display = "flex";
            if (scanSummaryEl) {
                scanSummaryEl.textContent = Device.devices.length + " " + Device._t("devices_found", "devices");
            }
        }
        var scanEmptyEl = document.getElementById("scanEmpty");
        // Only show "Scanning..." card if active scan in progress; else hide if we have cards
        if (scanEmptyEl && Device.devices.length > 0 && !Device._scanning) {
            scanEmptyEl.style.display = "none";
        }

        var selectedIsOn = Device._selectedUdid && Device._isUdidActive(sessionMap[Device._selectedUdid]);
        var selectedSession = Device._selectedUdid ? sessionMap[Device._selectedUdid] : null;
        var selectedIsReconn = !!(selectedSession && Device._isUdidReconnecting(selectedSession));
        var selectedName = selectedSession ? selectedSession.name : Device._selectedName;
        var stateSig = (selectedIsOn ? "1" : "0") + (selectedIsReconn ? "r" : "") + ":" + totalActive + ":" + (Device._selectedUdid || "");
        if (Device._lastStateSig !== stateSig) {
            Device._lastStateSig = stateSig;
            Device._lastStatusOn = selectedIsOn;
            Device._lastSessionName = selectedName;
            Device._lastSummary = {
                totalActive: totalActive,
                activeUdids: activeUdids,
                sessionsByUdid: sessionMap,
                selectedUdid: Device._selectedUdid,
                isReconnecting: selectedIsReconn,
            };
            Device._statusCallbacks.forEach(function(cb) {
                try { cb(selectedIsOn, selectedName, Device._lastSummary); } catch (e) {}
            });
        }
    },

    _onStatusChange: function(cb) {
        if (typeof cb !== "function") return;
        Device._statusCallbacks.push(cb);
        if (Device._lastStatusOn !== null) {
            try { cb(Device._lastStatusOn, Device._lastSessionName, Device._lastSummary); } catch (e) {}
        }
    },

    _resolveLocationName: function(lat, lon) {
        var roundKey = function(a, b) {
            return parseFloat(a).toFixed(5) + "," + parseFloat(b).toFixed(5);
        };
        var target = roundKey(lat, lon);
        var picker = document.getElementById("locationPicker");
        if (picker) {
            for (var i = 0; i < picker.options.length; i++) {
                var opt = picker.options[i];
                if (!opt.dataset.lat) continue;
                if (roundKey(opt.dataset.lat, opt.dataset.lon) === target) {
                    return opt.dataset.name || opt.textContent;
                }
            }
        }
        if (typeof Presets !== "undefined" && Presets.list) {
            for (var j = 0; j < Presets.list.length; j++) {
                var p = Presets.list[j];
                if (!p || p.latitude == null) continue;
                if (roundKey(p.latitude, p.longitude) === target) return p.name;
            }
        }
        return null;
    },

    recomputeSelectedState: function() {
        var sess = Device._selectedUdid ? Device._lastSessions[Device._selectedUdid] : null;
        var isOn = Device._isUdidActive(sess);
        var isReconn = Device._isUdidReconnecting(sess);
        var name = sess ? sess.name : Device._selectedName;
        var sessionMap = Device._lastSessions || {};
        var activeUdids = Object.keys(sessionMap).filter(function(k){return Device._isUdidActive(sessionMap[k]);});
        Device._lastStatusOn = isOn;
        Device._lastSessionName = name;
        Device._lastSummary = {
            totalActive: activeUdids.length,
            activeUdids: activeUdids,
            sessionsByUdid: sessionMap,
            selectedUdid: Device._selectedUdid,
            isReconnecting: isReconn,
        };
        Device._statusCallbacks.forEach(function(cb) {
            try { cb(isOn, name, Device._lastSummary); } catch (e) {}
        });
    },

    _refreshTargetCard: function() {
        var udid = Device._selectedUdid;
        if (!udid) return;
        var d = Device.devices.find(function(x) { return x.udid === udid; });
        if (!d) return;
        var session = Device._lastSessions ? Device._lastSessions[udid] : null;
        var state = Device._stateOf(session);
        var isAct = state === "active";
        var isReconn = state === "reconnecting";
        var isConnecting = state === "connecting";
        var isDeact = state === "deactivating";
        var isError = state === "error";

        var card = document.getElementById("targetCard");
        var tn = document.getElementById("targetName");
        var tl = document.getElementById("targetLink");
        var tloc = document.getElementById("targetLoc");
        var tcoord = document.getElementById("targetCoord");
        var tup = document.getElementById("targetUptime");
        var tupLabel = document.getElementById("targetUptimeLabel");
        var tStatStat = document.getElementById("targetStatusStat");
        var tStatLabel = document.getElementById("targetStatusLabel");
        var tStat = document.getElementById("targetStatus");

        if (card) {
            card.classList.toggle("reconn", isReconn);
            card.classList.toggle("connecting", isConnecting);
            card.classList.toggle("deact", isDeact);
            card.classList.toggle("err", isError);
        }

        var spoofBtn = document.getElementById("spoofBtn");
        if (spoofBtn) {
            var transient = isConnecting || isDeact;
            var busyVisual = transient || isReconn;
            var idleNoCoord = state === "idle" && !Device._hasValidCoordFor(udid);
            spoofBtn.disabled = transient;
            spoofBtn.classList.toggle("no-coord", idleNoCoord);
            if (busyVisual) spoofBtn.setAttribute("data-busy", "true");
            else spoofBtn.removeAttribute("data-busy");
            if (isConnecting) {
                spoofBtn.setAttribute("aria-label",
                    Device._t("status_connecting", "Connecting…"));
            } else if (isDeact) {
                spoofBtn.setAttribute("aria-label",
                    Device._t("status_deactivating", "Stopping…"));
            } else if (isReconn) {
                spoofBtn.setAttribute("aria-label",
                    Device._t("status_reconnecting", "Reconnecting…"));
            } else if (idleNoCoord) {
                spoofBtn.setAttribute("aria-label",
                    Device._t("pick_location_first_short", "Pick a location first"));
            } else {
                spoofBtn.setAttribute("aria-label", "Toggle spoof");
            }
        }

        if (tn) tn.textContent = Device._displayDeviceName(d);
        var tModel = document.getElementById("targetModel");
        if (tModel) {
            var model = Device._displayDeviceModel(d);
            if (model) {
                tModel.textContent = model;
                tModel.hidden = false;
            } else {
                tModel.textContent = "";
                tModel.hidden = true;
            }
        }
        var rawConn = (d.connection || "").toUpperCase();
        var conn = rawConn === "NETWORK" ? "WIFI" : rawConn;
        if (tl) tl.textContent = conn || "—";

        var lat = session && session.lat;
        var lon = session && session.lon;
        var preview = Device._previewLocationName[udid];
        var hasSession = !!session;
        var locName = preview
            || (session && session.location_name)
            || (hasSession ? d.location_name : null)
            || (isAct && lat != null && lon != null
                ? Device._t("gps_active", "GPS active") : null)
            || null;

        var pCoord = Device._previewLocationCoord[udid];
        var sLat = session && session.lat;
        var sLon = session && session.lon;
        var cLat = pCoord ? pCoord.lat : (sLat != null ? sLat : null);
        var cLon = pCoord ? pCoord.lon : (sLon != null ? sLon : null);
        var coordTxt = (cLat != null && cLon != null && !isNaN(cLat) && !isNaN(cLon))
            ? Number(cLat).toFixed(8) + ", " + Number(cLon).toFixed(8)
            : "";

        if (tloc) tloc.textContent = locName || "";
        if (tcoord) tcoord.textContent = coordTxt;
        var tcoordWrap = document.querySelector(".target-coord");
        if (tcoordWrap) {
            var hasAnyLoc = !!locName || !!coordTxt;
            tcoordWrap.hidden = !hasAnyLoc;
            tcoordWrap.classList.toggle("only-coord", !locName && !!coordTxt);
            tcoordWrap.classList.toggle("only-loc", !!locName && !coordTxt);
        }

        var T = Device._t;
        if (isReconn) {
            if (tupLabel) tupLabel.textContent = T("label_retry", "RETRY");
            if (tup) {
                var n = session && session.retry_count;
                var maxR = Device.MAX_RETRY_DISPLAY || 5;
                tup.textContent = (n != null && n > 0) ? Math.min(n, maxR) + "/" + maxR : "…";
            }
            if (tStatStat) tStatStat.hidden = false;
            if (tStatLabel) tStatLabel.textContent = T("label_elapsed", "ELAPSED");
            if (tStat) {
                var rstart = session && session.disconnect_started_at;
                tStat.textContent = rstart ? Device._fmtElapsedMS(rstart) : "—";
            }
        } else if (isConnecting) {
            if (tupLabel) tupLabel.textContent = T("label_connect", "CONNECT");
            if (tup) {
                var cStart = session && session.connect_started_at;
                if (cStart) {
                    var cEla = Math.max(0, Date.now()/1000 - cStart);
                    tup.textContent = cEla.toFixed(1) + "s";
                } else {
                    tup.textContent = "…";
                }
            }
            if (tStatStat) tStatStat.hidden = true;
        } else if (isDeact) {
            if (tupLabel) tupLabel.textContent = T("label_stop", "STOP");
            if (tup) {
                var ds = session && session._deactivating_at;
                if (ds) {
                    var de = Math.max(0, Date.now()/1000 - ds);
                    tup.textContent = de.toFixed(1) + "s";
                } else {
                    tup.textContent = "…";
                }
            }
            if (tStatStat) tStatStat.hidden = true;
        } else if (isError) {
            if (tupLabel) tupLabel.textContent = T("label_status", "STATUS");
            if (tup) tup.textContent = T("status_error", "error");
            if (tStatStat) tStatStat.hidden = true;
        } else {
            if (tupLabel) tupLabel.textContent = T("label_uptime", "UPTIME");
            if (tStatStat) tStatStat.hidden = true;
            if (tup) {
                if (isAct) {
                    var spStart = session && session.spoof_started_at;
                    tup.textContent = spStart ? Device._fmtElapsedHMS(spStart) : "00:00:00";
                } else {
                    tup.textContent = "--";
                }
            }
        }
    },

    startLiveCounter: function() {
        if (Device._counterInterval) return;
        Device._counterInterval = setInterval(function() {
            Device._tickDevCardTimers();
        }, 1000);
    },

    _tickDevCardTimers: function() {
        var now = Math.floor(Date.now() / 1000);
        var container = document.getElementById("deviceList");
        if (container) {
            var cards = container.querySelectorAll(".dev");
            cards.forEach(function(card) {
                var udid = card.getAttribute("data-udid");
                var session = Device._lastSessions ? Device._lastSessions[udid] : null;
                if (!session) return;
                var upEl = card.querySelector(".dev-foot .up");
                var actEl = card.querySelector(".dev-foot .act");
                if (card.classList.contains("reconn")) {
                    if (actEl && session.disconnect_started_at) {
                        actEl.textContent = Device._fmtElapsedMS(session.disconnect_started_at);
                    }
                } else if (card.classList.contains("connecting")) {
                    if (actEl && session.connect_started_at) {
                        var elapsed = Math.max(0, now - session.connect_started_at);
                        actEl.textContent = elapsed.toFixed(1) + "s";
                    }
                } else if (card.classList.contains("deact")) {
                    if (actEl && session._deactivating_at) {
                        var dEla = Math.max(0, now - session._deactivating_at);
                        actEl.textContent = dEla.toFixed(1) + "s";
                    }
                } else if (card.classList.contains("state-active")) {
                    if (upEl && session.spoof_started_at) {
                        upEl.textContent = Device._fmtElapsedHMS(session.spoof_started_at);
                    }
                    if (actEl) {
                        var fmt = Device._fmtConnectDuration(session.connect_duration);
                        if (fmt && actEl.textContent !== fmt) actEl.textContent = fmt;
                    }
                }
            });
        }

        var udidSel = Device._selectedUdid;
        if (udidSel) {
            var sess = Device._lastSessions ? Device._lastSessions[udidSel] : null;
            if (sess) {
                if (Device._isUdidReconnecting(sess)) {
                    var tStatR = document.getElementById("targetStatus");
                    if (tStatR && sess.disconnect_started_at) {
                        tStatR.textContent = Device._fmtElapsedMS(sess.disconnect_started_at);
                    }
                } else if (Device._isUdidConnecting(sess)) {
                    var tupC = document.getElementById("targetUptime");
                    if (tupC && sess.connect_started_at) {
                        var elaC = Math.max(0, now - sess.connect_started_at);
                        tupC.textContent = elaC.toFixed(1) + "s";
                    }
                } else if (Device._isUdidDeactivating(sess)) {
                    var tupD = document.getElementById("targetUptime");
                    if (tupD && sess._deactivating_at) {
                        var elaD = Math.max(0, now - sess._deactivating_at);
                        tupD.textContent = elaD.toFixed(1) + "s";
                    }
                } else if (Device._isUdidActive(sess)) {
                    var tup2 = document.getElementById("targetUptime");
                    if (tup2 && sess.spoof_started_at) {
                        tup2.textContent = Device._fmtElapsedHMS(sess.spoof_started_at);
                    }
                }
            }
        }
    },
};

function escapeHtml(str) {
    return String(str || "").replace(/&/g, "&amp;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
