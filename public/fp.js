/* ---------------------------------------------------------------------------
   Browser fingerprint collector.

   Served by the logger and run in the visitor's browser. It computes the
   signals that never appear in an HTTP request — canvas, WebGL/GPU, audio,
   fonts, screen, CPU, automation flags — and posts them back to /fp, keyed to
   the row id the page was given (window.__oid). The logger then has BOTH the
   request headers and the real browser fingerprint for the same hit.

   Privacy: this reads only device/browser characteristics. No page content, no
   keystrokes, no personal data.
--------------------------------------------------------------------------- */
(function () {
  "use strict";
  var oid = window.__oid;
  if (!oid) return;

  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i); return (h >>> 0).toString(16); }
  var fp = {};
  function set(k, fn) { try { fp[k] = fn(); } catch (e) { fp[k] = "ERR"; } }

  set("webdriver", function () { return navigator.webdriver; });          // automation tell
  set("chrome", function () { return typeof window.chrome; });
  set("ua", function () { return navigator.userAgent; });
  set("languages", function () { return (navigator.languages || []).join(","); });
  set("platform", function () { return navigator.platform; });
  set("vendor", function () { return navigator.vendor; });
  set("cores", function () { return navigator.hardwareConcurrency; });     // physical, hard to fake
  set("memory", function () { return navigator.deviceMemory; });
  set("maxTouch", function () { return navigator.maxTouchPoints; });
  set("screen", function () { return screen.width + "x" + screen.height + "@" + (window.devicePixelRatio || 1); });
  set("colorDepth", function () { return screen.colorDepth; });
  set("timezone", function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; });
  set("tzOffset", function () { return new Date().getTimezoneOffset(); });
  set("plugins", function () { return navigator.plugins.length; });
  set("pointerCoarse", function () { return matchMedia("(pointer: coarse)").matches; });
  set("touch", function () { return "ontouchstart" in window; });
  set("cookiesEnabled", function () { return navigator.cookieEnabled; });

  // WebGL vendor/renderer — the GPU. The single strongest hardware signal.
  set("webgl", function () {
    var c = document.createElement("canvas");
    var g = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!g) return "none";
    var d = g.getExtension("WEBGL_debug_renderer_info");
    var v = d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR);
    var r = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
    return v + " | " + r;
  });

  // Canvas hash — GPU + rasteriser + fonts, per device.
  set("canvas", function () {
    var c = document.createElement("canvas"); c.width = 240; c.height = 60;
    var x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "14px Arial";
    x.fillStyle = "#f60"; x.fillRect(100, 1, 62, 20);
    x.fillStyle = "#069"; x.fillText("octopus éèê 0123", 2, 15);
    x.fillStyle = "rgba(102,204,0,0.7)"; x.fillText("octopus éèê 0123", 4, 25);
    return hash(c.toDataURL());
  });

  // Installed-font probe.
  set("fonts", function () {
    var base = ["monospace", "sans-serif", "serif"];
    var probe = ["Arial", "Roboto", "Noto Sans", "Times New Roman", "Courier New", "Georgia",
                 "Verdana", "Tahoma", "Segoe UI", "Noto Naskh Arabic", "Samsung Sans", "Miui", "Comic Sans MS"];
    var s = document.createElement("span");
    s.style.cssText = "position:absolute;left:-9999px;font-size:72px"; s.textContent = "mmmmmmmmmmlli";
    document.body.appendChild(s);
    var bl = {}; base.forEach(function (b) { s.style.fontFamily = b; bl[b] = [s.offsetWidth, s.offsetHeight]; });
    var found = [];
    probe.forEach(function (f) {
      for (var i = 0; i < base.length; i++) {
        s.style.fontFamily = "'" + f + "'," + base[i];
        if (s.offsetWidth !== bl[base[i]][0] || s.offsetHeight !== bl[base[i]][1]) { found.push(f); break; }
      }
    });
    document.body.removeChild(s);
    return found.join(",");
  });

  function send() {
    try {
      var body = JSON.stringify({ id: oid, fp: fp });
      if (navigator.sendBeacon) navigator.sendBeacon("/fp", new Blob([body], { type: "application/json" }));
      else { var x = new XMLHttpRequest(); x.open("POST", "/fp", true); x.setRequestHeader("Content-Type", "application/json"); x.send(body); }
    } catch (e) {}
  }

  // audio fingerprint (async), then send. Also fold in high-entropy UA client hints.
  function withAudio() {
    try {
      var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) return send();
      var ctx = new AC(1, 44100, 44100);
      var osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.value = 10000;
      var comp = ctx.createDynamicsCompressor();
      osc.connect(comp); comp.connect(ctx.destination); osc.start(0); ctx.startRendering();
      ctx.oncomplete = function (ev) {
        var d = ev.renderedBuffer.getChannelData(0), sum = 0;
        for (var i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
        fp.audio = sum.toFixed(6); send();
      };
      setTimeout(function () { if (fp.audio === undefined) { fp.audio = "timeout"; send(); } }, 2000);
    } catch (e) { fp.audio = "ERR"; send(); }
  }

  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(["architecture", "model", "platformVersion", "fullVersionList", "bitness"])
      .then(function (h) { fp.uaHighEntropy = h; withAudio(); })
      .catch(withAudio);
  } else {
    withAudio();
  }
})();
