# DICHROIC for iPhone and iPad (Swift)

A native SwiftUI app. The editor UI copies the web app 1:1. Its photographic
logic is the web app's own code, not a re-implementation:

- **`Sources/DichroicEngine`**: JavaScriptCore runs `renderer.js`, which is the
  web planner, tool rules, scopes and Remove/lens host (`src/native`). The
  unchanged WGSL runs on Metal through the Rust `native/` crate. Decoding uses
  LibRaw (RAW) and ImageIO. On-device LaMa and Depth Anything run on ONNX Runtime.
- **`Sources/Dichroic`**: SwiftUI screens, ported from `src/ui`:
  - start page;
  - toolbar and stock capsule;
  - tool panel, tool strip and group tabs;
  - Film & Paper sheet;
  - export sheet (formats, quality, long edge, LUT);
  - photo viewport (pinch/double-tap zoom, compare, hold to peek, focus pin,
    full-resolution detail);
  - full-screen viewer;
  - Remove Object;
  - scopes, toast and keyboard shortcuts.

Tool values, ranges, resets and switches come from `controls`/`patch` in the
web model (`src/ui/model/tools.ts`), so new web tools appear on iOS without
any Swift changes.

## Generated inputs (not in git)

| Path | How |
| --- | --- |
| `Sources/DichroicEngine/Resources/` | `node ios/scripts/build_host.mjs` (any OS) |
| `Frameworks/DichroicNative.xcframework` | `bash ios/scripts/build_native.sh && bash ios/scripts/build_raw.sh` (macOS), **or** download the `dichroic-native-xcframework` artifact from the *Native iOS build* GitHub workflow |

Run `build_host.mjs` again after changing the web engine, shaders, tools or
profiles.

## Build and install from Windows with xtool (WSL)

[xtool](https://github.com/xtool-org/xtool) builds SwiftPM apps for iOS on
Linux and signs them with your Apple Account. With a free account, the app
expires after 7 days; run `xtool dev` again to refresh it.

1. **WSL distro** (PowerShell, once):

   ```powershell
   wsl --install -d Ubuntu-24.04
   ```

2. **Swift for Linux** (in Ubuntu):

   ```bash
   curl -O https://download.swift.org/swiftly/linux/swiftly-$(uname -m).tar.gz
   tar zxf swiftly-$(uname -m).tar.gz && ./swiftly init
   ```

3. **xtool**: download `xtool-x86_64.AppImage` from the
   [releases](https://github.com/xtool-org/xtool/releases), then:

   ```bash
   chmod +x xtool-x86_64.AppImage && mkdir -p ~/.local/bin
   mv xtool-x86_64.AppImage ~/.local/bin/xtool
   sudo apt install -y libfuse2 usbmuxd
   ```

4. **Darwin SDK and Apple Account**: download `Xcode.xip` from
   [developer.apple.com/download](https://developer.apple.com/download/all/?q=xcode)
   with your Apple Account, then run `xtool setup` and follow its prompts
   (path to `Xcode.xip`, sign in).

5. **iPhone over USB**: in PowerShell as administrator:

   ```powershell
   winget install usbipd
   usbipd list
   usbipd bind --busid <BUSID>
   usbipd attach --wsl --busid <BUSID>
   ```

   On the phone, unlock it and tap Trust. Enable Developer Mode when iOS asks.

6. **Build and install**: clone the repository inside WSL (building on
   `/mnt/f` works but is slow). Put the two generated inputs in place, then:

   ```bash
   cd DICHROIC/ios
   xtool dev
   ```

### Notes from the first setup (2026-10-14)

- Use **xtool 1.22.2 or newer**. Older versions fail to log in with
  `-80045` (Apple now refuses Mac client-info; fixed in xtool #337).
- Login: `wsl -d Ubuntu-24.04 -u root -- /root/.local/bin/xtool auth login`,
  choose `1` (password, free Apple ID), then the 2FA code.
- SDK: `xtool sdk install /mnt/c/Users/<you>/Downloads/Xcode_<ver>.xip`.
- From Git Bash, prefix WSL commands with `MSYS_NO_PATHCONV=1` (otherwise
  `/root/...` is rewritten to a Windows path) and call xtool by full path.
- If `usbipd attach` says the device is busy (Windows' Apple service holds
  it), run `usbipd bind --force --busid <BUSID>` as admin, replug the phone,
  then attach again. Keep a WSL window open while attaching.

### Continuing on another machine

`git clone`, then put the two generated inputs back:

```bash
npm ci
node ios/scripts/build_host.mjs
gh run download --repo nathanaellbc/DICHROIC --name dichroic-native-xcframework --dir ios/Frameworks/DichroicNative.xcframework
```

(The xcframework is the artifact of the latest green *Native iOS build*
run; `gh run download` picks the newest one.)

## Xcode (macOS)

Open `ios/Package.swift` in Xcode and run the `Dichroic` scheme.
