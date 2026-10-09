// scripts/bundle-server.cjs
//
// Packs the server and the built web app into one file you can copy to a headless Raspberry Pi (or any
// Linux box with Node 22.13+): release/retro-cable-tv-server.tar.gz
//
//   npm run bundle:server
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');
const stageParent = path.join(releaseDir, 'server-bundle');
const stage = path.join(stageParent, 'retro-cable-tv');
const output = path.join(releaseDir, 'retro-cable-tv-server.tar.gz');

if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('There is no dist/ folder yet. Run: npm run build');
  process.exit(1);
}

// start clean
fs.rmSync(stageParent, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const skip = (src) => !/\.(db|db-wal|db-shm|map)$/.test(src); // never ship a database or source maps
fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: skip });
fs.cpSync(path.join(root, 'server'), path.join(stage, 'server'), { recursive: true, filter: skip });
fs.copyFileSync(path.join(root, 'server.cjs'), path.join(stage, 'server.cjs'));

// the install files; shell scripts get Unix line endings even if they were edited on Windows
fs.mkdirSync(path.join(stage, 'deploy', 'pi'), { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'deploy', 'pi'))) {
  const text = fs.readFileSync(path.join(root, 'deploy', 'pi', name), 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(stage, 'deploy', 'pi', name), text);
}

// a package.json with only what the server needs (all plain JavaScript, so nothing has to be compiled on the Pi)
const needed = ['express', 'axios', 'bcryptjs', 'dotenv'];
const dependencies = {};
for (const name of needed) {
  const version = (rootPkg.dependencies || {})[name];
  if (!version) {
    console.error(`"${name}" is missing from your package.json dependencies. Run: npm install ${name}`);
    process.exit(1);
  }
  dependencies[name] = version;
}
fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'retro-cable-tv-server',
      version: rootPkg.version || '1.0.0',
      private: true,
      main: 'server.cjs',
      engines: { node: '>=22.13' },
      dependencies,
    },
    null,
    2
  ) + '\n'
);

execFileSync('tar', ['-czf', output, '-C', stageParent, 'retro-cable-tv'], { stdio: 'inherit' });
fs.rmSync(stageParent, { recursive: true, force: true });

const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\nCreated ${path.relative(root, output)} (${mb} MB)\n`);
console.log('Copy it to the Pi and install:');
console.log('  scp release/retro-cable-tv-server.tar.gz pi@raspberrypi.local:~');
console.log('  ssh pi@raspberrypi.local');
console.log('  tar -xzf retro-cable-tv-server.tar.gz && cd retro-cable-tv');
console.log('  sudo bash deploy/pi/install.sh');
