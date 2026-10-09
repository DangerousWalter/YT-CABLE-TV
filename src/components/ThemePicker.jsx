// src/components/ThemePicker.jsx
//
// Pick a theme preset and, optionally, your own accent color. Changes preview live
// and are saved to the current profile.
import React from 'react';
import { X } from 'lucide-react';
import { THEME_LIST, getSwatches, normalizeTheme } from '../lib/themes';

function SwatchPreview({ preset }) {
  const sw = getSwatches({ preset });
  return (
    <div className="rounded overflow-hidden border border-white/10" style={{ background: sw.bg }}>
      <div className="p-2 space-y-1.5">
        <div className="h-3 rounded-sm w-1/3" style={{ background: sw.accent }} />
        <div className="flex gap-1.5">
          <div className="h-5 rounded-sm flex-1" style={{ background: sw.select }} />
          <div className="h-5 rounded-sm flex-1" style={{ background: sw.surface }} />
          <div className="h-5 rounded-sm flex-1" style={{ background: sw.surface }} />
        </div>
        <div className="h-5 rounded-sm" style={{ background: sw.surface }} />
      </div>
    </div>
  );
}

export default function ThemePicker({ theme, profileName, onChange, onClose }) {
  const current = normalizeTheme(theme);
  // The color input needs a value even when no custom accent is set: show the preset's own accent
  const accentValue = current.accent || getSwatches({ preset: current.preset }).accent;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-yellow-500 rounded-lg w-full max-w-lg p-6 relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-white" title="Close">
          <X className="w-5 h-5" />
        </button>

        <h3 className="text-xl font-bold text-yellow-400">Theme</h3>
        <p className="text-xs text-gray-400 mb-4">Saved for {profileName}. Every profile can have its own look.</p>

        <div className="grid grid-cols-2 gap-3">
          {THEME_LIST.map((t) => {
            const selected = current.preset === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onChange({ ...current, preset: t.id })}
                className={`text-left rounded-lg p-2 border transition ${
                  selected ? 'border-yellow-500 bg-gray-800 ring-1 ring-yellow-500' : 'border-gray-700 hover:border-gray-500 hover:bg-gray-800'
                }`}
              >
                <SwatchPreview preset={t.id} />
                <p className="mt-2 text-sm font-bold text-gray-100">
                  {t.label}
                  {selected && <span className="ml-2 text-xs text-yellow-400 font-normal">✓ in use</span>}
                </p>
                <p className="text-xs text-gray-400 leading-snug">{t.blurb}</p>
              </button>
            );
          })}
        </div>

        <div className="mt-5 border-t border-gray-800 pt-4">
          <p className="text-xs font-bold text-gray-400 mb-2">ACCENT COLOR</p>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={accentValue}
              onChange={(e) => onChange({ ...current, accent: e.target.value })}
              className="w-12 h-9 rounded cursor-pointer bg-transparent border border-gray-700"
              aria-label="Accent color"
            />
            <span className="font-mono text-sm text-gray-300">{current.accent ? current.accent : 'from the theme'}</span>
            <button
              type="button"
              onClick={() => onChange({ ...current, accent: null })}
              disabled={!current.accent}
              className="ml-auto px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed rounded transition"
            >
              Use the theme's accent
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Changes the highlight color on any theme. Very dark colors are lightened a little so button text stays readable.
          </p>
        </div>
      </div>
    </div>
  );
}
