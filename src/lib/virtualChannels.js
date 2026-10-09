// src/lib/virtualChannels.js
//
// Channels that live in the app itself instead of in your database: no YouTube sources,
// can't be edited or deleted. They're added to every profile's lineup.

// CH 0: the scrolling "Channel Guide" with smooth jazz in the background
export const GUIDE_CHANNEL = {
  id: 'virtual:guide',
  virtual: 'guide',
  number: 0,
  name: 'Channel Guide',
  category: 'Special',
  sources: [],
  blurb: 'Channel Guide',
  subtitle: 'Listings and smooth jazz · all hours',
  schedule: null,
};

// The old-school "no channel" color bars
export const BARS_CHANNEL = {
  id: 'virtual:bars',
  virtual: 'bars',
  name: 'Test Pattern',
  category: 'Special',
  sources: [],
  blurb: 'Please Stand By',
  subtitle: 'Color bars and test tone · all hours',
  schedule: null,
};

// The Channel Guide is CH 0, then your channels, then the test pattern at CH 99 (or one past
// your highest channel number if you somehow have that many).
export function withVirtualChannels(realChannels) {
  const highest = realChannels.reduce((max, c) => Math.max(max, c.number), 0);
  return [GUIDE_CHANNEL, ...realChannels, { ...BARS_CHANNEL, number: Math.max(99, highest + 1) }];
}
