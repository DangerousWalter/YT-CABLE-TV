// src/components/SettingsModal.jsx
//
// App settings: the YouTube API key (needed to load channels) and whether other devices on your
// network, like a TV, may open Retro-Cable TV. Both can only be changed on the computer running it.
import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import LineupTransfer from './LineupTransfer';

export default function SettingsModal({ apiBase, firstRun, profile, onClose, onChanged, onLineupChanged }) {
  const [info, setInfo] = useState(null); // what the server reports
  const [loadError, setLoadError] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ kind: '', text: '' });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/settings`);
      setInfo(await res.json());
      setLoadError('');
    } catch {
      setLoadError('Could not reach the server.');
    }
  }, [apiBase]);

  useEffect(() => {
    load();
  }, [load]);

  // Sends a change; shows the server's message if it's refused
  const save = async (changes, successText) => {
    setBusy(true);
    setMessage({ kind: '', text: '' });
    try {
      const res = await fetch(`${apiBase}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: 'error', text: body.error || `Something went wrong (HTTP ${res.status}).` });
        return false;
      }
      setInfo(body);
      setMessage({ kind: 'ok', text: successText });
      onChanged?.();
      return true;
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the server.' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (e) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    if (await save({ youtubeApiKey: keyInput }, '✓ Key accepted by YouTube and saved.')) setKeyInput('');
  };

  const toggleLan = async (checked) => {
    await save({ lanAccess: checked }, checked ? '✓ Other devices can now connect.' : '✓ Only this computer can connect now.');
    // the server restarts its listener a moment after replying; give it a second, then refresh the addresses
    setTimeout(load, 1200);
  };

  const inputClass =
    'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-yellow-500';
  const canEdit = info?.canEdit;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-lg p-6 relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white" title="Close">
          <X className="w-5 h-5" />
        </button>

        <h3 className="text-xl font-bold text-yellow-400 mb-3">{firstRun ? 'Welcome to Retro-Cable TV' : 'Settings'}</h3>

        {firstRun && (
          <p className="text-sm text-gray-300 mb-4">
            To load channels, Retro-Cable TV needs a free YouTube API key. It only takes a couple of minutes, and the
            steps are below.
          </p>
        )}

        {loadError && <p className="text-sm text-red-400 mb-3">{loadError}</p>}
        {info && !canEdit && (
          <p className="text-sm text-yellow-300 bg-yellow-950/40 border border-yellow-900 rounded px-3 py-2 mb-4">
            Settings can only be changed on the computer that runs Retro-Cable TV.
          </p>
        )}

        {/* ---------- YouTube API key ---------- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-gray-400">YOUTUBE API KEY</p>
            {info && (
              <span className={`text-xs ${info.hasApiKey ? 'text-green-400' : 'text-red-400'}`}>
                {info.hasApiKey ? `✓ set (${info.apiKeyHint})` : '✗ not set yet'}
              </span>
            )}
          </div>

          {canEdit && (
            <form onSubmit={saveKey} className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={info?.hasApiKey ? 'Paste a new key to replace it' : 'Paste your key here'}
                autoComplete="off"
                spellCheck={false}
                className={`${inputClass} font-mono text-sm`}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="px-3 text-xs bg-gray-800 hover:bg-gray-700 rounded shrink-0"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                type="submit"
                disabled={busy || !keyInput.trim()}
                className="px-4 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-bold rounded shrink-0"
              >
                {busy ? 'Checking...' : 'Save'}
              </button>
            </form>
          )}

          <details className="text-sm text-gray-400" open={firstRun}>
            <summary className="cursor-pointer text-gray-300">How to get a key</summary>
            <ol className="list-decimal list-inside space-y-1 mt-2">
              <li>
                Go to <span className="text-yellow-300">console.cloud.google.com</span> and create a project (any name).
              </li>
              <li>
                Open “APIs &amp; Services”, choose “Enable APIs”, and enable <b>YouTube Data API v3</b>.
              </li>
              <li>Open “Credentials”, choose “Create credentials”, then “API key”, and copy it here.</li>
            </ol>
            <p className="text-xs text-gray-500 mt-2">
              The key stays on this computer. Google's free quota is plenty for a home lineup.
            </p>
          </details>
        </section>

        {/* ---------- Network access ---------- */}
        <section className="mt-6 pt-4 border-t border-gray-800 space-y-2">
          <p className="text-xs font-bold text-gray-400">OTHER DEVICES (LIKE YOUR TV)</p>
          <label className={`flex items-start gap-3 text-sm ${canEdit ? 'cursor-pointer' : 'opacity-60'}`}>
            <input
              type="checkbox"
              checked={Boolean(info?.lanAccess)}
              disabled={!canEdit || busy}
              onChange={(e) => toggleLan(e.target.checked)}
              className="mt-1 accent-yellow-500"
            />
            <span>
              Let other devices on my home network open Retro-Cable TV
              <span className="block text-xs text-gray-500">
                Anyone on your network will be able to use it. Profile PINs keep people out of a profile inside the app,
                but they aren't strong security.
              </span>
            </span>
          </label>

          {info?.lanAccess && canEdit && (
            <div className="bg-gray-800 rounded px-3 py-2 text-sm">
              <p className="text-gray-400 text-xs mb-1">On the TV or another device, open:</p>
              {info.lanUrls.length > 0 ? (
                info.lanUrls.map((url) => (
                  <p key={url} className="font-mono text-yellow-300 select-all">
                    {url}
                  </p>
                ))
              ) : (
                <p className="text-gray-500 text-xs">Looking for this computer's network address...</p>
              )}
            </div>
          )}
        </section>

        {canEdit && profile && !firstRun && info?.hasApiKey && (
          <LineupTransfer profile={profile} apiBase={apiBase} onChanged={onLineupChanged} />
        )}

        {message.text && (
          <p
            className={`mt-4 text-sm rounded px-3 py-2 border ${
              message.kind === 'error'
                ? 'text-red-400 bg-red-950/50 border-red-900'
                : 'text-green-400 bg-green-950/40 border-green-900'
            }`}
          >
            {message.text}
          </p>
        )}

        <button onClick={onClose} className="mt-5 w-full bg-gray-800 hover:bg-gray-700 py-2 rounded transition">
          {info?.hasApiKey || !firstRun ? 'Close' : 'Skip for now'}
        </button>
      </div>
    </div>
  );
}
