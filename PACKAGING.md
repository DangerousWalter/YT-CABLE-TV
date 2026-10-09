# Packaging Retro-Cable TV

| Where | What you get | Built on |
|---|---|---|
| Windows laptop | an installer (`Retro-Cable TV Setup 1.0.0.exe`) | the Windows laptop |
| Mac laptop | disk images (`.dmg`), one for Apple Silicon and one for Intel | the Mac |
| Raspberry Pi 4 (headless) | a background service that your TVs, phones and laptops connect to | a tarball made on either laptop, installed on the Pi |
| Samsung TV | a small launcher app that opens your Pi (or laptop) full screen; or just the TV's web browser | the `tizen/` folder, packaged with Samsung's Tizen Studio (section 7) |

The desktop app and the Pi service run the **same server and the same interface**. Each has its own copy of your
channels and settings.

---

## 1. One-time setup (on each laptop)

1. Replace these files in your project with the new versions: `server.cjs`, `server/db.cjs`, `vite.config.js`,
   `src/App.jsx`, `src/components/ChannelGuideScreen.jsx`, `src/components/SettingsModal.jsx`, and `src/index.css`.
   Add the new folders and files: `electron/`, `scripts/`, `deploy/`, `build/icon.png`,
   `electron-builder.yml` and `PACKAGING.md`.
2. Update your `package.json` automatically (it saves your original as `package.json.bak`):
   ```
   node scripts/setup-packaging.cjs
   ```
3. Install everything:
   ```
   npm install
   npm install --save-dev electron electron-builder
   ```
   If the script says some libraries are missing (for example `dotenv`), install them as it tells you.
4. Try it in a window:
   ```
   npm run desktop
   ```
   The first time, a welcome window asks for your **YouTube API key** (the Settings dialog has a short how-to).
   The key stays on that computer.

Normal development still works: `npm run server` in one terminal, `npm run dev` in another, then open
http://localhost:5173.

## 2. Windows installer

On the Windows laptop:
```
npm run dist:win
```
The installer appears in `release/`. Run it. Windows will say "Windows protected your PC" because the installer isn't
signed: click **More info**, then **Run anyway**.

If the build stops with *"Cannot create symbolic link"*, turn on **Developer Mode** in Windows Settings (or open the
terminal as Administrator) and run it again.

## 3. Mac disk images

On the Mac:
```
npm run dist:mac
```
`release/` gets two `.dmg` files: `...-arm64.dmg` for Apple Silicon (M1 and newer) and the other one for Intel Macs.
Open the right one and drag the app into Applications.

The app isn't signed or notarized (that needs a paid Apple developer account), so the first launch may be blocked:
right-click the app and choose **Open**, then confirm. Or go to System Settings, then Privacy & Security, then
**Open Anyway**. If a copy that you moved from another computer says it's "damaged", run:
```
xattr -cr "/Applications/Retro-Cable TV.app"
```

## 4. Where the desktop app keeps your data

| System | Folder |
|---|---|
| Windows | `%APPDATA%\Retro-Cable TV` |
| macOS | `~/Library/Application Support/Retro-Cable TV` |

It holds `yt_cable_tv.db` (channels, profiles, themes) and `settings.json` (your YouTube key).

To bring your existing channels into the desktop app, quit the app, copy your project's `yt_cable_tv.db` into that
folder, and start the app again.

---

## 5. Raspberry Pi 4 as a headless server

Use **Raspberry Pi OS Lite (64-bit)**. It needs no monitor: you manage it over SSH. A wired network connection and a
good power supply make it much happier.

