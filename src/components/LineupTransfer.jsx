// src/components/LineupTransfer.jsx
//
// "Share my lineup": save this profile's channels (and groupings and theme) to a small file, or load a
// lineup file somebody else made. The file never contains an API key, PINs or profiles.
import React, { useRef, useState } from 'react';

export default function LineupTransfer({ profile, apiBase, onChanged }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ kind: '', text: '' });
  const [pending, setPending] = useState(null); // a parsed file waiting for the person to confirm
  const [applyTheme, setApplyTheme] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total }
  const [result, setResult] = useState(null);

  const fail = (text) => setMessage({ kind: 'error', text });

  const exportLineup = async () => {
    setBusy(true);
    setMessage({ kind: '', text: '' });
    try {
      const res = await fetch(`${apiBase}/profiles/${profile.id}/lineup`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'retro-cable-tv-lineup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setMessage({ kind: 'ok', text: `✓ Saved ${data.channels.length} channels to retro-cable-tv-lineup.json` });
    } catch {
      fail('Could not export the lineup.');
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setResult(null);
    setMessage({ kind: '', text: '' });
    if (file.size > 1.5 * 1024 * 1024) return fail('That file is too big to be a lineup.');
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'retro-cable-tv-lineup' || !Array.isArray(data.channels)) throw new Error();
      setPending(data);
      setApplyTheme(false);
    } catch {
      fail("That doesn't look like a Retro-Cable TV lineup file.");
    }
  };

  const startImport = async () => {
    setBusy(true);
    setMessage({ kind: '', text: '' });
    try {
      const res = await fetch(`${apiBase}/profiles/${profile.id}/lineup/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineup: pending, applyTheme }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(body.error || `Something went wrong (HTTP ${res.status}).`);
        setBusy(false);
        return;
      }
      setPending(null);
      setProgress({ done: 0, total: body.total });
      // poll until the server finishes
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const poll = await fetch(`${apiBase}/import/${body.jobId}`);
        const job = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(job.error || 'Lost track of the import.');
        setProgress({ done: job.done, total: job.total });
        if (job.status === 'done') {
          setResult(job);
          onChanged?.();
          break;
        }
        if (job.status === 'error') throw new Error(job.error || 'The import failed.');
      }
    } catch (err) {
      fail(err.message || 'The import failed.');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  const secondary = 'px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded';
  const sourceCount = pending ? new Set(pending.channels.flatMap((c) => (c.sources || []).map((s) => s.id))).size : 0;

  return (
    <section className="mt-6 pt-4 border-t border-gray-800 space-y-2">
      <p className="text-xs font-bold text-gray-400">SHARE A LINEUP</p>
      <p className="text-xs text-gray-500">
        Save “{profile.name}”'s channels and groupings to a file, or load one from a friend. It contains no API key
        or PINs.
      </p>

      <div className="flex flex-wrap gap-2">
        <button onClick={exportLineup} disabled={busy} className={secondary}>
          Export my lineup
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={secondary}>
          Import a lineup...
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={pickFile} className="hidden" />
      </div>

      {pending && (
        <div className="bg-gray-800 rounded px-3 py-3 text-sm space-y-2">
          <p>
            Add <b>{pending.channels.length}</b> channels ({sourceCount} YouTube channels) to “{profile.name}”?
          </p>
          <p className="text-xs text-gray-400">
            Channels you already have are skipped. Loading videos uses a little of your YouTube quota and can take a
            few minutes for a big lineup.
          </p>
          {pending.theme?.preset && (
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={applyTheme}
                onChange={(e) => setApplyTheme(e.target.checked)}
                className="accent-yellow-500"
              />
              Also use this lineup's theme ({pending.theme.preset})
            </label>
          )}
          <div className="flex gap-2">
            <button
              onClick={startImport}
              disabled={busy}
              className="px-4 py-1.5 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 text-black font-bold rounded"
            >
              Import
            </button>
            <button onClick={() => setPending(null)} className={secondary}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {progress && (
        <div className="text-sm">
          <p className="text-gray-300 mb-1">
            Loading channels... {progress.done} of {progress.total}
          </p>
          <div className="h-2 bg-gray-800 rounded overflow-hidden">
            <div
              className="h-full bg-yellow-500 transition-all"
              style={{ width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}

      {result && (
        <div className="text-sm text-green-400 bg-green-950/40 border border-green-900 rounded px-3 py-2">
          <p>
            ✓ Added {result.created.length} channels
            {result.skipped.length > 0 && `, skipped ${result.skipped.length} you already had`}.
          </p>
          {result.failed.length > 0 && (
            <details className="text-yellow-300 mt-1">
              <summary className="cursor-pointer">{result.failed.length} couldn't be loaded</summary>
              <ul className="text-xs mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                {result.failed.map((f, i) => (
                  <li key={i}>
                    {f.title}: {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {message.text && (
        <p
          className={`text-sm rounded px-3 py-2 border ${
            message.kind === 'error'
              ? 'text-red-400 bg-red-950/50 border-red-900'
              : 'text-green-400 bg-green-950/40 border-green-900'
          }`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
