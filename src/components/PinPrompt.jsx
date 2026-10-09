// src/components/PinPrompt.jsx
//
// Asks for a profile's PIN before switching to it. This gates the interface only
// (there are no login sessions yet), but the server does rate-limit wrong guesses.
import React, { useState } from 'react';

export default function PinPrompt({ profile, profiles, apiBase, canCancel, onPickProfile, onSuccess, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/profiles/${profile.id}/verify-pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        onSuccess(profile);
        return;
      }
      setError(body.error || 'Incorrect PIN.');
      setPin('');
    } catch (err) {
      console.error(err);
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[60] p-4">
      <form onSubmit={handleSubmit} className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-xs p-6 space-y-4 text-center">
        <div className="text-5xl">{profile.avatar}</div>
        <div>
          <h3 className="text-xl font-bold text-yellow-400">{profile.name}</h3>
          <p className="text-xs text-gray-400 mt-1">🔒 Enter this profile's PIN</p>
        </div>

        {/* Nothing is unlocked yet: let them pick a different profile to unlock */}
        {!canCancel && profiles.length > 1 && (
          <select
            value={profile.id}
            onChange={(e) => {
              const next = profiles.find((p) => p.id === Number(e.target.value));
              if (next) onPickProfile(next);
            }}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.avatar} {p.name}
                {p.has_pin ? ' 🔒' : ''}
              </option>
            ))}
          </select>
        )}

        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="PIN"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-center tracking-[0.5em] text-xl focus:outline-none focus:border-yellow-500"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex space-x-3">
          {canCancel && (
            <button type="button" onClick={onCancel} className="flex-1 bg-gray-800 hover:bg-gray-700 py-2 rounded transition">
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={busy || pin.length < 4}
            className="flex-1 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-bold py-2 rounded transition"
          >
            {busy ? 'Checking...' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>
  );
}