### Step 1: install Node.js 22 (once, on the Pi)
The version in the Pi's default package list is too old. Install a current one for the whole system:
```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # should print v22.13 or higher
```
(If NodeSource has changed that address, follow the Linux instructions on nodejs.org instead. Don't use `nvm` for
this: the service can't run a Node that lives in your home folder.)

### Step 2: make the bundle (on a laptop, in the project folder)
```
npm run bundle:server
```
This creates `release/retro-cable-tv-server.tar.gz`.

### Step 3: copy it to the Pi and install
```
scp release/retro-cable-tv-server.tar.gz pi@raspberrypi.local:~
ssh pi@raspberrypi.local
tar -xzf retro-cable-tv-server.tar.gz && cd retro-cable-tv
sudo bash deploy/pi/install.sh
```
(Use your own user name and the Pi's name or address instead of `pi@raspberrypi.local`.)

The installer creates a locked-down service user, copies the program to `/opt/retro-cable-tv`, starts the service,
makes it start at every boot, and prints the addresses to use, like `http://192.168.1.50:3001`.

### Step 4: give it your YouTube API key
There are two ways. Use either one.

**A. Through the app (easiest).** On your laptop, open a tunnel to the Pi:
```
ssh -L 3001:localhost:3001 pi@raspberrypi.local
```
Leave that window open, then browse to **http://localhost:3001** on the laptop. The Pi sees this as coming from
itself, so the welcome/Settings dialog lets you paste the key. (Settings can only be changed from the Pi itself or
through a tunnel like this, so a TV or phone on your network can't change them.)

**B. In the settings file.** On the Pi:
```
sudo nano /etc/retro-cable-tv.env     # remove the # in front of YOUTUBE_API_KEY and paste your key
sudo systemctl restart retro-cable-tv
```

### Step 5: use it
From any laptop, phone or TV browser on your network, open `http://<the Pi's address>:3001`
(or `http://raspberrypi.local:3001`, which works on most home networks).

### Moving your existing channels onto the Pi
```
sudo systemctl stop retro-cable-tv
sudo cp yt_cable_tv.db /var/lib/retro-cable-tv/
sudo chown retrotv:retrotv /var/lib/retro-cable-tv/yt_cable_tv.db
sudo systemctl start retro-cable-tv
```

### Everyday commands
| | |
|---|---|
| Status | `systemctl status retro-cable-tv` |
| Live log | `journalctl -u retro-cable-tv -f` |
| Restart | `sudo systemctl restart retro-cable-tv` |
| Update | make a new bundle (step 2), copy and extract it, run `sudo bash deploy/pi/install.sh` again. Your data and settings are kept |
| Back up | `sudo cp /var/lib/retro-cable-tv/yt_cable_tv.db ~/retro-backup.db` |
| Remove | `sudo bash deploy/pi/uninstall.sh` (add `--purge` to delete your data too) |

### Good to know
- **Keep it on your home network only.** Anyone on the network can use Retro-Cable TV. Profile PINs keep people out of a
  profile inside the app, but they aren't strong security. Don't forward a port to it from the internet.
- **Firewall.** If `ufw` is on, the installer prints the one command to allow your home network in.
- **Port.** Change `PORT=` in `/etc/retro-cable-tv.env` if 3001 is taken, then restart.
- **Turning off network access** (the Pi only): set `RETROTV_LAN=0` in the same file.

---

## 6. Troubleshooting

- **A TV or phone can't reach the Pi.** Check that it's on the same Wi-Fi or network (guest networks often block this),
  that the address is right, and that a firewall isn't in the way. From a laptop on the network, test with
  `http://<address>:3001`.
- **"No YouTube API key is set."** Open Settings (the gear icon) on the computer running Retro-Cable TV, or see step 4.
- **Videos show an error inside the desktop app but work in a browser.** Tell me which error code it shows. YouTube
  decides what it allows to be embedded, and I can't test the installed apps from here.
- **The desktop app won't start.** Run it from a terminal with `npm run desktop` to see the message.

## 7. Samsung TV

The TV never runs Retro-Cable TV itself. The program lives on your Pi (or a laptop running the desktop app with
"Let other devices connect" switched on in Settings), and the TV just shows it. That also means one place to update,
and the same channels on every screen.

**Manage your channels from a computer or phone, not the TV.** Importing your YouTube subscriptions, adding, grouping
and deleting channels, profiles and themes all happen by opening the server's address in a laptop or phone browser.
The TV shows the address in its guide as a reminder.

### Step 1: give the Pi a fixed address
Names like `raspberrypi.local` often don't work on TVs, so use the Pi's numeric address (like `192.168.1.50`). Make sure
it never changes: in your router's settings, find "DHCP reservation" (or "static lease" or "address reservation") and
reserve the Pi's current address for it.

### Step 2: run the TV check (5 minutes, no installing)
1. On the TV, open the **Internet** (web browser) app.
2. Go to `http://<the Pi's address>:3001/tv-check`, for example `http://192.168.1.50:3001/tv-check`.
3. Leave it open for about 30 seconds, then press a few remote buttons (arrows, OK, Back, color buttons, CH+/-).
4. Send me what the page shows (a photo of the "Short report" at the bottom is perfect).

It tells us the TV's browser version, whether the app's styling will work on it, how fast it is, whether YouTube plays,
and the exact codes the remote sends. **If it says "Styling: NOT supported", the app will need a compatibility build
for the TV** before the steps below are worth doing. Samsung's own documentation puts your TV's browser at Chromium
94 (or 108 if it was updated), and the styling tool the app is built with expects something newer, so I'd like to see the
real result first.

### Step 3: the easy way (no sideloading)
If the check page looks good, you can already use the app: in the TV's Internet app, open
`http://<the Pi's address>:3001/` and bookmark it. TV mode switches on by itself for TV browsers.

### Step 4: the app way (a launcher on the TV's home screen)
Needs a Windows or Mac computer, a free Samsung developer account, and a Samsung certificate that includes your TV's
ID. Samsung has retired Tizen Studio; the supported tool is now the **Tizen Extension for Visual Studio Code**
(publisher "Tizen"; not the older "tizentv" extension, which can only make plain Tizen certificates). This is the
route that worked on a QN85QN800C (Tizen 8/9).

1. **Turn on Developer Mode on the TV.** On a remote without a number pad, open **Settings, then App settings**, and
   type **1 2 3 4 5** there (on remotes with number keys it's on the Apps screen). Switch Developer Mode on, enter the
   **IP address of the computer you'll install from** (double-check it: a wrong address means the computer never sees
   the TV), and restart the TV.
2. **Install VS Code and the "Tizen Extension"** (publisher Tizen). It downloads its own SDK packages the first time;
   let that finish before doing anything else. If you also have the old "tizentv" extension, disable it.
3. **Check the connection.** In a terminal: `sdb connect <TV address>` then `sdb devices`; the TV should be listed.
   (The `sdb` tool is in the extension's SDK folder, or `C:\tizen-studio\tools` if you installed the CLI SDK.)
4. **Make a certificate.** Click the Tizen (pinwheel) icon in VS Code's left bar. Under **Baseline Tools** open
   **Certificate Manager** (or use **Create Certificate**), choose **Samsung** (not Tizen), fill in the author
   details, pick the privilege level (Public), **tick your TV's DUID**, then sign in to your Samsung account.
   If no DUID is offered, the TV isn't connected: fix step 1 or 3 first.
5. **Open the project.** File, Open Folder, choose this repository's `tizen/` folder. In the Tizen sidebar, under
   **Active Targets**, make sure Project, Device (your TV) and Certificate are all filled in; click a line to select.
6. **Install it.** Under **Actions**, click **Build Project**, then **Run Project**. ("No device selected" in the Tizen
   Log means the Device line is empty.) Reading errors: in VS Code's Output panel, choose the Tizen entries in the dropdown.
7. **Start it** from the TV's apps list ("Retro-Cable TV"). The first time, type the server's address with the
   on-screen keyboard (for example `192.168.1.50:3001`) and press **Done**, or press Down then OK on Connect. It
   remembers the address after that. Press left or right during the 3-second countdown on later launches to change it.

If a path in VS Code's settings.json contains backslashes, double them (`C:\\Program Files\\...`) or use forward slashes.

Command-line version of steps 5 and 6, if you prefer it (names depend on your setup):
```
sdb connect <TV address>
tizen package -t wgt -s <your certificate profile name> -- tizen
tizen install -n tizen/RetroCableTV.wgt -t <your TV's name in the device list>
```

Samsung developer certificates expire, so every so often you may need to make a new one and reinstall.

### Using it with the remote
On slim remotes with no number or color buttons (like the Samsung Smart Control), press the **123** button: the TV shows an
on-screen number pad with a row of colored buttons, and they work like the real keys.

| Button | What it does |
|---|---|
| Any button (first time) | Powers the "TV" on (this is also what lets the browser play sound) |
| Up / Down arrows | Channel up / down |
| CH+ / CH- | Channel up / down |
| 0 to 9 | Type a channel number (0 is the Channel Guide), then wait a moment or press OK |
| OK | Show or hide the program guide |
| Left / Right arrows | Volume inside the app (the TV's own volume buttons work too) |
| Red | Mute |
| Green | Show or hide the guide |
| Yellow | Who's watching? (switch profile) |
| Blue | Jump to CH 0, the Channel Guide |
| Back | Hide the guide; press again within 3 seconds to exit |

### If something goes wrong
- **"Can't reach ..."** The TV can't see the server. Check it's on, on the same network (not a guest Wi-Fi), and that
  the address is right. Check from a laptop on the same network.
- **"The app did not start."** The server answered but the page didn't run on the TV. Open `/tv-check` in the TV's
  browser and send me the report.
- **Black or unstyled screen.** The styling isn't supported on this TV's browser (see step 2).
- **No sound until a button is pressed.** Normal: browsers need a button press before they allow sound.

## 8. What's not covered

- **Roku.** Roku apps can't run web apps or play YouTube. Use screen mirroring from a laptop or phone, or plug a
  computer into the TV's HDMI port and open the address in a full-screen browser.
- **A Linux desktop app.** Not built, since the Pi runs headless. It can be added if you ever want a desktop version.
