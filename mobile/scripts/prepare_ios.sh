#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f ios/Runner.xcodeproj/project.pbxproj ]; then
  flutter create --platforms=ios --project-name=exposure_ios --org=com.nathanaellbc --empty --no-pub .
fi
python3 - <<'PY'
import plistlib
from pathlib import Path
path = Path('ios/Runner/Info.plist')
with path.open('rb') as stream:
    info = plistlib.load(stream)
info['CFBundleDisplayName'] = 'Exposure'
info['NSPhotoLibraryUsageDescription'] = 'Choose a photo to edit in Exposure.'
info['NSCameraUsageDescription'] = 'Capture a photo to edit in Exposure.'
with path.open('wb') as stream:
    plistlib.dump(info, stream, fmt=plistlib.FMT_XML, sort_keys=False)
project = Path('ios/Runner.xcodeproj/project.pbxproj')
source = project.read_text()
import re
source = re.sub(r'IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;', source)
project.write_text(source)
PY
flutter pub get
