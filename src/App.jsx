import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Tv, Volume2, VolumeX, PlusCircle, X, RefreshCw, Power, Trash2, Layers, Upload, Users, Palette, Maximize, Minimize, Settings as SettingsIcon } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import ImportSubscriptions from './components/ImportSubscriptions';
import ProfileManager from './components/ProfileManager';
import PinPrompt from './components/PinPrompt';
import StaticOverlay from './components/StaticOverlay';
import ProgramGuide from './components/ProgramGuide';
import { MAX_BROWSE_SHIFT, TV_EPG_HOURS } from './lib/guideMath';
import ThemePicker from './components/ThemePicker';
import TvProfilePicker from './components/TvProfilePicker';
import { isTvMode, tvActionForKey, registerTvKeys, listenForLauncherKeys, exitTvApp, tellLauncherReady } from './lib/tv';
import SettingsModal from './components/SettingsModal';
import ColorBars from './components/ColorBars';
import ChannelGuideScreen from './components/ChannelGuideScreen';
import { withVirtualChannels } from './lib/virtualChannels';
import { applyTheme, normalizeTheme } from './lib/themes';
import { configureSounds, unlockAudio, playChannelChange, playPowerOn, playPowerOff } from './lib/tvSounds';

// Same address as the page itself: the desktop app and `npm run server` serve both, and `npm run dev` proxies /api
const API_BASE = '/api';
const GUIDE_REFRESH_MS = 60_000; // keep the guide's "now/next" columns fresh
const BROWSE_IDLE_MS = 12_000; // TV: the guide highlight drops back to the playing channel after this long without a key
const IDLE_HIDE_MS = 20_000; // after this long on a channel with no activity, the menu bar and guide slide away
const BADGE_VISIBLE_MS = 4000; // how long the channel info stays on screen before fading out

const EMPTY_FORM = { number: '', name: '', category: 'General', sources: '' };

