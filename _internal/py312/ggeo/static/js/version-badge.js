// Fetch app version from /api/version and set textContent on all .version elements.
(function () {
    "use strict";
    fetch("/api/version")
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!data || !data.version) return;
            var els = document.querySelectorAll(".version");
            for (var i = 0; i < els.length; i++) {
                els[i].textContent = "v" + data.version;
            }
        })
        .catch(function () {});
})();
