# Native Tokenelo mark assets

These assets reuse the exact square mark from the owned public banner at public commit `0499020dcba673a0a3b42f3bcd9798aa73f4dd17`. Shapes and mint/navy colors are preserved; `source-binding.json` pins the source.

The renderer recipe creates the 1024 PNG, Linux 512 PNG, Windows ICO and a standard ten-file `generated/tokenelo-macos.iconset`. The Electron renderer does **not** write ICNS bytes. macOS ICNS comes only from the pinned Apple `iconutil` artifact in `native/tokenelo-macos.icns`, generated from those exact ten PNG inputs and tied to `native/native-iconutil-binding.json`.

The prior custom writer marked a 64×64 PNG as ICNS `icp6`; on macOS native decoding surfaced that entry as 48×48. V2 uses the standard iconset filenames (including `icon_32x32@2x.png` for 64×64), and native `iconutil` roundtrip returned all ten expected names and dimensions. The current V2 ICNS is SHA-256 `3a63e6d4676d395c0ea52eef888f7f39a1961954b9392a698bf9138329a9534c`.

`generate-icons.py` fails closed if any iconset input hash differs from the reviewed native binding or if the pinned ICNS hash changes. When the artwork or raster frames change, regenerate the standard iconset, run `/usr/bin/iconutil -c icns -o <output.icns> <input.iconset>` on macOS, roundtrip with `/usr/bin/iconutil -c iconset -o <roundtrip.iconset> <output.icns>`, verify all ten filenames/dimensions, and update the binding only after review. The binding records that native roundtrip PNG bytes may be re-encoded; its check is names and dimensions, not independent decoded-pixel parity. To refresh the artifact, copy the reviewed native output into `native/tokenelo-macos.icns`, update `native/native-iconutil-binding.json`, and update `EXPECTED_NATIVE_ICNS_SHA256` plus `EXPECTED_NATIVE_BINDING_SHA256` in `generate-icons.py` together, only after native review.

The Windows ICO was validated through the OS without showing a window; Linux and macOS outputs have format-level checks. This does not qualify a native package, install, signing, Finder/Dock display or installed behavior. The tray gauge remains separate and retains macOS template behavior.

App Builder's elevation helper remains disabled under the existing per-user/no-elevation contract. Windows build version and copyright are explicit inputs; `buildNumber: '0'` pins both file and product version resources independently of CI build-number environment variables. The native build controller may still clear those environment inputs as defense in depth. No `afterSign` hook is enabled.

These assets are build preparation; installers and signed builds are not published.
