// src/components/ImportSubscriptions.jsx
//
// Import your YouTube subscriptions from a Google Takeout subscriptions.csv:
//   pick file -> review & choose -> import (server syncs, shows progress) -> summary
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Upload, RefreshCw } from 'lucide-react';
import { parseSubscriptions } from '../lib/subscriptionsCsv';

const MANY_CHANNELS_WARNING = 30;

export default function ImportSubscriptions({ profile, apiBase, onClose, onChanged }) {
  const [step, setStep] = useState('pick'); // pick | review | running | done
  const [subs, setSubs] = useState([]);
  const [ignored, setIgnored] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('separate'); // separate | group
  const [groupName, setGroupName] = useState('Subscriptions');
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [starting, setStarting] = useState(false);

  // Always call the latest onChanged without restarting the polling effect
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // ---- 1. pick the file ----
  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setError('');
    try {
      const { subs: parsed, ignored: skippedRows } = parseSubscriptions(await file.text());
      if (parsed.length === 0) {
        setError("I couldn't find any YouTube channels in that file. Is it the subscriptions.csv from Google Takeout?");
        return;
      }
      setSubs(parsed);
      setIgnored(skippedRows);
      setSelected(new Set(parsed.map((s) => s.id)));
      setFilter('');
      setStep('review');
    } catch (err) {
      console.error(err);
      setError('Could not read that file.');
    }
  };

  // ---- 2. review ----
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? subs.filter((s) => s.title.toLowerCase().includes(q)) : subs;
  }, [subs, filter]);

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setVisible = (checked) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visible) {
        if (checked) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });

  // ---- 3. start + poll ----
  const startImport = async () => {
    if (starting || selected.size === 0) return;
    setStarting(true);
    setError('');
    try {
      const res = await fetch(`${apiBase}/import/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_id: profile.id,
          mode,
          group_name: groupName.trim() || 'Subscriptions',
          subscriptions: subs.filter((s) => selected.has(s.id)),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || `Something went wrong (HTTP ${res.status}).`);
        return;
      }
      setJob(null);
      setJobId(body.jobId);
      setStep('running');
    } catch (err) {
      console.error(err);
      setError('Could not reach the server.');
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (step !== 'running' || !jobId) return undefined;
    let stopped = false;

    const tick = async () => {
      try {
        const res = await fetch(`${apiBase}/import/${jobId}`);
        if (stopped) return;
        if (res.status === 404) {
          setError('The import was lost (did the server restart?). Check your lineup, then try again.');
          setStep('review');
          return;
        }
        const data = await res.json();
        if (stopped) return;
        setJob(data);
        if (data.status === 'done' || data.status === 'error') {
          setStep('done');
          onChangedRef.current?.();
        }
      } catch {
        /* network blip: the next tick retries */
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step, jobId, apiBase]);

  const inputClass =
    'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-yellow-500';
  const canClose = step !== 'running';

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-2xl p-6 relative max-h-[90vh] overflow-y-auto">
        {canClose && (
          <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white" title="Close">
            <X className="w-5 h-5" />
          </button>
        )}

        <h3 className="text-xl font-bold text-yellow-400 mb-1">Import YouTube Subscriptions</h3>

        {/* ---------- pick ---------- */}
        {step === 'pick' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              YouTube only shares your subscription list through a Google Takeout export. It takes a couple of minutes:
            </p>
            <ol className="text-sm text-gray-400 list-decimal list-inside space-y-1">
              <li>
                Open <span className="text-yellow-300">takeout.google.com</span> and click “Deselect all”.
              </li>
              <li>Tick “YouTube and YouTube Music”, then “All YouTube data included” and keep only “subscriptions”.</li>
              <li>Create the export, download the zip, and unzip it.</li>
              <li>
                Upload <span className="font-mono text-gray-300">subscriptions.csv</span> (it's inside the
                “YouTube and YouTube Music” → “subscriptions” folder).
              </li>
            </ol>
            <p className="text-xs text-gray-500">The exact wording of Google's screens may differ slightly.</p>

            <label className="flex items-center justify-center space-x-2 border-2 border-dashed border-gray-600 hover:border-yellow-500 rounded-lg py-8 cursor-pointer text-gray-300 hover:text-yellow-300 transition">
              <Upload className="w-5 h-5" />
              <span>Choose subscriptions.csv</span>
              <input type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
            </label>
          </div>
        )}

        {/* ---------- review ---------- */}
        {step === 'review' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              Found <span className="text-yellow-300 font-bold">{subs.length}</span> subscriptions
              {ignored > 0 ? ` (${ignored} unusable rows ignored)` : ''}. Untick any you don't want on TV.
            </p>

            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name..."
                className={`${inputClass} flex-1`}
              />
              <button type="button" onClick={() => setVisible(true)} className="px-3 py-2 text-xs bg-gray-800 hover:bg-gray-700 rounded">
                Select shown
              </button>
              <button type="button" onClick={() => setVisible(false)} className="px-3 py-2 text-xs bg-gray-800 hover:bg-gray-700 rounded">
                Clear shown
              </button>
            </div>

            <div className="max-h-56 overflow-y-auto space-y-0.5 border border-gray-800 rounded p-2">
              {visible.length === 0 && <p className="text-sm text-gray-500 px-2 py-1">No matches.</p>}
              {visible.map((s) => (
                <label
                  key={s.id}
                  className={`flex items-center space-x-3 px-2 py-1 rounded cursor-pointer text-sm ${
                    selected.has(s.id) ? 'bg-blue-700/40' : 'hover:bg-gray-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="accent-yellow-500"
                  />
                  <span className="truncate">{s.title}</span>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-bold text-gray-400">HOW SHOULD THEY APPEAR?</p>
              <label className="flex items-start space-x-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'separate'}
                  onChange={() => setMode('separate')}
                  className="mt-1 accent-yellow-500"
                />
                <span>
                  Each as its own channel
                  <span className="block text-xs text-gray-500">Numbered after your existing channels, A to Z.</span>
                </span>
              </label>
              <label className="flex items-start space-x-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'group'}
                  onChange={() => setMode('group')}
                  className="mt-1 accent-yellow-500"
                />
                <span>
                  Mix them all into one channel
                  <span className="block text-xs text-gray-500">
                    A single channel playing a shuffle of everything (groups of up to 100 if you picked more).
                  </span>
                </span>
              </label>
              {mode === 'group' && (
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Channel name"
                  className={inputClass}
                />
              )}
              {mode === 'separate' && selected.size > MANY_CHANNELS_WARNING && (
                <p className="text-xs text-yellow-300 bg-yellow-950/40 border border-yellow-900 rounded px-3 py-2">
                  That's {selected.size} new channels in your lineup. You may prefer to untick some, or mix them into one
                  channel (you can always split it up later).
                </p>
              )}
            </div>

            {error && <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2">{error}</p>}

            <div className="flex space-x-3">
              <button type="button" onClick={() => setStep('pick')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded transition">
                Back
              </button>
              <button
                type="button"
                onClick={startImport}
                disabled={starting || selected.size === 0}
                className="flex-1 bg-yellow-500 hover:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2 rounded transition"
              >
                {starting ? 'Starting...' : selected.size === 0 ? 'Select at least 1 channel' : `Import ${selected.size} channel${selected.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}

        {/* ---------- running ---------- */}
        {step === 'running' && (
          <div className="space-y-4 py-4">
            <div className="flex items-center space-x-2 text-gray-300">
              <RefreshCw className="animate-spin w-4 h-4" />
              <span>
                {job?.status === 'saving' ? 'Adding channels to your lineup...' : 'Checking channels and downloading their video lists...'}
              </span>
            </div>
            <div className="h-3 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full bg-yellow-500 transition-all"
                style={{ width: `${job && job.total ? Math.round((job.done / job.total) * 100) : 0}%` }}
              />
            </div>
            <p className="text-xs text-gray-500">
              {job ? `${job.done} of ${job.total} checked` : 'Starting...'}. Keep this window open.
            </p>
          </div>
        )}

        {/* ---------- done ---------- */}
        {step === 'done' && job && (
          <div className="space-y-4">
            {job.status === 'error' ? (
              <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2">
                The import stopped with an error: {job.error || 'unknown error'}
              </p>
            ) : (
              <p className="text-gray-200">
                ✓ Added <span className="text-yellow-300 font-bold">{job.created.length}</span> channel
                {job.created.length === 1 ? '' : 's'} to your lineup
                {job.created.length > 0 && job.created[0].sources > 1
                  ? ` (${job.created.map((c) => `${c.name}: ${c.sources} sources`).join(', ')})`
                  : ''}
                .
              </p>
            )}

            {job.skipped.length > 0 && (
              <p className="text-sm text-gray-400">{job.skipped.length} already in your lineup, so they were skipped.</p>
            )}

            {job.failed.length > 0 && (
              <div>
                <p className="text-sm text-yellow-300 mb-1">⚠ {job.failed.length} couldn't be added:</p>
                <div className="max-h-40 overflow-y-auto text-xs text-gray-400 border border-gray-800 rounded p-2 space-y-0.5">
                  {job.failed.map((f, i) => (
                    <p key={i}>
                      <span className="text-gray-300">{f.title}</span> — {f.reason}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <button onClick={onClose} className="w-full bg-yellow-500 hover:bg-yellow-600 text-black font-bold py-2 rounded transition">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
