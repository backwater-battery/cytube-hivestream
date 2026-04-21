// cytube-hook-framework-0.00.01.js

(function () {
    if (window.CHF) return; // prevent double load

    const CHF = {};
    window.CHF = CHF;

    CHF.version = "0.00.01";

    // =========================
    // MOBILE DEBUG LOGGER
    // =========================
    CHF.log = function (...args) {
        console.log("[CHF]", ...args);

        const el = document.getElementById("chf-log");
        if (!el) return;

        const line = document.createElement("div");
        line.textContent = args.map(a => {
            try { return typeof a === "object" ? JSON.stringify(a) : a; }
            catch { return "[object]"; }
        }).join(" ");

        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    };

    CHF.initUI = function () {
        if (document.getElementById("chf-container")) return;

        const container = document.createElement("div");
        container.id = "chf-container";
        container.style = `
            position:fixed;
            bottom:0;
            left:0;
            width:100%;
            max-height:30%;
            background:black;
            color:#0f0;
            font-size:10px;
            overflow:auto;
            z-index:999999;
            padding:5px;
        `;

        const header = document.createElement("div");
        header.textContent = "CHF v" + CHF.version + " (tap to toggle)";
        header.style = "color:white;cursor:pointer;font-weight:bold;";
        container.appendChild(header);

        const log = document.createElement("div");
        log.id = "chf-log";
        container.appendChild(log);

        header.onclick = () => {
            log.style.display = log.style.display === "none" ? "block" : "none";
        };

        document.body.appendChild(container);
    };

    // =========================
    // SOCKET HOOKING
    // =========================
    CHF.hookSocket = function () {
        if (!window.socket) {
            CHF.log("socket not ready, retrying...");
            return setTimeout(CHF.hookSocket, 1000);
        }

        if (socket._chfHooked) return;
        socket._chfHooked = true;

        CHF.log("Hooking socket...");

        // OUTGOING
        const originalEmit = socket.emit;
        socket.emit = function (event, data) {
            CHF.log("→ emit:", event, data);
            return originalEmit.apply(this, arguments);
        };

        // INCOMING
        const originalOn = socket.on;
        socket.on = function (event, handler) {
            const wrapped = function (data) {
                CHF.log("← on:", event, data);
                return handler.apply(this, arguments);
            };
            return originalOn.call(this, event, wrapped);
        };

        CHF.log("Socket hooked");
    };

    // =========================
    // CALLBACK HOOKING
    // =========================
    CHF.hookCallbacks = function () {
        if (!window.Callbacks) {
            CHF.log("Callbacks not ready, retrying...");
            return setTimeout(CHF.hookCallbacks, 1000);
        }

        if (Callbacks._chfHooked) return;
        Callbacks._chfHooked = true;

        CHF.log("Hooking Callbacks...");

        Object.keys(Callbacks).forEach(key => {
            const original = Callbacks[key];

            if (typeof original !== "function") return;

            Callbacks[key] = function (data) {
                CHF.log("CB:", key, data);
                return original.apply(this, arguments);
            };
        });

        CHF.log("Callbacks hooked");
    };

    // =========================
    // PLAYER HOOKING
    // =========================
    CHF.hookPlayer = function () {
        if (!window.PLAYER) {
            CHF.log("PLAYER not ready, retrying...");
            return setTimeout(CHF.hookPlayer, 1000);
        }

        if (PLAYER._chfHooked) return;
        PLAYER._chfHooked = true;

        CHF.log("Hooking PLAYER...");

        ["play", "pause", "seekTo", "load"].forEach(fn => {
            if (typeof PLAYER[fn] !== "function") return;

            const original = PLAYER[fn];

            PLAYER[fn] = function () {
                CHF.log("PLAYER:", fn, arguments);
                return original.apply(this, arguments);
            };
        });

        CHF.log("PLAYER hooked");
    };

    // =========================
    // INIT
    // =========================
    CHF.init = function () {
        CHF.initUI();
        CHF.hookSocket();
        CHF.hookCallbacks();
        CHF.hookPlayer();

        CHF.log("Initialized");
    };

    // Start after DOM ready
    if (document.readyState === "complete") {
        CHF.init();
    } else {
        window.addEventListener("load", CHF.init);
    }

})();
