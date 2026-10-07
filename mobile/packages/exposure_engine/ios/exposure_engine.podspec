Pod::Spec.new do |s|
  s.name = 'exposure_engine'
  s.version = '0.1.0'
  s.summary = 'Exposure native Metal rendering bridge.'
  s.homepage = 'https://github.com/nathanaellbc/DICHROIC'
  s.license = { :type => 'GPL-3.0-or-later', :file => '../../../../LICENSE' }
  s.author = { 'Exposure' => 'https://github.com/nathanaellbc' }
  s.source = { :path => '.' }
  s.source_files = 'exposure_engine/Sources/exposure_engine/**/*.swift'
  s.vendored_frameworks = 'exposure_engine/Frameworks/ExposureNative.xcframework'
  s.resource_bundles = { 'ExposureHost' => ['exposure_engine/Resources/renderer.js', 'exposure_engine/Resources/data', 'exposure_engine/Resources/luts'] }
  s.dependency 'Flutter'
  s.dependency 'onnxruntime-objc', '1.30.0'
  s.platform = :ios, '16.0'
  s.swift_version = '5.9'
  s.static_framework = true
  s.frameworks = 'Metal', 'QuartzCore', 'CoreGraphics', 'Foundation', 'Accelerate', 'JavaScriptCore'
  s.libraries = 'c++'
end
