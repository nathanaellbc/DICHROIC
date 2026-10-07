//! Replays canonical host descriptors captured on Dawn, comparing each GPU
//! readback at the established 1e-5 absolute tolerance. No iOS UI is involved.
use exposure_native::gpu_graph::GraphGpu;
use serde_json::Value;
use std::{fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(std::env::args().nth(1).ok_or("Pass a trace directory")?);
    let trace: Vec<Value> = serde_json::from_slice(&fs::read(directory.join("trace.json"))?)?;
    let mut gpu = pollster::block_on(GraphGpu::new(384 * 1024 * 1024))?;
    let mut readbacks = 0;
    let mut maximum = 0f32;
    let mut failures = 0usize;
    for event in trace {
        match event["kind"].as_str().ok_or("Missing event kind")? {
            "command" => {
                let result = gpu.command(&event["value"])?;
                if event["value"]["op"] != "limits" && result != event["result"] {
                    return Err(format!("Resource identity diverged: {result} != {}", event["result"]).into());
                }
            }
            "upload" => gpu.write(event["id"].as_u64().ok_or("id")?, event["offset"].as_u64().ok_or("offset")?,
                &fs::read(directory.join(event["file"].as_str().ok_or("file")?))?)?,
            "read" => {
                let expected = fs::read(directory.join(event["file"].as_str().ok_or("file")?))?;
                let mut actual = vec![0u8; expected.len()];
                gpu.read(event["id"].as_u64().ok_or("id")?, event["offset"].as_u64().ok_or("offset")?, &mut actual)?;
                if std::env::var_os("DICHROIC_REPLAY_DUMP").is_some() {
                    fs::write(directory.join(format!("{}.native.bin", readbacks)), &actual)?;
                }
                let mut readback_maximum = 0f32;
                let mut raw_maximum = 0f32;
                for (index, (a, b)) in actual.chunks_exact(4).zip(expected.chunks_exact(4)).enumerate() {
                    let a = f32::from_le_bytes(a.try_into()?);
                    let b = f32::from_le_bytes(b.try_into()?);
                    let raw_error = (a - b).abs();
                    // PNG/TIFF/native texture storage is unsigned. Compare
                    // precisely the representable image domain, using the
                    // unchanged 1e-5 tolerance. Density/log-exposure taps stay
                    // unclipped. Report raw out-of-gamut differences as well.
                    let error = if event["domain"] == "encoded-image" {
                        (a.clamp(0.0, 1.0) - b.clamp(0.0, 1.0)).abs()
                    } else { raw_error };
                    if !a.is_finite() || !b.is_finite() {
                        return Err(format!("Readback {readbacks}, float {index}: native {a}, Dawn {b}, error {error}").into());
                    }
                    if error > 1e-5 { failures += 1; }
                    raw_maximum = raw_maximum.max(raw_error);
                    readback_maximum = readback_maximum.max(error);
                    maximum = maximum.max(error);
                }
                println!("Readback {readbacks} {}: maximum absolute error {readback_maximum}; raw {raw_maximum}", event["label"]);
                readbacks += 1;
            }
            _ => return Err("Unknown replay event".into()),
        }
    }
    let limits = gpu.command(&serde_json::json!({"op":"limits"}))?;
    if limits["allocatedBytes"] != 0 { return Err(format!("Leaked GPU allocations: {limits}").into()); }
    if failures > 0 { return Err(format!("{failures} floats exceed 1e-5; maximum absolute error {maximum}").into()); }
    println!("{readbacks} canonical readbacks match Dawn; maximum absolute error {maximum}; all GPU allocations released.");
    Ok(())
}
