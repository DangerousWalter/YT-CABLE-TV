// src/components/TvProfilePicker.jsx
//
// "Who's watching?" for TV mode: big tiles you move around with the remote's arrows and choose with OK.
import React, { useEffect, useState } from 'react';
import { tvActionForKey } from '../lib/tv';

export default function TvProfilePicker({ profiles, activeId, onPick, onClose }) {
  const [index, setIndex] = useState(() => Math.max(0, profiles.findIndex((p) => p.id === activeId)));
  const columns = Math.max(1, Math.min(4, profiles.length));

  useEffect(() => {
    const onKey = (e) => {
      const action = tvActionForKey(e);
      if (action === 'right') setIndex((i) => Math.min(profiles.length - 1, i + 1));
      else if (action === 'left') setIndex((i) => Math.max(0, i - 1));
      else if (action === 'down') setIndex((i) => Math.min(profiles.length - 1, i + columns));
      else if (action === 'up') setIndex((i) => Math.max(0, i - columns));
      else if (action === 'ok') onPick(profiles[index]);
      else if (action === 'back' && onClose) onClose();
      else return;
      e.preventDefault();
      e.stopPropagation(); // nothing else should react to these key presses while the picker is open
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [profiles, index, columns, onPick, onClose]);

  return (
    <div className="fixed inset-0 bg-black/95 flex flex-col items-center justify-center z-[60] p-8">
      <h2 className="text-4xl font-bold text-yellow-400 mb-2">Who's watching?</h2>
      <p className="text-gray-400 mb-10 text-lg">Use the arrows and press OK{onClose ? ' (Back to cancel)' : ''}</p>

      <div className="grid gap-6" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {profiles.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            onMouseEnter={() => setIndex(i)}
            className={`flex flex-col items-center rounded-2xl px-10 py-8 border-4 transition ${
              i === index ? 'border-yellow-400 bg-gray-800 scale-110' : 'border-gray-800 bg-gray-900'
            }`}
          >
            <span className="text-7xl mb-3">{p.avatar}</span>
            <span className="text-2xl font-bold text-white">{p.name}</span>
            {p.has_pin && <span className="text-sm text-gray-400 mt-1">🔒 PIN</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
