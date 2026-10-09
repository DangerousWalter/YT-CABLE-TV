// src/lib/tv.js
//
// TV mode: the same app, driven by a TV remote instead of a mouse and keyboard.
// It switches on for Samsung (Tizen) and LG (webOS) TV browsers automatically, or with ?tv=1 on the address
// (?tv=0 turns it off again), which is also handy for trying it on a computer.

export function isTvMode() {
  try {
    const flag = new URLSearchParams(window.location.search).get('tv');
    if (flag === '1') {
      sessionStorage.setItem('retrotv.tv', '1');
      return true;
    }
    if (flag === '0') {
      sessionStorage.removeItem('retrotv.tv');
      return false;
    }
    if (sessionStorage.getItem('retrotv.tv') === '1') return true;
  } catch {
    /* storage blocked: fall through to the browser check */
  }
  return /Tizen|SMART-?TV|Web0S|WebOS/i.test(navigator.userAgent || '');
}

// Samsung remote key codes (the arrows and OK are the same on every browser)
const CODES = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
  13: 'ok',
  10009: 'back', // the remote's Back / Return button
  27: 'back', // Escape and Backspace stand in for it on a computer
  8: 'back',
  427: 'channelUp', // CH+
  428: 'channelDown', // CH-
  33: 'channelUp', // Page Up / Page Down stand in for them on a computer
  34: 'channelDown',
  403: 'red',
  404: 'green',
  405: 'yellow',
  406: 'blue',
};

// -> 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'channelUp' | 'channelDown' | 'red' | 'green' | 'yellow' | 'blue' | null
export function tvActionForKey(e) {
  return CODES[e.keyCode] || null;
}

// Samsung TVs only send the color buttons, CH+/- and the like to an app that has asked for them
export function registerTvKeys() {
  try {
    const device = window.tizen && window.tizen.tvinputdevice;
    if (!device) return;
    const names = ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'ChannelUp', 'ChannelDown', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    names.forEach((name) => {
      try {
        device.registerKey(name);
      } catch {
        /* this TV doesn't have that key */
      }
    });
  } catch {
    /* not running on a Tizen TV */
  }
}

// The Samsung launcher can only register the remote's special keys (colors, CH+/-, numbers) for the whole app,
// and passes along any that reach it instead of this page. Replay them here as ordinary key presses.
export function listenForLauncherKeys() {
  const onMessage = (e) => {
    try {
      if (e.source !== window.parent || !e.data || !e.data.retrotvKey) return;
      const { keyCode, key } = e.data.retrotvKey;
      if (!Number.isInteger(keyCode)) return;
      window.dispatchEvent(new KeyboardEvent('keydown', { keyCode, which: keyCode, key: typeof key === 'string' ? key : '', bubbles: true, cancelable: true }));
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

// Leaves the app. Inside the Samsung launcher, this asks it to close; otherwise it tries the TV's own way, then history.
export function exitTvApp() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ retrotv: 'exit' }, '*');
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    window.tizen.application.getCurrentApplication().exit();
    return;
  } catch {
    /* not a Tizen app */
  }
  try {
    window.close();
  } catch {
    /* ignore */
  }
  window.history.back();
}

// Tells the Samsung launcher this page has started (it shows a warning if it never hears this)
export function tellLauncherReady() {
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage({ retrotv: 'ready' }, '*');
  } catch {
    /* ignore */
  }
}
