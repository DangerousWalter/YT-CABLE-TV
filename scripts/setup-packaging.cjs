// scripts/setup-packaging.cjs
//
// One-time helper: adds what the packaging needs to your package.json (the "main" file, the scripts, a
// description/author), and removes the stray "dotnet" package. Your original is saved as package.json.bak.
// Safe to run again.
//
//   node scripts/setup-packaging.cjs
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const before = JSON.stringify(pkg);
const notes = [];

// --- basics electron-builder wants ---
if (pkg.main !== 'electron/main.cjs') {
  pkg.main = 'electron/main.cjs';
  notes.push('set "main" to electron/main.cjs');
}
if (!pkg.version) {
  pkg.version = '1.0.0';
  notes.push('set "version" to 1.0.0');
}
if (!pkg.description) {
  pkg.description = 'Retro-Cable TV: your YouTube subscriptions as a vintage cable lineup';
  notes.push('added a description');
}
if (!pkg.author) {
  pkg.author = 'Retro-Cable TV';
  notes.push('added an author');
}

// --- scripts (existing ones with the same name are left alone) ---
const wanted = {
  dev: 'vite',
  build: 'vite build',
  server: 'node server.cjs',
  'start:web': 'npm run build && node server.cjs',
  desktop: 'npm run build && electron .',
  'dist:win': 'npm run build && electron-builder --win',
  'dist:mac': 'npm run build && electron-builder --mac',
  'bundle:server': 'npm run build && node scripts/bundle-server.cjs',
};
pkg.scripts = pkg.scripts || {};
for (const [name, cmd] of Object.entries(wanted)) {
  if (!pkg.scripts[name]) {
    pkg.scripts[name] = cmd;
    notes.push(`added script "${name}"`);
  } else if (pkg.scripts[name] !== cmd) {
    notes.push(`kept your existing script "${name}": ${pkg.scripts[name]}`);
  }
}

// --- the stray "dotnet" package (almost certainly a typo for dotenv; nothing uses it) ---
for (const section of ['dependencies', 'devDependencies']) {
  if (pkg[section] && pkg[section].dotnet) {
    delete pkg[section].dotnet;
    notes.push(`removed "dotnet" from ${section}`);
  }
}

// --- things the server needs at run time ---
const deps = pkg.dependencies || {};
const missing = ['express', 'axios', 'bcryptjs', 'dotenv'].filter((name) => !deps[name]);

if (JSON.stringify(pkg) !== before) {
  fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log('Updated package.json (the original is saved as package.json.bak):');
} else {
  console.log('package.json already has everything.');
}
notes.forEach((n) => console.log('  - ' + n));

if (missing.length) {
  console.log(`\nStill missing from "dependencies": ${missing.join(', ')}\n  Run: npm install ${missing.join(' ')}`);
}
console.log('\nNext:\n  npm install --save-dev electron electron-builder\n  (then see PACKAGING.md)');
