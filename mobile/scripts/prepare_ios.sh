#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
flutter config --no-enable-swift-package-manager
if [ ! -f ios/Runner.xcodeproj/project.pbxproj ]; then
  flutter create --platforms=ios --project-name=exposure_ios --org=com.nathanaellbc --empty --no-pub .
fi
python3 - <<'PY'
import plistlib
import os
import json
import subprocess
from pathlib import Path
path = Path('ios/Runner/Info.plist')
with path.open('rb') as stream:
    info = plistlib.load(stream)
info['CFBundleDisplayName'] = 'DICHROIC'
info['NSPhotoLibraryUsageDescription'] = 'Choose a photo to edit in DICHROIC.'
info['NSCameraUsageDescription'] = 'Capture a photo to edit in DICHROIC.'
with path.open('wb') as stream:
    plistlib.dump(info, stream, fmt=plistlib.FMT_XML, sort_keys=False)
project = Path('ios/Runner.xcodeproj/project.pbxproj')
source = project.read_text()
import re
source = re.sub(r'IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;', source)
bundle = os.environ.get('IOS_BUNDLE_ID')
if bundle:
    if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', bundle):
        raise ValueError('IOS_BUNDLE_ID must be a reverse-DNS identifier')
    source = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;',
                    lambda match: 'PRODUCT_BUNDLE_IDENTIFIER = ' + bundle +
                    ('.RunnerTests' if 'RunnerTests' in match.group() else '') + ';', source)
project.write_text(source)
# Reuse the shipped DICHROIC icon at every native catalog size.
icons = Path('ios/Runner/Assets.xcassets/AppIcon.appiconset')
catalog = json.loads((icons / 'Contents.json').read_text())
for entry in catalog['images']:
    size = round(float(entry['size'].split('x')[0]) * float(entry['scale'].rstrip('x')))
    filename = entry.get('filename') or f'Dichroic-{size}.png'
    entry['filename'] = filename
    subprocess.run(['sips', '-z', str(size), str(size), '../public/icons/icon-512.png',
                    '--out', str(icons / filename)], check=True, stdout=subprocess.DEVNULL)
(icons / 'Contents.json').write_text(json.dumps(catalog, indent=2))
# Launch screen in Signal Blue, matching the app icon's background.
launch = Path('ios/Runner/Base.lproj/LaunchScreen.storyboard')
launch.write_text(launch.read_text().replace('red="1" green="1" blue="1"', 'red="0" green="0.5686" blue="1"'))
podfile = Path('ios/Podfile')
if podfile.exists():
    pods = podfile.read_text()
    pods = re.sub(r'^\s*#?\s*platform :ios,.*$', "platform :ios, '16.0'", pods, flags=re.M)
    pods = re.sub(r'use_frameworks!(?:\s*:linkage\s*=>\s*:\w+)?', 'use_frameworks! :linkage => :static', pods)
    podfile.write_text(pods)
PY
flutter pub get
