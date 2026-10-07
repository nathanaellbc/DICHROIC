use std::{env, fs, path::PathBuf};

fn main() {
    // Derive the shared layout from its existing source of truth. Never duplicate
    // CoreParams manually: a reordered web field must also reorder native bytes.
    let path = "../src/engine/params.ts";
    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rerun-if-changed=../src/shaders/curveDevelop.wgsl");
    let source = fs::read_to_string(path).expect("canonical web parameter layout");
    let fields = source.split("const FIELDS = [").nth(1).expect("FIELDS declaration")
        .split("] as const").next().unwrap();
    let mut wgsl = String::from("struct CoreParams {\n");
    let mut offsets = String::new();
    let mut count = 0;
    for line in fields.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let parts: Vec<_> = line.split('\'').collect();
        assert_eq!(parts.len(), 5, "Unexpected canonical field syntax: {line}");
        let name = parts[1];
        let kind = parts[3];
        assert!(matches!(kind, "u32" | "i32" | "f32"));
        wgsl.push_str(&format!("  {name}: {kind},\n"));
        offsets.push_str(&format!("pub const {}: usize = {};\n", name.to_uppercase(), count * 4));
        count += 1;
    }
    assert!(count > 0);
    wgsl.push('}');
    offsets.push_str(&format!("pub const BYTES: usize = {};\n", (count * 4 + 15) / 16 * 16));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("core_params.wgsl"), wgsl).unwrap();
    fs::write(out.join("core_offsets.rs"), offsets).unwrap();
}