// Isolated so the once-a-second tick doesn't re-render the whole app.
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>TIME: {now.toLocaleTimeString()}</span>;
}

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [currentProfile, setCurrentProfile] = useState(null);
  const [epg, setEpg] = useState({ data: [], loadedAt: 0, skewMs: 0 }); // loadedAt = when the offsets were fetched; skewMs = server clock minus this device's clock
  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [tv] = useState(isTvMode); // TV mode: driven by a TV remote, no mouse menus (see src/lib/tv.js)
  const [showGuide, setShowGuide] = useState(!tv); // on a TV, OK opens the guide
  const [tvPickerOpen, setTvPickerOpen] = useState(false); // TV mode's "Who's watching?"
  const [tvToast, setTvToast] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(() => {
    try {
      const saved = localStorage.getItem('retrotv.volume');
      return saved === null ? 100 : Math.max(0, Math.min(100, Number(saved) || 0));
    } catch {
      return 100;
    }
  });
  const [osd, setOsd] = useState(null); // on-screen display: { label, value } shown briefly when volume changes
  const [collapsing, setCollapsing] = useState(false); // CRT "picture collapses" animation on power off
  const [loading, setLoading] = useState(true);
  const [powered, setPowered] = useState(false); // browsers need a user gesture before sound can autoplay
  const [staticKey, setStaticKey] = useState(0); // bump to flash TV static over the picture

  // Sound + static effects on/off (remembered between visits)
  const [sfxEnabled, setSfxEnabled] = useState(() => {
    try {
      return localStorage.getItem('retrotv.sfx') !== 'off';
    } catch {
      return true;
    }
  });
  const [tuneNonce, setTuneNonce] = useState(0); // bump to force a fresh "tune" of the current channel

  // Add / edit channel modal: null | { mode: 'add' } | { mode: 'edit', channel }
  const [channelModal, setChannelModal] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirmation: the channels about to be deleted (empty = no dialog)
  const [deleteTargets, setDeleteTargets] = useState([]);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Guide "select" mode (checkboxes for bulk delete)
  const [selectMode, setSelectMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState([]); // channel ids

  // The channel info badge fades out a few seconds after it appears
  const [badgeVisible, setBadgeVisible] = useState(false);
  const badgeTimer = useRef(null);

  // Ungroup: first click arms it, second click does it
  const [splitConfirm, setSplitConfirm] = useState(false);

  // Group existing channels modal
  const [groupModal, setGroupModal] = useState(false);
  const [groupSelected, setGroupSelected] = useState([]); // channel ids
  const [groupName, setGroupName] = useState(null); // null = use the suggested name
  const [groupError, setGroupError] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);

  // Import YouTube subscriptions modal
  const [importOpen, setImportOpen] = useState(false);

  // Immersive mode: the menu bar and guide hide after a while on a channel
  const [uiHidden, setUiHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Theme (per profile): the active theme and the picker
  const [theme, setTheme] = useState(() => normalizeTheme(null));
  const [themeOpen, setThemeOpen] = useState(false);

  // Settings (YouTube API key, network access); opens by itself on first run when there's no key yet
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFirstRun, setSettingsFirstRun] = useState(false);

  // Profiles: manager modal + PIN prompt (the profile someone is trying to switch to)
  const [profileMgrOpen, setProfileMgrOpen] = useState(false);
  const [pinTarget, setPinTarget] = useState(null);

  // After a merge/split, keep watching the right channel once the new lineup arrives
  const pendingSelectId = useRef(null);
  const lastBackAt = useRef(0); // TV: when Back was last pressed (twice within 3 seconds exits)
  const tvToastTimer = useRef(null);
  const profileSelectByPointer = useRef(false); // was the profile dropdown opened with the mouse/finger?
  const selectFirstReal = useRef(true); // after a lineup loads, start on its first real channel (not CH 0)

  const profileId = currentProfile?.id;
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;

  const anyModalOpen = Boolean(
    channelModal || deleteTargets.length > 0 || groupModal || importOpen || profileMgrOpen || pinTarget || themeOpen || settingsOpen || tvPickerOpen
  );

  // 1. Profiles. Reloaded after any change in the manager; if the profile being watched was deleted,
  //    currentProfile becomes null and the effect below picks another one.
  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/profiles`);
      const data = await res.json();
      setProfiles(data);
      setCurrentProfile((prev) => (prev ? data.find((p) => p.id === prev.id) || null : prev));
      return data;
    } catch (err) {
      console.error('Error fetching profiles:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Paint the page with the active theme, and switch to a profile's own theme when it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setTheme(normalizeTheme(currentProfile?.theme));
    // only when the profile *changes*, not whenever its record is refreshed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  // Picking a theme previews instantly and is saved to the profile shortly after
  const themeSaveTimer = useRef(null);
  const handleThemeChange = useCallback((next) => {
    const normalized = normalizeTheme(next);
    setTheme(normalized);
    clearTimeout(themeSaveTimer.current);
    const pid = profileIdRef.current;
    themeSaveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/profiles/${pid}/theme`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(normalized),
        });
        if (res.ok) {
          setProfiles((list) => list.map((p) => (p.id === pid ? { ...p, theme: normalized } : p)));
        }
      } catch (err) {
        console.error('Could not save theme:', err);
      }
    }, 400);
  }, []);

  useEffect(() => () => clearTimeout(themeSaveTimer.current), []);

  // First run: no YouTube key yet -> open Settings with a welcome (only on the computer that can set one)
  useEffect(() => {
    fetch(`${API_BASE}/settings`)
      .then((res) => res.json())
      .then((info) => {
        if (info.canEdit && !info.hasApiKey) {
          setSettingsFirstRun(true);
          setSettingsOpen(true);
        }
      })
      .catch(() => {});
  }, []);

  // Nobody selected yet: open the first profile without a PIN, or ask for a PIN if all are protected
  useEffect(() => {
    if (currentProfile || pinTarget || tvPickerOpen || profiles.length === 0) return;

    if (tv) {
      // On a TV: go straight back to the profile used last time, otherwise ask who's watching
      let remembered = null;
      try {
        remembered = profiles.find((p) => String(p.id) === localStorage.getItem('retrotv.tvProfile'));
      } catch {
        /* storage unavailable */
      }
      if (remembered && !remembered.has_pin) setCurrentProfile(remembered);
      else if (profiles.length === 1 && !profiles[0].has_pin) setCurrentProfile(profiles[0]);
      else setTvPickerOpen(true);
      return;
    }

    const open = profiles.find((p) => !p.has_pin);
    if (open) setCurrentProfile(open);
    else setPinTarget(profiles[0]);
  }, [profiles, currentProfile, pinTarget, tvPickerOpen, tv]);

  // TV mode: remember who was watching, ask the TV for the remote's extra buttons, and tell the launcher we're up
  useEffect(() => {
    if (tv && profileId) {
      try {
        localStorage.setItem('retrotv.tvProfile', String(profileId));
      } catch {
        /* not remembered */
      }
    }
  }, [tv, profileId]);

  useEffect(() => {
    if (!tv) return;
    registerTvKeys();
    tellLauncherReady();
    return listenForLauncherKeys();
  }, [tv]);

  // Switching profiles: PIN-protected ones ask first
  const requestSwitchProfile = (prof) => {
    if (!prof || prof.id === profileId) return;
    if (prof.has_pin) setPinTarget(prof);
    else setCurrentProfile(prof);
  };

  // 2. Fetch EPG data.
  //    silent: don't flash the "Tuning channels..." spinner (background refreshes)
  //    retune: also force the player to re-sync to the fresh schedule
  const loadEpg = useCallback(
    async ({ silent = false, retune = false } = {}) => {
      if (!profileId) return false;
      if (!silent) setLoading(true);
      try {
        // the TV asks for a longer schedule so you can browse ahead in the guide
        const res = await fetch(`${API_BASE}/epg/${profileId}${tv ? `?hours=${TV_EPG_HOURS}` : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (profileIdRef.current !== profileId) return false; // profile changed mid-request
        const data = Array.isArray(body) ? body : body.channels; // (older servers sent a bare array)
        const skewMs = Array.isArray(body) ? 0 : body.serverNow - Date.now();
        setEpg({ data, loadedAt: Date.now(), skewMs });
        if (selectFirstReal.current) {
          selectFirstReal.current = false;
          setCurrentChannelIndex(data.length > 0 ? 1 : 0); // [CH 0 guide, ...your channels, CH 99 test pattern]
        }
        if (retune) setTuneNonce((n) => n + 1);
        return true;
      } catch (err) {
        console.error('Error fetching EPG data:', err);
        return false;
      } finally {
        if (!silent && profileIdRef.current === profileId) setLoading(false);
      }
    },
    [profileId, tv]
  );

  // Initial load + whenever the profile changes (start back on the first channel)
  useEffect(() => {
    selectFirstReal.current = true;
    loadEpg();
  }, [loadEpg]);

  // Background guide refresh
  useEffect(() => {
    const t = setInterval(() => loadEpg({ silent: true }), GUIDE_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadEpg]);

  // Everything you can tune to: your channels plus the built-in ones (the test pattern)
  const channels = useMemo(() => withVirtualChannels(epg.data), [epg.data]);
  const guideEpg = useMemo(() => ({ ...epg, data: channels }), [epg, channels]);

  // If channels were removed, never point past the end of the list
  useEffect(() => {
    if (currentChannelIndex >= channels.length) {
      setCurrentChannelIndex(channels.length - 1);
    }
  }, [channels.length, currentChannelIndex]);

  useEffect(() => {
    if (pendingSelectId.current == null) return;
    const idx = channels.findIndex((c) => c.id === pendingSelectId.current);
    if (idx !== -1) {
      setCurrentChannelIndex(idx);
      pendingSelectId.current = null;
    }
  }, [channels]);

  const activeChannel = channels[currentChannelIndex];
  const emptyHint = tv
    ? `No channels yet. Add some from a computer or phone at ${window.location.origin}`
    : 'No channels yet. Use Add Channel or Import to get started.';
  const currentProg = activeChannel?.schedule?.current;

  // ---- Number keys: type a channel number to jump to it (0 = the Channel Guide) ----
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const [dial, setDial] = useState('');
  const dialRef = useRef('');
  const dialTimer = useRef(null);

  const commitDial = useCallback(() => {
    clearTimeout(dialTimer.current);
    const wanted = dialRef.current;
    dialRef.current = '';
    setDial('');
    if (wanted === '') return;
    const idx = channelsRef.current.findIndex((c) => c.number === Number(wanted));
    if (idx !== -1) setCurrentChannelIndex(idx);
  }, []);

  const pressDigit = useCallback(
    (digit) => {
      dialRef.current = (dialRef.current + digit).slice(0, 3);
      setDial(dialRef.current);
      clearTimeout(dialTimer.current);
      if (dialRef.current.length >= 3) commitDial();
      else dialTimer.current = setTimeout(commitDial, 1500); // wait a moment for a second digit, or press Enter
    },
    [commitDial]
  );

  useEffect(() => () => clearTimeout(dialTimer.current), []);

  // ---- TV: browse the guide without changing channel ----
  // Up/Down move a highlight through the lineup and Left/Right look later in the day, while the current channel
  // keeps playing. OK tunes to the highlighted channel; Back (or a few idle seconds) goes back to the playing one.
  const [browse, setBrowse] = useState({ index: null, shift: 0 }); // index: highlighted row (null = not browsing); shift: 30-minute steps ahead
  const browseRef = useRef(browse);
  const browseTimer = useRef(null);
  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentChannelIndex;

  const clearBrowse = useCallback(() => {
    clearTimeout(browseTimer.current);
    if (browseRef.current.index === null && browseRef.current.shift === 0) return;
    browseRef.current = { index: null, shift: 0 };
    setBrowse(browseRef.current);
  }, []);

  const updateBrowse = useCallback(
    (next) => {
      browseRef.current = next;
      setBrowse(next);
      clearTimeout(browseTimer.current);
      browseTimer.current = setTimeout(clearBrowse, BROWSE_IDLE_MS);
    },
    [clearBrowse]
  );

  useEffect(() => () => clearTimeout(browseTimer.current), []);

  // Browsing ends when the guide goes away, the TV powers off, or the channel changes by other means
  useEffect(() => {
    if (!showGuide || uiHidden || !powered) clearBrowse();
  }, [showGuide, uiHidden, powered, clearBrowse]);
  useEffect(() => {
    clearBrowse();
  }, [currentChannelIndex, profileId, clearBrowse]);

  // ---- Immersive mode ----
  // After IDLE_HIDE_MS on a channel with no activity, the menu bar and guide slide away. Moving the mouse,
  // clicking, or pressing a key brings them back; changing channel restarts the countdown.
  const uiHiddenRef = useRef(false);
  uiHiddenRef.current = uiHidden;
  const canHideRef = useRef(false);
  canHideRef.current = powered && !anyModalOpen && !selectMode && Boolean(activeChannel);
  const idleTimer = useRef(null);

  const pokeUi = useCallback(() => {
    setUiHidden(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (canHideRef.current) setUiHidden(true);
    }, IDLE_HIDE_MS);
  }, []);

  // Volume / mute / info keys shouldn't pop the menus open, but they do count as "still here"
  const keepUiAlive = useCallback(() => {
    if (!uiHiddenRef.current) pokeUi();
  }, [pokeUi]);

  // A new channel, powering on, or closing a dialog starts a fresh countdown
  useEffect(() => {
    pokeUi();
  }, [activeChannel?.id, powered, anyModalOpen, selectMode, pokeUi]);

  useEffect(() => {
    let lastX = null;
    let lastY = null;
    const onMove = (e) => {
      if (lastX !== null && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 6) return; // ignore jitter
      lastX = e.clientX;
      lastY = e.clientY;
      pokeUi();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerdown', pokeUi);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('pointerdown', pokeUi);
      clearTimeout(idleTimer.current);
    };
  }, [pokeUi]);

  // After clicking a button or dragging the volume slider, let go of focus. Otherwise the slider stays
  // open, and keys (arrows, Enter, Space) keep acting on that control instead of changing channel or volume.
  useEffect(() => {
    const releaseFocus = () => {
      const el = document.activeElement;
      if (!el) return;
      const inputType = el.tagName === 'INPUT' ? el.type : '';
      if (el.tagName === 'BUTTON' || ['range', 'checkbox', 'radio'].includes(inputType)) el.blur();
    };
    window.addEventListener('pointerup', releaseFocus);
    return () => window.removeEventListener('pointerup', releaseFocus);
  }, []);

  // Real browser fullscreen needs a click or key press (browsers don't allow it automatically)
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      const request = document.documentElement.requestFullscreen?.();
      request?.catch?.(() => {});
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Show the channel badge, then fade it after a few seconds
  const showBadge = useCallback(() => {
    setBadgeVisible(true);
    clearTimeout(badgeTimer.current);
    badgeTimer.current = setTimeout(() => setBadgeVisible(false), BADGE_VISIBLE_MS);
  }, []);

  // ...whenever you tune in, change channel, or a new program starts
  useEffect(() => {
    if (powered && activeChannel?.id != null) showBadge();
  }, [powered, activeChannel?.id, currentProg?.videoId, showBadge]);

  useEffect(() => () => clearTimeout(badgeTimer.current), []);

  // Leave select mode when switching profiles; drop selections for channels that no longer exist
  useEffect(() => {
    setSelectMode(false);
    setBulkSelected([]);
  }, [profileId]);

  useEffect(() => {
    setBulkSelected((sel) => {
      const valid = sel.filter((id) => epg.data.some((c) => c.id === id));
      return valid.length === sel.length ? sel : valid;
    });
  }, [epg.data]);

  // 3. "Tune" = work out where the live broadcast is *right now*.
  //    The server's seekToSeconds was true when the EPG was fetched, so add the
  //    time elapsed since. Only recomputed on channel / program change (or an
  //    explicit retune), so background guide refreshes don't re-seek the video.
  const tune = useMemo(() => {
    if (!currentProg) return null;
    const now = Date.now();
    const elapsed = (now - epg.loadedAt) / 1000;
    const seek = currentProg.seekToSeconds + elapsed;
    const remaining = currentProg.durationSeconds - seek;
    return {
      videoId: currentProg.videoId,
      startSeconds: Math.max(0, Math.floor(seek)),
      endsAt: now + remaining * 1000,
      stale: remaining <= 2, // program already over; need a fresh schedule first
      key: `${activeChannel.id}:${currentProg.videoId}:${tuneNonce}`,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel?.id, currentProg?.videoId, tuneNonce]);

  // Re-sync with the schedule when a program ends (or immediately if stale).
  const retuneTimer = useRef(null);
  const retune = useCallback(async () => {
    clearTimeout(retuneTimer.current);
    const ok = await loadEpg({ silent: true, retune: true });
    if (!ok) retuneTimer.current = setTimeout(retune, 5000); // server hiccup: try again
  }, [loadEpg]);

  useEffect(() => {
    if (!tune) return;
    const delay = tune.stale ? 500 : Math.max(tune.endsAt - Date.now(), 0) + 1000;
    const t = setTimeout(retune, delay);
    return () => clearTimeout(t);
  }, [tune, retune]);

  useEffect(() => () => clearTimeout(retuneTimer.current), []);

  // Player says the video finished: sync up (ignore if the timer already did)
  const lastRetuneAt = useRef(0);
  const handleEnded = useCallback(() => {
    if (Date.now() - lastRetuneAt.current < 3000) return;
    lastRetuneAt.current = Date.now();
    retune();
  }, [retune]);

  // Keep the sound module in step with the mute button and the FX toggle
  useEffect(() => {
    configureSounds({ enabled: sfxEnabled, muted: isMuted, volume: volume / 100 });
  }, [sfxEnabled, isMuted, volume]);

  const toggleSfx = () => {
    const next = !sfxEnabled;
    setSfxEnabled(next);
    try {
      localStorage.setItem('retrotv.sfx', next ? 'on' : 'off');
    } catch {
      /* private mode etc.: just don't remember it */
    }
  };

  // Volume + mute, with a retro on-screen display. Refs let the keyboard handler see current values.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const mutedRef = useRef(isMuted);
  mutedRef.current = isMuted;
  const osdTimer = useRef(null);

  const showOsd = useCallback((label, value) => {
    setOsd({ label, value });
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(null), 1800);
  }, []);

  const applyVolume = useCallback(
    (v) => {
      const next = Math.max(0, Math.min(100, Math.round(v)));
      volumeRef.current = next;
      setVolume(next);
      try {
        localStorage.setItem('retrotv.volume', String(next));
      } catch {
        /* not remembered, no big deal */
      }
      if (next > 0) {
        mutedRef.current = false;
        setIsMuted(false);
      }
      showOsd('VOLUME', next);
    },
    [showOsd]
  );

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setIsMuted(next);
    showOsd(next ? 'MUTE' : 'VOLUME', next ? 0 : volumeRef.current);
  }, [showOsd]);

  // Power off: CRT collapse sound + animation, then back to the "power on" screen
  const collapseTimer = useRef(null);
  const powerOff = useCallback(() => {
    playPowerOff();
    setCollapsing(true);
    setPowered(false);
    setOsd(null);
    clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setCollapsing(false), 650);
  }, []);

  useEffect(
    () => () => {
      clearTimeout(osdTimer.current);
      clearTimeout(collapseTimer.current);
    },
    []
  );

  // Powering on is the user gesture the browser needs before it will let us make sound
  const powerOn = useCallback(() => {
    setPowered(true);
    unlockAudio();
    playPowerOn();
    setStaticKey((k) => k + 1);
  }, []);

  // Changing channel: relay thunk + static burst (not for program rollovers or the first power-on)
  const prevChannelId = useRef(null);
  useEffect(() => {
    const id = activeChannel?.id ?? null;
    if (powered && id != null && prevChannelId.current != null && id !== prevChannelId.current) {
      playChannelChange();
      setStaticKey((k) => k + 1);
    }
    prevChannelId.current = id;
  }, [powered, activeChannel?.id]);

  // 4. Keybind Controls
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Any key brings the menus back; volume / mute / info keys only keep them from timing out
      const key = e.key.toLowerCase();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || key === 'm' || key === 'i') keepUiAlive();
      else pokeUi();

      if (anyModalOpen) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      // First key press powers the TV on (counts as the user gesture for audio), except Back, which leaves the app
      if (tv && !powered && tvActionForKey(e) === 'back') {
        exitTvApp();
        return;
      }
      if (!powered) {
        powerOn();
        return;
      }

      // TV remote: OK opens the guide, CH+/- change channel, the color buttons are shortcuts, Back backs out and then exits
      if (tv) {
        const action = tvActionForKey(e);
        const browsing = browseRef.current.index !== null;
        if (action === 'back' && browsing) {
          clearBrowse(); // first Back drops the highlight, the next one closes the guide
          return;
        }
        if (action === 'back') {
          if (showGuide) {
            setShowGuide(false);
          } else if (Date.now() - lastBackAt.current < 3000) {
            exitTvApp();
          } else {
            lastBackAt.current = Date.now();
            setTvToast('Press Back again to exit');
            clearTimeout(tvToastTimer.current);
            tvToastTimer.current = setTimeout(() => setTvToast(''), 2500);
          }
          return;
        }
        // Browsing the guide (only while it's on screen; a faded-out guide just comes back on the first key press)
        if (showGuide && !uiHiddenRef.current && channels.length > 0 && !dialRef.current) {
          const now = browseRef.current;
          const at = now.index ?? currentIndexRef.current;
          if (action === 'up' || action === 'down') {
            const next = action === 'up' ? (at > 0 ? at - 1 : channels.length - 1) : at < channels.length - 1 ? at + 1 : 0;
            updateBrowse({ ...now, index: next });
            return;
          }
          if (action === 'left' || action === 'right') {
            const shift = Math.min(MAX_BROWSE_SHIFT, Math.max(0, now.shift + (action === 'right' ? 1 : -1)));
            updateBrowse({ index: at, shift });
            return;
          }
          if (action === 'ok' && browsing) {
            const target = now.index;
            clearBrowse();
            if (target !== currentIndexRef.current) setCurrentChannelIndex(target);
            return;
          }
        }
        // (when the guide has faded away, the key press has just brought it back, so don't also toggle it off)
        if ((action === 'ok' && !dialRef.current) || action === 'green') {
          if (!uiHiddenRef.current) setShowGuide((v) => !v);
          return;
        }
        if (action === 'channelUp') {
          setCurrentChannelIndex((prev) => (prev < channels.length - 1 ? prev + 1 : 0));
          return;
        }
        if (action === 'channelDown') {
          setCurrentChannelIndex((prev) => (prev > 0 ? prev - 1 : channels.length - 1));
          return;
        }
        if (action === 'red') {
          toggleMute();
          return;
        }
        if (action === 'yellow') {
          setTvPickerOpen(true);
          return;
        }
        if (action === 'blue') {
          setCurrentChannelIndex(0); // CH 0, the Channel Guide
          return;
        }
      }

      // These work even if there are no channels
      if (e.key === 'ArrowRight') {
        applyVolume(volumeRef.current + 5);
        return;
      }
      if (e.key === 'ArrowLeft') {
        applyVolume(volumeRef.current - 5);
        return;
      }
      if (e.key.toLowerCase() === 'm') {
        toggleMute();
        return;
      }
      if (e.key.toLowerCase() === 'p') {
        powerOff();
        return;
      }
      if (e.key.toLowerCase() === 'f') {
        toggleFullscreen();
        return;
      }
      if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        pressDigit(e.key);
        return;
      }
      if (e.key === 'Enter' && dialRef.current) {
        commitDial();
        return;
      }

      if (!channels.length) return;

      if (e.key === 'ArrowUp') {
        setCurrentChannelIndex((prev) => (prev > 0 ? prev - 1 : channels.length - 1));
      } else if (e.key === 'ArrowDown') {
        setCurrentChannelIndex((prev) => (prev < channels.length - 1 ? prev + 1 : 0));
      } else if (e.key.toLowerCase() === 'g') {
        setShowGuide((prev) => !prev);
      } else if (e.key.toLowerCase() === 'i') {
        showBadge();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [channels, anyModalOpen, powered, clearBrowse, updateBrowse, showBadge, powerOn, powerOff, applyVolume, toggleMute, pokeUi, keepUiAlive, toggleFullscreen, pressDigit, commitDial, tv, showGuide]);

  // 5. Add / edit channel
  const openAddChannel = () => {
    const nextNumber = epg.data.reduce((max, c) => Math.max(max, c.number), 0) + 1;
    setForm({ ...EMPTY_FORM, number: String(nextNumber) });
    setFormError('');
    setChannelModal({ mode: 'add' });
  };

  const openEditChannel = (chan) => {
    setForm({
      number: String(chan.number),
      name: chan.name,
      category: chan.category || 'General',
      sources: (chan.sources || []).join('\n'),
    });
    setFormError('');
    setSplitConfirm(false);
    setChannelModal({ mode: 'edit', channel: chan });
  };

  const closeChannelModal = () => {
    if (saving) return;
    setChannelModal(null);
  };

  const updateForm = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmitChannel = async (e) => {
    e.preventDefault();
    if (saving || !channelModal) return;
    setFormError('');
    setSaving(true);

    const isEdit = channelModal.mode === 'edit';
    try {
      const res = await fetch(
        isEdit ? `${API_BASE}/channels/${channelModal.channel.id}` : `${API_BASE}/channels`,
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profile_id: currentProfile.id,
            channel_number: Number(form.number),
            name: form.name,
            category: form.category,
            sources: form.sources, // one YouTube channel per line (or comma separated)
          }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(body.error || `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      setChannelModal(null);
      await loadEpg({ silent: true });
    } catch (err) {
      console.error('Failed to save channel:', err);
      setFormError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  // Ungroup a multi-source channel into one channel per YouTube source
  const handleSplit = async () => {
    if (!channelModal || channelModal.mode !== 'edit' || saving) return;
    if (!splitConfirm) {
      setSplitConfirm(true);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const res = await fetch(`${API_BASE}/channels/${channelModal.channel.id}/split`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(body.error || `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      pendingSelectId.current = activeChannel?.id ?? null;
      setChannelModal(null);
      await loadEpg({ silent: true });
    } catch (err) {
      console.error('Failed to ungroup channel:', err);
      setFormError('Could not reach the server.');
    } finally {
      setSaving(false);
      setSplitConfirm(false);
    }
  };

  // Group existing channels into one
  const selectedForGroup = epg.data.filter((c) => groupSelected.includes(c.id)); // lineup order = lowest number first
  const suggestedGroupName = selectedForGroup[0]?.name || '';

  const openGroup = () => {
    setGroupSelected([]);
    setGroupName(null);
    setGroupError('');
    setGroupModal(true);
  };

  const toggleGroupChannel = (id) =>
    setGroupSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const handleMerge = async (e) => {
    e.preventDefault();
    if (groupBusy || groupSelected.length < 2) return;
    setGroupBusy(true);
    setGroupError('');
    try {
      const res = await fetch(`${API_BASE}/channels/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_id: currentProfile.id,
          channel_ids: groupSelected,
          name: groupName ?? suggestedGroupName,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGroupError(body.error || `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      // keep watching the same channel, unless it was one of the merged ones
      pendingSelectId.current = groupSelected.includes(activeChannel?.id) ? body.id : activeChannel?.id ?? null;
      setGroupModal(false);
      await loadEpg({ silent: true });
    } catch (err) {
      console.error('Failed to group channels:', err);
      setGroupError('Could not reach the server.');
    } finally {
      setGroupBusy(false);
    }
  };

  // 6. Delete channel(s): one from its row, or many via the guide's select mode
  const openDelete = (channels) => {
    setDeleteError('');
    setDeleteTargets(Array.isArray(channels) ? channels : [channels]);
  };

  const toggleBulk = (id) =>
    setBulkSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const allSelected = epg.data.length > 0 && bulkSelected.length === epg.data.length;
  const toggleSelectAll = () => setBulkSelected(allSelected ? [] : epg.data.map((c) => c.id));

  const exitSelectMode = () => {
    setSelectMode(false);
    setBulkSelected([]);
  };

  const handleConfirmDelete = async () => {
    if (deleteTargets.length === 0 || deleting) return;
    setDeleting(true);
    setDeleteError('');
    const ids = new Set(deleteTargets.map((c) => c.id));

    try {
      const res = await fetch(`${API_BASE}/channels/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: currentProfile.id, channel_ids: [...ids] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error || `Could not delete (HTTP ${res.status}).`);
        return;
      }

      // Update the list locally in one step (no flicker), keeping the same channel selected
      // if it survived (or the next one in line if it didn't), then reconcile with the server.
      const remaining = epg.data.filter((c) => !ids.has(c.id));
      const nextAll = withVirtualChannels(remaining);
      const survivorIdx = nextAll.findIndex((c) => c.id === activeChannel?.id);
      const nextIdx = survivorIdx !== -1 ? survivorIdx : Math.min(currentChannelIndex, nextAll.length - 1);

      setEpg((prev) => ({ ...prev, data: remaining }));
      setCurrentChannelIndex(nextIdx);
      setDeleteTargets([]);
      exitSelectMode();
      loadEpg({ silent: true });
    } catch (err) {
      console.error('Failed to delete channels:', err);
      setDeleteError('Could not reach the server.');
    } finally {
      setDeleting(false);
    }
  };

  const tuningSpinner = (
    <div className="flex items-center space-x-2 text-gray-400">
      <RefreshCw className="animate-spin" />
      <span>Tuning channels...</span>
    </div>
  );

  const inputClass =
    'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-yellow-500';

  return (
    <div
      className={`flex flex-col h-screen bg-black text-white font-sans overflow-hidden select-none ${
        uiHidden ? 'cursor-none' : ''
      }`}
    >
      {/* Top Bar Controls */}
      <div
        className={`${tv ? 'hidden' : ''} flex items-center justify-between px-4 bg-gray-900 border-gray-800 z-10 overflow-hidden transition-all duration-500 ${
          uiHidden ? 'max-h-0 py-0 opacity-0 border-b-0' : 'max-h-20 py-2 opacity-100 border-b'
        }`}
      >
        <div className="flex items-center space-x-3">
          <Tv className="text-yellow-500 w-6 h-6" />
          <span className="font-bold text-lg tracking-wider text-yellow-500">RETRO-CABLE TV</span>
          <button
            onClick={powered ? powerOff : powerOn}
            className={`p-2 rounded-full border transition ${
              powered
                ? 'border-green-500/60 text-green-400 hover:bg-gray-800'
                : 'border-gray-700 text-gray-500 hover:bg-gray-800 hover:text-gray-300'
            }`}
            title={powered ? 'Power off (P)' : 'Power on'}
          >
            <Power className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center space-x-4">
          <button
            onClick={() => {
              setSettingsFirstRun(false);
              setSettingsOpen(true);
            }}
            className="p-2 rounded-full bg-gray-800 hover:bg-gray-700 border border-gray-700 text-yellow-400 transition"
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>

          <button
            onClick={() => setThemeOpen(true)}
            disabled={!currentProfile}
            className="p-2 rounded-full bg-gray-800 hover:bg-gray-700 border border-gray-700 text-yellow-400 transition disabled:opacity-50"
            title="Change theme"
          >
            <Palette className="w-4 h-4" />
          </button>

          <button
            onClick={openAddChannel}
            className="flex items-center space-x-1 bg-yellow-500 hover:bg-yellow-600 text-black font-bold px-3 py-1 rounded text-sm transition"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Add Channel</span>
          </button>

          <button
            onClick={() => setImportOpen(true)}
            disabled={!currentProfile}
            className="flex items-center space-x-1 bg-gray-800 hover:bg-gray-700 border border-yellow-500/60 text-yellow-400 font-bold px-3 py-1 rounded text-sm transition disabled:opacity-50"
            title="Import your YouTube subscriptions (Google Takeout)"
          >
            <Upload className="w-4 h-4" />
            <span>Import</span>
          </button>

          {epg.data.length >= 2 && (
            <button
              onClick={openGroup}
              className="flex items-center space-x-1 bg-gray-800 hover:bg-gray-700 border border-yellow-500/60 text-yellow-400 font-bold px-3 py-1 rounded text-sm transition"
              title="Combine existing channels into one"
            >
              <Layers className="w-4 h-4" />
              <span>Group Channels</span>
            </button>
          )}

          <div className="flex items-center space-x-2 bg-gray-800 px-3 py-1 rounded-full border border-gray-700">
            <span className="text-sm">Profile:</span>
            <select
              className="bg-transparent text-yellow-400 font-semibold focus:outline-none cursor-pointer"
              value={currentProfile?.id || ''}
              onPointerDown={() => {
                profileSelectByPointer.current = true;
              }}
              onBlur={() => {
                profileSelectByPointer.current = false;
              }}
              onChange={(e) => {
                const dropdown = e.currentTarget;
                requestSwitchProfile(profiles.find((p) => p.id === Number(e.target.value)));
                // After picking with the mouse, let go of focus so the arrow keys change channels again
                // (while a dropdown has focus, they would change the profile instead)
                if (profileSelectByPointer.current) dropdown.blur();
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id} className="bg-gray-900 text-white">
                  {p.avatar} {p.name}
                  {p.has_pin ? ' 🔒' : ''}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                loadProfiles(); // refresh channel counts
                setProfileMgrOpen(true);
              }}
              className="p-1 rounded-full hover:bg-gray-700 text-gray-300 hover:text-yellow-400 transition"
              title="Manage profiles"
            >
              <Users className="w-4 h-4" />
            </button>
          </div>

          <div className="group flex items-center rounded-full hover:bg-gray-800 focus-within:bg-gray-800 transition">
            <button onClick={toggleMute} className="p-2 rounded-full" title="Mute (M). Left/Right arrows change volume">
              {isMuted || volume === 0 ? <VolumeX className="text-red-400" /> : <Volume2 className="text-green-400" />}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={isMuted ? 0 : volume}
              onChange={(e) => applyVolume(Number(e.target.value))}
              aria-label="Volume"
              className="w-0 opacity-0 group-hover:w-24 group-hover:opacity-100 group-hover:mr-3 group-focus-within:w-24 group-focus-within:opacity-100 group-focus-within:mr-3 transition-all duration-200 accent-yellow-500 cursor-pointer"
            />
          </div>

          <button
            onClick={toggleSfx}
            className={`px-2 py-1 rounded text-xs font-bold border transition ${
              sfxEnabled
                ? 'border-yellow-500/60 text-yellow-400 hover:bg-gray-800'
                : 'border-gray-700 text-gray-500 hover:bg-gray-800 line-through'
            }`}
            title="TV effects: static and channel-change sounds"
          >
            FX
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-2 rounded-full hover:bg-gray-800 text-gray-300 hover:text-yellow-400 transition"
            title={isFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'}
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main Video Viewport */}
      <div className="relative flex-1 min-h-0 overflow-hidden bg-black flex items-center justify-center">
        {!currentProfile ? (
          <div className="text-center text-gray-500">
            <p className="text-xl">🔒 Who's watching?</p>
            <p className="text-sm mt-1">Choose a profile to start.</p>
          </div>
        ) : loading ? (
          tuningSpinner
        ) : !powered ? (
          <button
            onClick={powerOn}
            className="flex flex-col items-center space-y-3 text-yellow-500 hover:text-yellow-300 transition"
          >
            <Power className="w-16 h-16" />
            <span className="font-mono text-lg tracking-widest">PRESS ANY KEY TO POWER ON</span>
          </button>
        ) : activeChannel?.virtual === 'guide' ? (
          <div className="w-full h-full">
            <ChannelGuideScreen epg={epg} audible={powered && !isMuted && volume > 0} emptyHint={emptyHint} />
          </div>
        ) : activeChannel?.virtual === 'bars' ? (
          <div className="w-full h-full">
            <ColorBars
              audible={powered && !isMuted && sfxEnabled && volume > 0}
              hint={epg.data.length === 0 ? emptyHint : null}
            />
          </div>
        ) : tune && !tune.stale ? (
          <div className="w-full h-full">
            <VideoPlayer
              key={tune.key}
              videoId={tune.videoId}
              startSeconds={tune.startSeconds}
              muted={isMuted}
              volume={volume}
              onEnded={handleEnded}
            />
          </div>
        ) : tune ? (
          tuningSpinner
        ) : (
          <div className="text-center text-gray-500">
            <p className="text-xl">NO SIGNAL</p>
            <p className="text-sm mt-1">No channels found for this profile.</p>
          </div>
        )}

        {/* CRT collapse when powering off */}
        {collapsing && (
          <div className="crt-collapse-overlay absolute inset-0 z-40 bg-black pointer-events-none overflow-hidden">
            <div className="crt-collapse absolute inset-0 bg-gray-200" />
          </div>
        )}

        {/* TV static burst on channel change / power on */}
        <StaticOverlay trigger={sfxEnabled ? staticKey : 0} />

        {/* On-screen displays (volume, channel number, channel info) share one top layer with its own
            stacking context, so nothing underneath, like the scrolling Channel Guide, can ever cover them */}
        <div
          className="absolute inset-0 z-50 isolate pointer-events-none"
          style={{ transform: 'translateZ(0)', willChange: 'transform' }}
        >
          {/* TV: "Press Back again to exit" */}
          {tvToast && (
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-black/85 border border-yellow-500 text-yellow-300 font-mono text-2xl px-8 py-4 rounded-lg">
              {tvToast}
            </div>
          )}

          {/* Volume on-screen display */}
          {powered && osd && (
            <div
              className="absolute bottom-6 left-6 font-mono text-green-400 bg-black/70 px-3 py-2 rounded pointer-events-none"
              style={{ textShadow: '0 0 6px rgba(74, 222, 128, 0.7)' }}
            >
              <div className="text-sm tracking-widest">
                {osd.label}
                {osd.label === 'MUTE' ? '' : ` ${osd.value}`}
              </div>
              <div className="flex gap-0.5 mt-1">
                {Array.from({ length: 20 }, (_, i) => (
                  <span key={i} className={`w-1.5 h-3 ${i < Math.round(osd.value / 5) ? 'bg-green-400' : 'bg-green-950'}`} />
                ))}
              </div>
            </div>
          )}

          {/* Channel number being typed */}
          {powered && dial && (
            <div
              className="absolute top-4 right-6 font-mono text-6xl font-bold text-green-400 pointer-events-none"
              style={{ textShadow: '0 0 10px rgba(74, 222, 128, 0.8)' }}
            >
              {dial}
            </div>
          )}

          {/* On-Screen Badge (fades out after a few seconds; press I to bring it back) */}
          {powered && activeChannel && (
            <div
              className={`absolute top-4 left-4 bg-black/80 backdrop-blur border border-yellow-500/50 px-4 py-2 rounded shadow-lg pointer-events-none transition-opacity duration-700 ${
                badgeVisible ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <div className="flex items-center space-x-3">
                <span className="text-2xl font-black text-yellow-400">CH {activeChannel.number}</span>
                <div>
                  <h2 className="font-bold text-white text-lg">{activeChannel.name}</h2>
                  <p className="text-xs text-gray-300 truncate max-w-md">{currentProg?.title || activeChannel.blurb || 'Live Stream'}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* EPG Cable Guide */}
      {showGuide && (
        <div
          className={`bg-gray-950 border-yellow-500 flex flex-col font-mono text-sm z-10 overflow-hidden transition-all duration-500 ${
            uiHidden ? 'border-t-0 opacity-0' : 'border-t-2 opacity-100'
          }`}
          // taller screens get a taller guide (never smaller than before, never more than about 45% of a tall window)
          style={{ height: uiHidden ? 0 : 'clamp(18rem, 34vh, 34rem)' }}
        >
          <div className="bg-gray-900 px-4 py-2 border-b border-gray-800 flex justify-between items-center text-xs text-gray-400 font-bold">
            {selectMode ? (
              <div className="flex items-center space-x-4">
                <label className="flex items-center space-x-2 cursor-pointer text-gray-200">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} className="accent-yellow-500" />
                  <span>Select all</span>
                </label>
                <span className="text-yellow-300">{bulkSelected.length} selected</span>
                <button
                  onClick={() => openDelete(epg.data.filter((c) => bulkSelected.includes(c.id)))}
                  disabled={bulkSelected.length === 0}
                  className="flex items-center space-x-1 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2 py-1 rounded transition"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Delete selected</span>
                </button>
                <button onClick={exitSelectMode} className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 transition">
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center space-x-4">
                <span>
                  {tv
                    ? `OK: guide  |  Up/Down: channel  |  Yellow: who's watching  |  Back: exit.  Manage channels from a computer or phone at ${window.location.origin}`
                    : 'ELEC PROGRAM GUIDE (G guide, I info, F fullscreen, P power, M mute, Up/Down channel, 0-9 jump, Left/Right volume)'}
                </span>
                {!tv && epg.data.length > 0 && (
                  <button
                    onClick={() => setSelectMode(true)}
                    className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 transition"
                  >
                    Select
                  </button>
                )}
              </div>
            )}
            <Clock />
          </div>

          <ProgramGuide
            epg={guideEpg}
            selectedIndex={currentChannelIndex}
            browseIndex={tv ? browse.index : null}
            timeShift={tv ? browse.shift : 0}
            onSelect={setCurrentChannelIndex}
            selectMode={selectMode}
            bulkSelected={bulkSelected}
            onToggleBulk={toggleBulk}
            onEdit={openEditChannel}
            onDelete={openDelete}
            readOnly={tv}
            tv={tv}
          />
        </div>
      )}

      {/* Modal: Add / Edit Channel */}
      {channelModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-md p-6 relative">
            <button onClick={closeChannelModal} className="absolute top-4 right-4 text-gray-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-xl font-bold text-yellow-400 mb-4">
              {channelModal.mode === 'edit' ? `Edit Channel ${channelModal.channel.number}` : 'Add New Cable Channel'}
            </h3>

            <form onSubmit={handleSubmitChannel} className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-gray-400 mb-1">CHANNEL #</label>
                  <input
                    type="number"
                    min="1"
                    value={form.number}
                    onChange={updateForm('number')}
                    className={inputClass}
                    required
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-400 mb-1">STATION NAME</label>
                  <input
                    type="text"
                    placeholder="e.g. Home & Garage"
                    value={form.name}
                    onChange={updateForm('name')}
                    className={inputClass}
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1">CATEGORY</label>
                <input type="text" value={form.category} onChange={updateForm('category')} className={inputClass} />
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1">YOUTUBE CHANNELS (one per line)</label>
                <textarea
                  rows={4}
                  placeholder={'@TechnologyConnections\nUC3KEoMzBxf83ECxQGYOERFw'}
                  value={form.sources}
                  onChange={updateForm('sources')}
                  className={`${inputClass} font-mono text-sm`}
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  Use a @handle or a UC… channel ID. Add several to mix them into one TV channel.
                </p>
              </div>

              {formError && (
                <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2">{formError}</p>
              )}

              {channelModal.mode === 'edit' && channelModal.channel.sources?.length > 1 && (
                <button
                  type="button"
                  onClick={handleSplit}
                  disabled={saving}
                  className={`w-full border font-bold py-2 rounded text-sm transition disabled:opacity-60 ${
                    splitConfirm
                      ? 'border-red-500 text-red-300 bg-red-950/40 hover:bg-red-950/70'
                      : 'border-gray-600 text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  {splitConfirm
                    ? `Click again to confirm: ${channelModal.channel.sources.length} separate channels`
                    : `Ungroup into ${channelModal.channel.sources.length} separate channels`}
                </button>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full bg-yellow-500 hover:bg-yellow-600 disabled:opacity-60 disabled:cursor-wait text-black font-bold py-2 rounded transition"
              >
                {saving ? 'Checking channels...' : channelModal.mode === 'edit' ? 'Save Changes' : 'Save Channel'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Group existing channels */}
      {groupModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-md p-6 relative">
            <button
              onClick={() => !groupBusy && setGroupModal(false)}
              className="absolute top-4 right-4 text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-xl font-bold text-yellow-400 mb-1">Group Channels</h3>
            <p className="text-xs text-gray-400 mb-4">
              Pick two or more channels to combine into one. The lowest-numbered one keeps its number; the others are
              removed from the lineup.
            </p>

            <form onSubmit={handleMerge} className="space-y-4">
              <div className="max-h-52 overflow-y-auto space-y-1 border border-gray-800 rounded p-2">
                {epg.data.map((chan) => (
                  <label
                    key={chan.id}
                    className={`flex items-center space-x-3 px-2 py-1.5 rounded cursor-pointer text-sm ${
                      groupSelected.includes(chan.id) ? 'bg-blue-700/60' : 'hover:bg-gray-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={groupSelected.includes(chan.id)}
                      onChange={() => toggleGroupChannel(chan.id)}
                      className="accent-yellow-500"
                    />
                    <span className="truncate">
                      CH {chan.number} • {chan.name}
                      {chan.sources?.length > 1 && (
                        <span className="ml-2 text-xs text-yellow-300">[{chan.sources.length} sources]</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1">NAME FOR THE COMBINED CHANNEL</label>
                <input
                  type="text"
                  value={groupName ?? suggestedGroupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Pick channels first"
                  className={inputClass}
                />
              </div>

              {groupError && (
                <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2">{groupError}</p>
              )}

              <button
                type="submit"
                disabled={groupBusy || groupSelected.length < 2}
                className="w-full bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2 rounded transition"
              >
                {groupBusy
                  ? 'Grouping...'
                  : groupSelected.length < 2
                    ? 'Select at least 2 channels'
                    : `Combine ${groupSelected.length} channels into CH ${selectedForGroup[0]?.number}`}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Settings */}
      {settingsOpen && (
        <SettingsModal
          apiBase={API_BASE}
          firstRun={settingsFirstRun}
          profile={currentProfile}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => loadEpg({ silent: true })}
          onLineupChanged={() => {
            pendingSelectId.current = activeChannel?.id ?? null;
            loadEpg({ silent: true });
          }}
        />
      )}

      {/* Modal: Theme */}
      {themeOpen && currentProfile && (
        <ThemePicker
          theme={theme}
          profileName={currentProfile.name}
          onChange={handleThemeChange}
          onClose={() => setThemeOpen(false)}
        />
      )}

      {/* Modal: Manage profiles */}
      {profileMgrOpen && (
        <ProfileManager
          profiles={profiles}
          currentProfileId={profileId}
          apiBase={API_BASE}
          onClose={() => setProfileMgrOpen(false)}
          onChanged={loadProfiles}
        />
      )}

      {/* TV mode: who's watching */}
      {tvPickerOpen && (
        <TvProfilePicker
          profiles={profiles}
          activeId={profileId}
          onPick={(p) => {
            setTvPickerOpen(false);
            if (p.id === profileId) return;
            if (p.has_pin) setPinTarget(p);
            else setCurrentProfile(p);
          }}
          onClose={currentProfile ? () => setTvPickerOpen(false) : undefined}
        />
      )}

      {/* PIN prompt when switching to a protected profile */}
      {pinTarget && (
        <PinPrompt
          key={pinTarget.id}
          profile={pinTarget}
          profiles={profiles}
          apiBase={API_BASE}
          canCancel={Boolean(currentProfile)}
          onPickProfile={setPinTarget}
          onSuccess={(prof) => {
            setCurrentProfile(prof);
            setPinTarget(null);
          }}
          onCancel={() => setPinTarget(null)}
        />
      )}

      {/* Modal: Import YouTube subscriptions */}
      {importOpen && currentProfile && (
        <ImportSubscriptions
          profile={currentProfile}
          apiBase={API_BASE}
          onClose={() => setImportOpen(false)}
          onChanged={() => {
            pendingSelectId.current = activeChannel?.id ?? null;
            loadEpg({ silent: true });
          }}
        />
      )}

      {/* Modal: Confirm Delete (one or many channels) */}
      {deleteTargets.length > 0 && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-red-500 rounded-lg w-full max-w-sm p-6">
            <h3 className="text-xl font-bold text-red-400 mb-2">
              {deleteTargets.length === 1 ? 'Delete channel?' : `Delete ${deleteTargets.length} channels?`}
            </h3>

            {deleteTargets.length === 1 ? (
              <p className="text-gray-300 text-sm mb-4">
                CH {deleteTargets[0].number} • {deleteTargets[0].name} will be removed from this profile
                {deleteTargets[0].sources?.length > 1 ? ` (including its ${deleteTargets[0].sources.length} sources)` : ''}.
              </p>
            ) : (
              <div className="mb-4">
                <p className="text-gray-300 text-sm mb-2">These will be removed from this profile:</p>
                <div className="max-h-32 overflow-y-auto text-xs text-gray-400 border border-gray-800 rounded p-2 space-y-0.5">
                  {deleteTargets.map((c) => (
                    <p key={c.id} className="truncate">
                      CH {c.number} • {c.name}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {deleteError && <p className="text-sm text-red-400 mb-3">{deleteError}</p>}

            <div className="flex space-x-3">
              <button
                onClick={() => setDeleteTargets([])}
                disabled={deleting}
                className="flex-1 bg-gray-800 hover:bg-gray-700 py-2 rounded transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-60 font-bold py-2 rounded transition"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
