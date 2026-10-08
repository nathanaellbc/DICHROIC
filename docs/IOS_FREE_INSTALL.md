# Install DICHROIC on iPhone from Windows

Use the current validated Codemagic build's `DICHROIC-unsigned.ipa`. Download
its artifact from the build overview; a simulator app cannot run on an iPhone.
The app is unsigned, so personal signing is required before installation.

## Sideloadly

The user chose the free Windows route. [Sideloadly's official instructions](https://sideloadly.io/)
confirm free Apple Accounts, IPA installation and seven-day signing with
optional automatic refresh. Its Windows installer requires the web versions
of iTunes and iCloud, rather than the Microsoft Store editions.

1. Install the required Apple components and Sideloadly from the official site.
2. Connect and unlock the iPhone, select Trust if prompted, and select the
   device in Sideloadly.
3. Drop `DICHROIC-unsigned.ipa` into Sideloadly. Enter your Apple Account
   credentials yourself in that application and start personal signing.
4. Follow the Trust and Developer Mode prompts shown on the phone.
5. Open DICHROIC. Free signatures expire after seven days; configure refresh
   in Sideloadly if desired and confirm the device remains discoverable.

Cloud compilation does not require your Apple Account credentials, a paid
membership, App Store Connect, or TestFlight. Installation on the user's
physical iPhone has not been verified from this Windows workspace.

## Physical-device acceptance

Use the actual 8144 × 5424 JPEG and 5120 × 7168 ARW. Check Files and Photos
imports, slider updates, changing film format, lens depth/focus dragging,
full-resolution zoom, repeated large exports and app background/resume. Remove
an object, Apply, compare Before, then Undo/Redo. Before must retain the object
from the original import. Confirm exported resolution, profile and metadata.

A simulator run proves the native path executes, not iPhone peak memory,
latency or display gamut equivalence. The native UIKit compositor retains
profiled sRGB/Display P3 previews; exports retain the selected output ICC profile.
See [the build evidence and remaining parity checks](IOS_PORT_HANDOFF.md).

## If a Mac becomes available

Apple permits a [Personal Team in Xcode](https://developer.apple.com/support/compare-memberships/)
with a free account. Build native libraries and the host before opening Xcode:

```sh
rustup default 1.85.0
bash mobile/scripts/build_native.sh
bash mobile/scripts/build_raw.sh
bash mobile/scripts/prepare_ios.sh
open mobile/ios/Runner.xcworkspace
```

Flutter 3.44.0, Rust, CMake and Xcode are required. Select the Personal Team,
connect the iPhone, and Run. `IOS_BUNDLE_ID` can override the generated ID.
