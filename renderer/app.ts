// Extracted from index.html so the CSP can drop script-src 'unsafe-inline'.
// With inline script disallowed, an HTML-escaping slip becomes a cosmetic
// glitch instead of arbitrary code execution.
import type {
  ActiveBump,
  ConnectionState,
  ConnectionStatus,
  OpacityLevel,
  Scan,
  ViewerApi,
} from "../contracts";

declare global {
  interface Window {
    milf: ViewerApi;
  }
}

(function () {
  "use strict";
  interface Elements {
    server: HTMLInputElement;
    code: HTMLInputElement;
    pairBtn: HTMLButtonElement;
    opBtn: HTMLButtonElement;
    quitBtn: HTMLButtonElement;
    pairCancel: HTMLButtonElement;
    detailClose: HTMLButtonElement;
    repairBtn: HTMLButtonElement;
    clipBtn: HTMLButtonElement;
    clearBtn: HTMLButtonElement;
    detailTitle: HTMLElement;
    detailBody: HTMLElement;
    detail: HTMLElement;
    list: HTMLElement;
    dot: HTMLElement;
    status: HTMLElement;
    pair: HTMLElement;
    pairErr: HTMLElement;
  }

  function $<K extends keyof Elements>(id: K): Elements[K] {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing renderer element #${id}`);
    return element as Elements[K];
  }

  var scans: Scan[] = [];

  function esc(s: unknown): string {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c;
    });
  }
  function isk(n: number | null | undefined): string | null {
    if (n == null || isNaN(n)) return null;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
    return Math.round(n).toLocaleString();
  }
  function ehpFmt(n: number | null | undefined): string | null {
    if (n == null || isNaN(n)) return null;
    return n >= 1e6 ? (n / 1e6).toFixed(2) + "m" : (n / 1e3).toFixed(0) + "k";
  }
  // Value tier drives the colour, so a 3B target is distinguishable from a
  // 200M one without reading the number.
  function tier(v: number | null | undefined): string {
    if (v == null) return "t1";
    if (v >= 3e9) return "t4";
    if (v >= 1e9) return "t3";
    if (v >= 5e8) return "t2";
    return "t1";
  }
  function ageText(ms: number): string {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  function openDetail(id: string | null): void {
    var s = scans.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    $("detailTitle").textContent = (s.hull || "Unknown") + "  \u00B7  " + (s.system || "?");
    var h = "";
    var kv = function (k: string, v: string | null | undefined): string {
      return v ? '<div class="kv"><b>' + k + '</b>' + esc(v) + "</div>" : "";
    };
    h += kv("Scout", s.scout);
    h += kv("Pilot", s.pilot);
    h += kv("Route", [s.scanGate ? s.scanGate + " gate" : null,
                      s.headGate ? "\u2192 " + s.headGate : null].filter(Boolean).join("  "));
    h += kv("Value", [isk(s.valueSplit) ? isk(s.valueSplit) + " split" : null,
                      isk(s.valueSell) ? isk(s.valueSell) + " sell" : null,
                      isk(s.valueBuy) ? isk(s.valueBuy) + " buy" : null].filter(Boolean).join("  /  "));
    h += kv("Droppable", isk(s.droppableSplit) ? isk(s.droppableSplit) + " split" : "");
    h += kv("Tank", ehpFmt(s.ehp) ? ehpFmt(s.ehp) + " EHP" + (s.ammo ? " vs " + s.ammo : "") : "");
    var fleetAll = s.fleetAll || [];
    if (fleetAll.length) {
      h += "<h3>Fleet needed" + (s.sec ? " \u2014 " + esc(s.sec) + ", " + esc(s.prepped || "") : "") + "</h3>";
      h += "<pre>" + fleetAll.map(function (f) {
        // Both halves escaped. f.ships is server-controlled like everything
        // else here - it is a number in practice, but "in practice" is not a
        // security boundary.
        return esc(String(f.name).padEnd(9)) + esc(String(f.ships).padStart(4));
      }).join("\n") + "</pre>";
    }
    if (s.fitEft) h += "<h3>Fit \u2014 paste into Pyfa</h3><pre>" + esc(s.fitEft) + "</pre>";
    var cargoList = s.cargoList || [];
    if (cargoList.length) {
      h += "<h3>Cargo</h3><pre>" + cargoList.map(function (c) {
        return String(Number(c.qty).toLocaleString()).padStart(11) + "  " + esc(c.name);
      }).join("\n") + "</pre>";
    }
    if (s.notes) h += "<h3>Notes</h3><pre>" + esc(s.notes) + "</pre>";
    if (!s.fitEft && !(s.cargoList || []).length) {
      h += '<h3>Fit &amp; cargo</h3><div class="kv" style="color:var(--dim)">' +
           "Not included in this scan.</div>";
    }
    $("detailBody").innerHTML = h;
    $("detail").className = "show";
  }

  function render(): void {
    var list = $("list");
    if (!scans.length) {
      list.innerHTML = '<div class="empty">Waiting for scans&hellip;</div>';
      return;
    }
    list.innerHTML = scans.map(function (s) {
      var sell = isk(s.valueSell);
      var ehp = ehpFmt(s.ehp);
      var fleet = (s.fleetAll || []).slice(0, 4)
        .map(function (f) { return "<b>" + esc(f.ships) + "</b> " + esc(f.name); }).join("  ");
      var route = [s.scanGate ? esc(s.scanGate) + " gate" : null,
                   s.headGate ? "\u2192 " + esc(s.headGate) : null].filter(Boolean).join("  ");
      // s.at is coerced to a number rather than escaped: it is only ever read
      // back with Number(), so anything non-numeric is meaningless here and
      // coercion removes the attribute-escape risk outright.
      return '<div class="scan" data-at="' + (Number(s.at) || 0) + '" data-id="' + esc(s.id) + '">' +
        '<div class="row1">' +
          '<span class="hull">' + esc(s.hull || "Unknown") + '</span>' +
          (s.pilot ? '<span class="pilot">(' + esc(s.pilot) + ')</span>' : "") +
          '<span class="age">&mdash;</span>' +
          '<button class="bumpbtn" data-bump="' + esc(s.id) + '" title="Start or refresh the bump timer">BUMP</button>' +
        '</div>' +
        '<div class="bumprow" data-bumprow="' + esc(s.id) + '" style="display:none">' +
          '<span class="bumpleft">&mdash;</span>' +
          '<span class="bumpbar"><i style="width:100%"></i></span>' +
          '<span class="bumpwho"></span>' +
        '</div>' +
        '<div class="row2">' +
          (sell ? '<span class="val ' + tier(s.valueSell) + '">' + sell + '</span>' : "") +
          (ehp ? '<span class="ehp">' + ehp + ' EHP' + (s.ammo ? " vs " + esc(s.ammo) : "") + '</span>' : "") +
        '</div>' +
        (fleet ? '<div class="fleet">' + fleet + "</div>" : "") +
        (route ? '<div class="meta">' + route + "</div>" : "") +
        '<div class="meta">' + esc(s.scout || "?") +
          (s.system ? " \u00B7 scanned in " + esc(s.system) : "") +
          (s.sec ? " \u00B7 " + esc(s.sec) + " " + esc(s.prepped || "") : "") + '</div>' +
        (s.notes ? '<div class="notes">' + esc(s.notes) + "</div>" : "") +
      "</div>";
    }).join("");
    list.querySelectorAll<HTMLElement>(".scan").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target instanceof Element && e.target.hasAttribute("data-bump")) return;   // the button is not the row
        openDetail(el.getAttribute("data-id"));
      });
    });
    list.querySelectorAll<HTMLElement>("[data-bump]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        sendBump(el.getAttribute("data-bump"));
      });
    });
    paintBumps();     // a re-render must restore any running timers
    tick();
  }

  // Ages count up live - the thing you actually want to know at a glance is
  // how stale the intel is, and a fixed timestamp makes you do arithmetic.
  function tick(): void {
    var now = Date.now();
    document.querySelectorAll<HTMLElement>(".scan").forEach(function (el) {
      var age = now - Number(el.getAttribute("data-at"));
      var span = el.querySelector<HTMLElement>(".age");
      if (!span) return;
      span.textContent = ageText(age);
      span.className = "age" + (age > 15 * 60e3 ? " dead" : age > 5 * 60e3 ? " stale" : "");
    });
  }
  setInterval(tick, 1000);

  function setStatus(s: ConnectionStatus): void {
    var dot = $("dot"), bar = $("status");
    var map: Record<ConnectionState, string> = { live: "live", connecting: "warn", reconnecting: "warn", offline: "bad",
              error: "bad", unpaired: "", clip: "live", warn: "warn" };
    dot.className = "dot " + (map[s.state] || "");
    if (s.state === "live") { bar.className = "hidden"; }
    else if (s.state === "clip" || s.state === "warn") {
      bar.className = "";
      bar.textContent = s.detail || "";
    }
    else {
      bar.className = "";
      bar.textContent = ({
        connecting: "Connecting\u2026",
        reconnecting: "Connection lost \u2014 retrying in " + (s.detail || "a moment"),
        offline: "Can't reach the dashboard" + (s.detail ? " (" + s.detail + ")" : ""),
        error: s.detail || "Error",
        unpaired: s.detail || "Not paired",
      clip: s.detail || "clipboard sent",
      warn: s.detail || ""
      })[s.state] || s.state;
    }
    if (s.state === "unpaired") showPair(true);
  }

  function showPair(on: boolean): void {
    $("pair").className = on ? "show" : "";
    $("list").style.display = on ? "none" : "";
  }

  $("pairBtn").addEventListener("click", function () {
    var btn = $("pairBtn");
    var server = $("server").value.trim();
    var code = $("code").value.trim();
    if (!server || !code) { $("pairErr").textContent = "Both fields are needed."; return; }
    btn.disabled = true; btn.textContent = "Pairing\u2026";
    $("pairErr").textContent = "";
    window.milf.pair(server, code).then(function (r) {
      btn.disabled = false; btn.textContent = "Pair";
      if (r.ok) { showPair(false); $("code").value = ""; }
      else $("pairErr").textContent = r.error || "Pairing failed.";
    });
  });

  var opLevel: OpacityLevel = 1;
  function applyOpacity(n: OpacityLevel): void {
    opLevel = n;
    document.body.className = "op" + n;
    $("opBtn").textContent = ["solid", "opacity", "faint"][n] ?? "opacity";
  }
  $("opBtn").addEventListener("click", function () {
    applyOpacity(((opLevel + 1) % 3) as OpacityLevel);
    void window.milf.setOpacity(opLevel);
  });
  $("quitBtn").addEventListener("click", function () { void window.milf.quit(); });
  $("pairCancel").addEventListener("click", function (e) {
    e.preventDefault();
    showPair(false);
  });
  $("detailClose").addEventListener("click", function () { $("detail").className = ""; });
  $("repairBtn").addEventListener("click", function () {
    window.milf.unpair().then(function () { showPair(true); });
  });
  window.milf.onRepair(function () { showPair(true); });
  // Clipboard watching. Off unless deliberately switched on, and the button
  // goes green while armed - reading the clipboard should never be something
  // you are doing without knowing it.
  $("clipBtn").addEventListener("click", function () {
    void window.milf.clipwatch(!$("clipBtn").classList.contains("armed"));
  });
  window.milf.onClipWatch(function (d) {
    $("clipBtn").classList.toggle("armed", !!d.on);
    if (!d.on) { setStatus({ state: "live" }); return; }
    if (d.error) return setStatus({ state: "error", detail: "clip: " + d.error });
    if (d.sentKind) {
      var msg = d.delivered
        ? "sent " + d.sentKind + " to the dashboard"
        : "captured a " + d.sentKind + " \u2014 no dashboard tab open";
      setStatus({ state: d.delivered ? "clip" : "warn", detail: msg });
      if (clipMsgTimer !== null) clearTimeout(clipMsgTimer);
      clipMsgTimer = setTimeout(function () { setStatus({ state: "live" }); }, 6000);
    }
  });
  var clipMsgTimer: ReturnType<typeof setTimeout> | null = null;
  window.milf.clipwatch(undefined).then(function (d) {
    $("clipBtn").classList.toggle("armed", !!(d && d.on));
  });

  $("clearBtn").addEventListener("click", function () {
    scans = [];
    $("detail").className = "";
    render();
  });
  window.milf.onClear(function () { scans = []; $("detail").className = ""; render(); });


  // Bumps arrive on the same stream as scans, keyed by scan id. Held apart
  // from the scan list so a re-render doesn't lose a running timer.
  var bumps: Record<string, ActiveBump> = {};

  function paintBumps(): void {
    var now = performance.now();
    Object.keys(bumps).forEach(function (id) {
      var b = bumps[id];
      if (!b) return;
      var row = document.querySelector<HTMLElement>('[data-bumprow="' + id + '"]');
      if (!row) return;
      var elapsed = now - b.receivedAt;
      var left = b.remainingMs - elapsed;
      row.style.display = "flex";
      var pct = Math.max(0, Math.min(100, (left / b.totalMs) * 100));
      var bar = row.querySelector<HTMLElement>("i");
      var leftLabel = row.querySelector<HTMLElement>(".bumpleft");
      var who = row.querySelector<HTMLElement>(".bumpwho");
      if (!bar || !leftLabel || !who) return;
      bar.style.width = pct + "%";
      // The number an FC reads out. Counts DOWN, because "how long have I got"
      // is the question, not "how long has it been".
      // m:ss above a minute - "165s" is harder to read out than "2:45".
      var secs = Math.ceil(left / 1000);
      leftLabel.textContent = left <= 0 ? "OUT"
        : secs >= 60 ? Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0")
        : secs + "s";
      who.textContent =
        b.by + (b.count > 1 ? "  \u00D7" + b.count : "");
      // Amber at 30 seconds left, not a fraction of the hold. On a 180s bump a
      // percentage would go amber with a full minute to spare, which reads as
      // urgent far too early and stops meaning anything.
      row.className = "bumprow" + (left <= 0 ? " gone" : left <= 30000 ? " warn" : "");
    });
  }
  setInterval(paintBumps, 250);

  function sendBump(id: string | null): void {
    if (id === null) return;
    var btn = document.querySelector<HTMLButtonElement>('[data-bump="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = "\u2026"; }
    window.milf.bump(id).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = "BUMP"; }
      if (r && r.ok === false) {
        setStatus({ state: "error", detail: r.error || "bump failed" });
        // Long enough to actually read - a two-second flash of an error you
        // then have to reproduce is worse than no error.
        if (bumpErrTimer !== null) clearTimeout(bumpErrTimer);
        bumpErrTimer = setTimeout(function () {
          setStatus({ state: "live" });
        }, 12000);
      }
    });
  }
  var bumpErrTimer: ReturnType<typeof setTimeout> | null = null;

  window.milf.onBump(function (b) {
    // Anchor the server-reported duration to this renderer's monotonic clock.
    // Comparing the server's `at` timestamp with Date.now() here makes clock
    // skew between the two machines shorten or lengthen the timer immediately.
    var remainingMs = Number(b.remainingMs);
    if (!Number.isFinite(remainingMs)) {
      // Older servers only send holdMs. Starting that duration on receipt is
      // preferable to reintroducing a cross-machine clock comparison.
      remainingMs = Number(b.holdMs);
    }
    if (!Number.isFinite(remainingMs)) return;
    var active: ActiveBump = {
      ...b,
      remainingMs: Math.max(0, remainingMs),
      totalMs: Math.max(1, Number(b.holdMs) || remainingMs || 1),
      receivedAt: performance.now(),
    };
    bumps[b.scanId] = active;
    paintBumps();
  });
  window.milf.onBumpCleared(function (d) {
    delete bumps[d.scanId];
    var row = document.querySelector<HTMLElement>('[data-bumprow="' + d.scanId + '"]');
    if (row) row.style.display = "none";
  });

  window.milf.onScan(function (s) {
    scans.unshift(s);
    if (scans.length > 40) scans.pop();
    render();
  });
  window.milf.onStatus(setStatus);
  window.milf.onUnpaired(function () { scans = []; render(); showPair(true); });

  window.milf.state().then(function (st) {
    if (st.serverUrl) $("server").value = st.serverUrl;
    applyOpacity(st.opacity == null ? 1 : st.opacity);
    showPair(!st.paired);
  });
})();
