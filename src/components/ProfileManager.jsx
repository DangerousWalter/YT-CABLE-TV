// src/components/ProfileManager.jsx
//
// Add, edit and delete family profiles (name, emoji avatar, optional PIN).
import React, { useState } from 'react';
import { X, Pencil, Trash2, PlusCircle } from 'lucide-react';

const AVATARS = ['👨‍💼', '👩‍💻', '🎮', '🧒', '👧', '👦', '👴', '👵', '🐶', '🐱', '🚀', '📺', '🎸', '⚽', '🍿', '🦄'];
const EMPTY_FORM = { name: '', avatar: '📺', pin: '', currentPin: '', removePin: false };
const PIN_RE = /^\d{4,8}$/;

export default function ProfileManager({ profiles, currentProfileId, apiBase, onClose, onChanged }) {
  const [view, setView] = useState('list'); // list | form | delete
  const [editing, setEditing] = useState(null); // profile being edited (null = adding)
  const [form, setForm] = useState(EMPTY_FORM);
  const [target, setTarget] = useState(null); // profile being deleted
  const [deletePin, setDeletePin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const inputClass =
    'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-yellow-500';
  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const backToList = () => {
    setView('list');
    setError('');
  };

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError('');
    setView('form');
  };

  const openEdit = (p) => {
    setEditing(p);
    setForm({ ...EMPTY_FORM, name: p.name, avatar: p.avatar });
    setError('');
    setView('form');
  };

  const openDelete = (p) => {
    setTarget(p);
    setDeletePin('');
    setError('');
    setView('delete');
  };

  // Sends the request; returns true on success, otherwise shows the server's message
  const send = async (url, method, payload) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Something went wrong (HTTP ${res.status}).`);
        return false;
      }
      await onChanged();
      return true;
    } catch (err) {
      console.error(err);
      setError('Could not reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (form.pin && !PIN_RE.test(form.pin)) {
      setError('A PIN must be 4-8 digits.');
      return;
    }

    const payload = { name: form.name, avatar: form.avatar };
    if (editing) {
      if (editing.has_pin) payload.current_pin = form.currentPin;
      if (form.removePin) payload.pin_code = null;
      else if (form.pin) payload.pin_code = form.pin;
    } else if (form.pin) {
      payload.pin_code = form.pin;
    }

    const ok = await send(editing ? `${apiBase}/profiles/${editing.id}` : `${apiBase}/profiles`, editing ? 'PUT' : 'POST', payload);
    if (ok) backToList();
  };

  const handleDelete = async () => {
    if (busy || !target) return;
    const ok = await send(`${apiBase}/profiles/${target.id}`, 'DELETE', { pin: deletePin });
    if (ok) backToList();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-md p-6 relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} disabled={busy} className="absolute top-4 right-4 text-gray-400 hover:text-white" title="Close">
          <X className="w-5 h-5" />
        </button>

        {/* ---------- list ---------- */}
        {view === 'list' && (
          <div className="space-y-4">
            <h3 className="text-xl font-bold text-yellow-400">Profiles</h3>

            <div className="space-y-1">
              {profiles.map((p) => (
                <div key={p.id} className="flex items-center space-x-3 bg-gray-800 rounded px-3 py-2">
                  <span className="text-2xl">{p.avatar}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">
                      {p.name}
                      {p.has_pin && <span className="ml-2" title="PIN protected">🔒</span>}
                      {p.id === currentProfileId && <span className="ml-2 text-xs text-yellow-300 font-normal">watching now</span>}
                    </p>
                    <p className="text-xs text-gray-400">
                      {p.channel_count} channel{p.channel_count === 1 ? '' : 's'}
                    </p>
                  </div>
                  <button onClick={() => openEdit(p)} title="Edit profile" className="p-1.5 rounded hover:bg-black/40">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => openDelete(p)}
                    disabled={profiles.length <= 1}
                    title={profiles.length <= 1 ? "You can't delete the last profile" : 'Delete profile'}
                    className="p-1.5 rounded hover:bg-black/40 hover:text-red-400 disabled:opacity-30 disabled:hover:text-inherit disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={openAdd}
              className="w-full flex items-center justify-center space-x-2 bg-yellow-500 hover:bg-yellow-600 text-black font-bold py-2 rounded transition"
            >
              <PlusCircle className="w-4 h-4" />
              <span>Add Profile</span>
            </button>
          </div>
        )}

        {/* ---------- add / edit ---------- */}
        {view === 'form' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <h3 className="text-xl font-bold text-yellow-400">{editing ? `Edit ${editing.name}` : 'Add Profile'}</h3>

            <div>
              <label className="block text-xs font-bold text-gray-400 mb-1">NAME</label>
              <input type="text" maxLength={30} value={form.name} onChange={setField('name')} className={inputClass} required autoFocus />
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-400 mb-1">AVATAR</label>
              <div className="flex flex-wrap gap-1 mb-2">
                {AVATARS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, avatar: a }))}
                    className={`text-xl w-9 h-9 rounded transition ${
                      form.avatar === a ? 'bg-yellow-500/30 ring-1 ring-yellow-400' : 'bg-gray-800 hover:bg-gray-700'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={form.avatar}
                onChange={setField('avatar')}
                placeholder="...or type any emoji"
                className={inputClass}
              />
            </div>

            {editing?.has_pin && (
              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1">CURRENT PIN (required to make changes)</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  autoComplete="off"
                  value={form.currentPin}
                  onChange={(e) => setForm((f) => ({ ...f, currentPin: e.target.value.replace(/\D/g, '') }))}
                  className={inputClass}
                  required
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-400 mb-1">
                {editing?.has_pin ? 'NEW PIN (leave blank to keep the current one)' : 'PIN (optional, 4-8 digits)'}
              </label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                autoComplete="new-password"
                value={form.pin}
                onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, ''), removePin: false }))}
                disabled={form.removePin}
                className={`${inputClass} disabled:opacity-40`}
              />
              {editing?.has_pin && (
                <label className="flex items-center space-x-2 mt-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.removePin}
                    onChange={(e) => setForm((f) => ({ ...f, removePin: e.target.checked, pin: '' }))}
                    className="accent-yellow-500"
                  />
                  <span>Remove this profile's PIN</span>
                </label>
              )}
              <p className="text-xs text-gray-500 mt-1">
                A PIN keeps kids out of a profile in this app. It isn't strong security.
              </p>
            </div>

            {error && <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2">{error}</p>}

            <div className="flex space-x-3">
              <button type="button" onClick={backToList} disabled={busy} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded transition">
                Back
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex-1 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-60 text-black font-bold py-2 rounded transition"
              >
                {busy ? 'Saving...' : editing ? 'Save Changes' : 'Add Profile'}
              </button>
            </div>
          </form>
        )}

        {/* ---------- delete ---------- */}
        {view === 'delete' && target && (
          <div className="space-y-4">
            <h3 className="text-xl font-bold text-red-400">Delete {target.avatar} {target.name}?</h3>
            <p className="text-sm text-gray-300">
              This permanently removes the profile
              {target.channel_count > 0
                ? ` and its ${target.channel_count} channel${target.channel_count === 1 ? '' : 's'}`
                : ''}
              . It can't be undone.
            </p>

            {target.has_pin && (
              <div>
                <label className="block text-xs font-bold text-gray-400 mb-1">ENTER THIS PROFILE'S PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  autoComplete="off"
                  autoFocus
                  value={deletePin}
                  onChange={(e) => setDeletePin(e.target.value.replace(/\D/g, ''))}
                  className={inputClass}
                />
              </div>
            )}

            {error && <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2">{error}</p>}

            <div className="flex space-x-3">
              <button onClick={backToList} disabled={busy} className="flex-1 bg-gray-800 hover:bg-gray-700 py-2 rounded transition">
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={busy || (target.has_pin && deletePin.length < 4)}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 font-bold py-2 rounded transition"
              >
                {busy ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
