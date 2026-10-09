# Retro-Cable TV

Turn your YouTube subscriptions into a live cable lineup. Every subscription (or group of them) becomes a channel that is
"always on": tune in and the show is already in progress, just like real TV. There is a program guide, channel
surfing with the number keys, profiles with PINs, themes, TV sound effects, and a couple of virtual channels (CH 0 is the
channel guide, CH 99 is color bars).

It runs as a Windows or Mac app, as a small server on a Raspberry Pi, or on a Samsung TV (through the Pi).

> Retro-Cable TV is not affiliated with or endorsed by YouTube or Google. Videos play in YouTube's own embedded player.
> You use your own YouTube Data API key and are responsible for following the
> [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service).

## Download

Get the latest files from the [Releases page](../../releases/latest).

| You have | Download |
|---|---|
| Windows | `Retro-Cable-TV-Setup-<version>.exe` |
| Mac with Apple Silicon (M1 or later) | the `.dmg` with `arm64` in its name |
| Mac with an Intel chip | the other `.dmg` |
| Raspberry Pi 4 | `retro-cable-tv-server.tar.gz` (see [PACKAGING.md](PACKAGING.md), section 5) |

The installers are not code-signed, so your computer will warn you the first time:

- **Windows:** on the blue "Windows protected your PC" screen, click **More info**, then **Run anyway**.
- **Mac:** right-click the app, choose **Open**, then click **Open**. If macOS says the app is "damaged", run
  `xattr -cr "/Applications/Retro-Cable TV.app"` in Terminal and try again.

## First run

1. You need a free **YouTube Data API key**. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project, enable **YouTube Data API v3**, and create an **API key** under Credentials. The key stays on your computer.
2. Open the app and paste the key into the welcome window.
3. Build your lineup: import your subscriptions, or load a lineup file a friend shared with you
   (**Settings > Share a lineup > Import a lineup**). Importing a lineup file does not copy anyone's profiles, PINs or API key.

## Remote and keyboard

| Key | What it does |
|---|---|
| Up / Down | change channel |
| Left / Right | volume down / up |
| Number keys (then Enter) | jump to a channel |
| `M` | mute |
| `F` | full screen |
| `G` | show or hide the program guide |
| `I` | channel info |
| `P` | power off |

On a Samsung TV remote: Red mutes, Green toggles full screen and the guide, Yellow switches profile, Blue opens the
channel guide, and the number pad jumps to a channel.

## Run from source

Needs Node.js 22.13 or newer.

```
npm install
cp .env.example .env     # add your YOUTUBE_API_KEY
npm run server           # terminal 1
npm run dev              # terminal 2, then open http://localhost:5173
```

Other commands:

| Command | What it does |
|---|---|
| `npm run desktop` | build and open the desktop app in a window |
| `npm run dist:win` / `npm run dist:mac` | build the installers (each on its own operating system) |
| `npm run bundle:server` | build the Raspberry Pi server bundle |

The full guide to the installers, the Raspberry Pi server and the Samsung TV launcher is in [PACKAGING.md](PACKAGING.md).

## Making a release (maintainers)

Pushing a version tag builds the Windows, Mac and Pi files on GitHub and attaches them to a new release:

```
npm version patch        # or minor / major; bumps package.json and creates the tag
git push --follow-tags
```

## Privacy

Your channels, profiles and PIN hashes are stored only on your own computer or Pi. The app talks to YouTube and
nothing else. Never share your `.db` files or your `.env`; share a lineup file instead.

## License

[MIT](LICENSE)
