//! File-backed source reads with the web box filter's exact f64 sum order.
//! No full-photo float allocation, color transform, or approximate resize.
use serde_json::Value;

fn integer(v: &Value, name: &str) -> Result<usize, String> {
    v[name].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| format!("Invalid source {name}"))
}

pub fn read(bytes: &[u8], lookup: &[f32], v: &Value, output: &mut [f32]) -> Result<(), String> {
    let sw = integer(v, "sourceWidth")?; let sh = integer(v, "sourceHeight")?;
    let bits = integer(v, "bits")?; let channels = integer(v, "channels")?;
    let offset = integer(v, "byteOffset")?;
    let ow = integer(v, "outWidth")?; let oh = integer(v, "outHeight")?;
    let x = integer(v, "x")?; let y = integer(v, "y")?;
    let w = integer(v, "width")?; let h = integer(v, "height")?;
    let big = v["bigEndian"].as_bool().ok_or("Invalid source byte order")?;
    // Dimensions are bounded before any products or pointer access.
    if [sw, sh, ow, oh, w, h].iter().any(|&n| n == 0 || n > 50_000)
        || sw * sh > 50_000_000 || ow * oh > 50_000_000
        || ![8,16,32].contains(&bits) || ![1,3,4].contains(&channels)
        || (!lookup.is_empty() && (lookup.len() != 65536 || bits != 16))
        || x > ow || y > oh || w > ow - x || h > oh - y
        || w * h * 16 > 32 * 1024 * 1024 || output.len() < w * h * 4 {
        return Err("Invalid bounded source region".into());
    }
    let payload = sw * sh * channels * (bits / 8);
    if offset.checked_add(payload) != Some(bytes.len()) { return Err("Source pixel file is truncated".into()); }
    let sample = |pixel: usize, channel: usize| -> f32 {
        if channel == 3 && channels != 4 { return 1.0; }
        let c = if channels == 1 { 0 } else { channel };
        let i = offset + (pixel * channels + c) * (bits / 8);
        match bits {
            8 => bytes[i] as f32 / 255.0,
            16 => {
                let pair = [bytes[i], bytes[i+1]];
                let code = if big { u16::from_be_bytes(pair) } else { u16::from_le_bytes(pair) };
                if lookup.is_empty() { code as f32 / 65535.0 } else { lookup[code as usize] }
            },
            _ => {
                let word = [bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]];
                f32::from_bits(if big { u32::from_be_bytes(word) } else { u32::from_le_bytes(word) })
            },
        }
    };
    for row in 0..h {
        let ay = (y + row) * sh / oh; let by = (ay + 1).max((y + row + 1) * sh / oh);
        for col in 0..w {
            let ax = (x + col) * sw / ow; let bx = (ax + 1).max((x + col + 1) * sw / ow);
            let mut sums = [0.0f64; 4];
            for yy in ay..by { for xx in ax..bx {
                for c in 0..4 { sums[c] += sample(yy * sw + xx, c) as f64; }
            } }
            let area = ((by - ay) * (bx - ax)) as f64;
            for c in 0..4 { output[(row * w + col) * 4 + c] = (sums[c] / area) as f32; }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_web_fixtures_match_exactly() {
        let fixtures: Value = serde_json::from_str(include_str!("../fixtures/source-box.json")).unwrap();
        for case in fixtures.as_array().unwrap() {
            let bytes: Vec<u8> = case["bytes"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
            let lookup: Vec<f32> = if case["lookup"].as_bool() == Some(true) {
                (0..65536).map(|n| ((n as f64 / 65535.0).powf(2.2)) as f32).collect()
            } else { vec![] };
            let expected: Vec<f32> = case["expected"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap() as f32).collect();
            let mut output = vec![0.0; expected.len()];
            read(&bytes, &lookup, &case["spec"], &mut output).unwrap();
            assert_eq!(output, expected, "{}", case["name"]);
            assert!(read(&bytes[..bytes.len()-1], &lookup, &case["spec"], &mut output).is_err());
        }
    }
}
