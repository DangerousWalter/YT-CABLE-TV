// The Retro-Cable TV launcher for Samsung TVs.
// It remembers the address of your Retro-Cable TV server, checks that it's reachable, and shows the app
// full screen. The app itself runs on the server, so updating the server updates the TV.
(function () {
  var STORAGE_KEY = 'retrotvServer';
  var DEFAULT_PORT = '3001';
  var AUTO_OPEN_SECONDS = 3;
  var PROBE_TIMEOUT_MS = 7000;
  var READY_TIMEOUT_MS = window.RETROTV_READY_TIMEOUT_MS || 20000; // how long to wait for the app to say it started

  var $ = function (id) { return document.getElementById(id); };
  var screens = ['setup', 'connecting', 'problem'];
  var iframe = $('app');
  var currentBase = null;
  var countdownTimer = null;
  var readyTimer = null;
  var appVisible = false;

  // ---------- address handling ----------
  // "192.168.1.50" -> "http://192.168.1.50:3001"; any path is dropped; returns null if it can't be an address
  function normalize(input) {
    var s = String(input || '').replace(/^\s+|\s+$/g, '');
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    var m = /^(https?:\/\/)([A-Za-z0-9._-]+)(:\d{1,5})?(\/.*)?$/i.exec(s);
    if (!m) return null;
    return m[1].toLowerCase() + m[2] + (m[3] || ':' + DEFAULT_PORT);
  }
  window.RetroTvLauncherNormalize = normalize; // exposed so it can be tested

  function saved() { try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; } }
  function save(base) { try { localStorage.setItem(STORAGE_KEY, base); } catch (e) { /* not remembered */ } }

  // ---------- screens ----------
  function show(name) {
    appVisible = (name === 'app');
    // className drives the look; the explicit display makes sure only one screen shows even if the stylesheet fails to load
    screens.forEach(function (id) {
      $(id).className = id === name ? 'screen' : 'screen hidden';
      $(id).style.display = id === name ? 'block' : 'none';
    });
    iframe.className = name === 'app' ? '' : 'hidden';
    iframe.style.display = name === 'app' ? 'block' : 'none';
  }

  function showSetup(message) {
    clearInterval(countdownTimer);
    show('setup');
    $('server').value = (currentBase || saved() || '').replace(/^https?:\/\//, '');
    $('setup-error').textContent = message || '';
    try { $('server').focus(); } catch (e) { /* ignore */ }
  }

  function showProblem(title, text) {
    clearInterval(countdownTimer);
    clearTimeout(readyTimer);
    iframe.removeAttribute('src');
    show('problem');
    $('problem-title').textContent = title;
    $('problem-text').textContent = text;
    try { $('retry').focus(); } catch (e) { /* ignore */ }
  }

  // ---------- connecting ----------
  // Can we reach it at all? (An opaque "no-cors" answer is enough: the server isn't set up to allow reading it from here.)
  function probe(base, done) {
    var finished = false;
    var timer = setTimeout(function () { if (!finished) { finished = true; done(false); } }, PROBE_TIMEOUT_MS);
    function end(ok) { if (!finished) { finished = true; clearTimeout(timer); done(ok); } }
    try {
      fetch(base + '/api/settings', { mode: 'no-cors', cache: 'no-store' }).then(function () { end(true); }, function () { end(false); });
    } catch (e) { end(false); }
  }

  function openApp(base) {
    currentBase = base;
    $('connecting-addr').textContent = base;
    $('countdown').textContent = '';
    show('connecting');
    probe(base, function (ok) {
      if (!ok) {
        showProblem("Can't reach " + base,
          'Check that the server is on, that this TV is on the same network, and that the address is right (use the numeric address, like 192.168.1.50:' + DEFAULT_PORT + ').');
        return;
      }
      save(base);
      iframe.src = base + '/?tv=1';
      show('app');
      // The app tells us when it has started. If it never does, the page probably couldn't run on this TV.
      clearTimeout(readyTimer);
      readyTimer = setTimeout(function () {
        showProblem('The app did not start',
          'The server answered, but the page did not start on this TV (its browser may be too old). Try again, or open ' + base + '/tv-check in the TV browser and send me what it shows.');
      }, READY_TIMEOUT_MS);
    });
  }

  function startCountdown(base) {
    var left = AUTO_OPEN_SECONDS;
    currentBase = base;
    $('connecting-addr').textContent = base;
    $('countdown').textContent = 'in ' + left + '...';
    show('connecting');
    clearInterval(countdownTimer);
    countdownTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) { clearInterval(countdownTimer); openApp(base); }
      else { $('countdown').textContent = 'in ' + left + '...'; }
    }, 1000);
  }

  // ---------- leaving ----------
  function exitApp() {
    try { window.tizen.application.getCurrentApplication().exit(); return; } catch (e) { /* not on a Tizen TV */ }
    try { window.close(); } catch (e2) { /* ignore */ }
  }

  // ---------- events ----------
  function connectFromInput() {
    var base = normalize($('server').value);
    if (!base) { $('setup-error').textContent = 'That does not look like an address. Try something like 192.168.1.50:' + DEFAULT_PORT; return; }
    $('setup-error').textContent = '';
    openApp(base);
  }

  $('connect').onclick = connectFromInput;
  $('server').onkeydown = function (e) { if (e.keyCode === 13) connectFromInput(); };
  $('retry').onclick = function () { if (currentBase) openApp(currentBase); else showSetup(); };
  $('change').onclick = function () { showSetup(); };

  // messages from the app running inside the frame
  window.addEventListener('message', function (e) {
    if (e.source !== iframe.contentWindow || !e.data || !e.data.retrotv) return;
    if (e.data.retrotv === 'ready') { clearTimeout(readyTimer); try { iframe.focus(); } catch (err) { /* ignore */ } }
    if (e.data.retrotv === 'exit') exitApp();
  });
  iframe.onload = function () { try { iframe.focus(); iframe.contentWindow.focus(); } catch (e) { /* ignore */ } };

  // The TV's remote doesn't move between buttons by itself, so the arrows are handled here.
  // 65376 / 65385 are the on-screen keyboard's "Done" and "Cancel" keys on Samsung TVs.
  function focusEl(id) { try { $(id).focus(); } catch (err) { /* ignore */ } }
  function isShown(id) { return $(id).style.display === 'block'; }
  document.addEventListener('keydown', function (e) {
    if (appVisible) return;
    var k = e.keyCode;
    if (isShown('setup')) {
      var inField = document.activeElement === $('server');
      if (inField && (k === 13 || k === 65376)) { e.preventDefault(); connectFromInput(); return; }
      if (inField && k === 65385) { return; }
      if (k === 40 && inField) { e.preventDefault(); focusEl('connect'); return; }
      if (k === 38 && document.activeElement === $('connect')) { e.preventDefault(); focusEl('server'); return; }
    } else if (isShown('problem')) {
      if (k === 39 && document.activeElement === $('retry')) { e.preventDefault(); focusEl('change'); return; }
      if (k === 37 && document.activeElement === $('change')) { e.preventDefault(); focusEl('retry'); return; }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (appVisible) return; // the app handles its own keys
    if (e.keyCode === 10009) { exitApp(); return; } // Back leaves the app from any launcher screen
    if (!$('connecting').className.match(/hidden/) && (e.keyCode === 37 || e.keyCode === 39)) {
      clearInterval(countdownTimer);
      showSetup(); // left / right while counting down: change the address
    }
  });

  // ---------- remote keys ----------
  // Only this page (not the server's page inside the frame) can use the TV's key API, so the color buttons, CH+/-
  // and number keys are registered here. If one reaches this page instead of the app, hand it to the app.
  (function registerRemoteKeys() {
    try {
      var dev = window.tizen && window.tizen.tvinputdevice;
      if (!dev) return;
      ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown',
       '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (name) {
        try { dev.registerKey(name); } catch (err) { /* this TV doesn't have that key */ }
      });
    } catch (e) { /* not on a Tizen TV */ }
  })();

  document.addEventListener('keydown', function (e) {
    if (!appVisible || !iframe.contentWindow) return;
    try { iframe.contentWindow.postMessage({ retrotvKey: { keyCode: e.keyCode, key: e.key } }, '*'); } catch (err) { /* ignore */ }
  });

  // ---------- start ----------
  var existing = saved();
  if (existing && normalize(existing)) startCountdown(normalize(existing));
  else showSetup();
})();
